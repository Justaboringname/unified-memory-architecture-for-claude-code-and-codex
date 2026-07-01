import type { UMemDB } from "../db/db.ts";
import { safePreview } from "../ingest/redact.ts";

export interface SearchScope {
  provider?: string; // 'claude-web' | 'claude-code' | ...
  projectKey?: string; // project slug
  role?: string; // 'human' | 'assistant' | ...
  sourceType?: string; // 'conversation' | 'cc_session' | 'cc_memory' | ...
  taskId?: number; // reserved: scope memory to a task
  kinds?: Array<"message" | "memory">; // which stores to search (default both)
  since?: string; // ISO date lower bound
  until?: string; // ISO date upper bound
}

export interface SearchHit {
  kind: "message" | "memory";
  id: number;
  score: number; // higher = better
  matchType: "fts" | "like";
  title: string;
  preview: string;
  provider: string;
  projectKey: string | null;
  role: string | null;
  sourceType: string | null;
  createdAt: string | null;
  provenance: Record<string, unknown>;
}

const CJK_RE = /[㐀-䶿一-鿿豈-﫿぀-ヿ]+/g;
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "for", "and", "or", "is", "are", "in", "on", "how", "do", "i",
  "should", "what", "why", "when", "with", "this", "that", "it", "be", "can", "my", "me", "you",
  "如何", "怎么", "这个", "还是",
]);

interface Tokens {
  ftsTerms: string[]; // terms >= 3 chars (trigram-matchable)
  likeTerms: string[]; // all significant terms incl. short CJK (for the recall net)
}

/** Split a query into keyword terms: latin words + CJK runs, minus stopwords. */
function tokenize(q: string): Tokens {
  const terms = new Set<string>();
  // latin / numeric words
  for (const w of q.toLowerCase().match(/[a-z0-9][a-z0-9_+.-]*/gi) ?? []) {
    if (w.length >= 2 && !STOPWORDS.has(w)) terms.add(w);
  }
  // CJK runs (kept whole; trigram handles >=3, LIKE handles the rest)
  for (const run of q.match(CJK_RE) ?? []) {
    if (!STOPWORDS.has(run)) terms.add(run);
  }
  const all = [...terms].slice(0, 12);
  return {
    ftsTerms: all.filter((t) => t.length >= 3),
    likeTerms: all,
  };
}

/** Build an FTS5 OR-of-phrases expression (each term quoted; safe against syntax). */
function ftsExpr(terms: string[]): string {
  return terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(" OR ");
}

export function search(db: UMemDB, rawQuery: string, opts: SearchScope = {}, limit = 20): SearchHit[] {
  const q = rawQuery.trim();
  if (!q) return [];
  // Effective kinds. Derived memory is provider-agnostic (scoped by project/task,
  // not raw provider). So a raw-provider scope (e.g. claude-code) returns raw
  // messages only; use provider='memory' or kind=memory to target derived memory.
  let kinds = opts.kinds ?? ["message", "memory"];
  if (opts.provider && !opts.kinds) {
    kinds = opts.provider === "memory" ? ["memory"] : ["message"];
  }
  const tok = tokenize(q);
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const push = (h: SearchHit) => {
    const key = `${h.kind}:${h.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push(h);
  };
  const overFetch = limit * 3;

  // ---- messages ----
  if (kinds.includes("message")) {
    if (tok.ftsTerms.length) {
      const rows = db.db
        .prepare(
          `SELECT m.id AS id, m.role AS role, m.text AS text, m.created_at AS created_at,
                  c.title AS title, c.provider AS provider, c.project_key AS project_key,
                  c.external_uuid AS conv_uuid, m.source_id AS source_id, m.external_uuid AS msg_uuid,
                  bm25(fts_messages) AS rank, s.source_type AS source_type
           FROM fts_messages
           JOIN messages m ON m.id = fts_messages.message_id
           JOIN conversations c ON c.id = m.conversation_id
           JOIN sources s ON s.id = m.source_id
           WHERE fts_messages MATCH ? ${scopeSql(opts, "c", "m", "s")}
           ORDER BY rank LIMIT ?`,
        )
        .all(ftsExpr(tok.ftsTerms), ...scopeParams(opts), overFetch) as any[];
      for (const r of rows) push(msgHit(r, "fts", 1 / (1 + Math.max(0, r.rank))));
    }
    // LIKE recall net — engaged for short/CJK terms or when FTS underfills.
    const likeNeeded = tok.likeTerms.some((t) => t.length < 3) || hits.length < limit;
    if (likeNeeded && tok.likeTerms.length) {
      const { clause, params } = likeClause(tok.likeTerms, "m.text");
      const rows = db.db
        .prepare(
          `SELECT m.id AS id, m.role AS role, m.text AS text, m.created_at AS created_at,
                  c.title AS title, c.provider AS provider, c.project_key AS project_key,
                  c.external_uuid AS conv_uuid, m.source_id AS source_id, m.external_uuid AS msg_uuid,
                  s.source_type AS source_type
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           JOIN sources s ON s.id = m.source_id
           WHERE (${clause}) ${scopeSql(opts, "c", "m", "s")}
           ORDER BY m.created_at DESC LIMIT ?`,
        )
        .all(...params, ...scopeParams(opts), limit) as any[];
      for (const r of rows) push(msgHit(r, "like", 0.4));
    }
  }

  // ---- memory items ----
  if (kinds.includes("memory")) {
    if (tok.ftsTerms.length) {
      const rows = db.db
        .prepare(
          `SELECT mi.id AS id, mi.title AS title, mi.body AS body, mi.mem_type AS mem_type,
                  mi.scope AS scope, mi.scope_ref AS scope_ref, mi.status AS status,
                  mi.confidence AS confidence, mi.sensitivity AS sensitivity,
                  mi.created_at AS created_at, bm25(fts_memory) AS rank
           FROM fts_memory
           JOIN memory_items mi ON mi.id = fts_memory.memory_id
           WHERE fts_memory MATCH ? AND mi.status != 'forgotten' ${memScopeSql(opts)}
           ORDER BY rank LIMIT ?`,
        )
        .all(ftsExpr(tok.ftsTerms), ...memScopeParams(opts), limit) as any[];
      for (const r of rows) push(memHit(r, "fts", 1 / (1 + Math.max(0, r.rank))));
    }
    const likeNeeded = tok.likeTerms.some((t) => t.length < 3) || hits.filter((h) => h.kind === "memory").length < limit;
    if (likeNeeded && tok.likeTerms.length) {
      const t = likeClause(tok.likeTerms, "mi.title");
      const b = likeClause(tok.likeTerms, "mi.body");
      const rows = db.db
        .prepare(
          `SELECT mi.id AS id, mi.title AS title, mi.body AS body, mi.mem_type AS mem_type,
                  mi.scope AS scope, mi.scope_ref AS scope_ref, mi.status AS status,
                  mi.confidence AS confidence, mi.sensitivity AS sensitivity, mi.created_at AS created_at
           FROM memory_items mi
           WHERE ((${t.clause}) OR (${b.clause})) AND mi.status != 'forgotten' ${memScopeSql(opts)}
           ORDER BY mi.updated_at DESC LIMIT ?`,
        )
        .all(...t.params, ...b.params, ...memScopeParams(opts), limit) as any[];
      for (const r of rows) push(memHit(r, "like", 0.4));
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/** Build `(col LIKE ? OR col LIKE ? ...)` with bound params. */
function likeClause(terms: string[], col: string): { clause: string; params: string[] } {
  const parts = terms.map(() => `${col} LIKE ?`);
  return { clause: parts.join(" OR "), params: terms.map((t) => `%${t}%`) };
}

function msgHit(r: any, matchType: "fts" | "like", score: number): SearchHit {
  return {
    kind: "message",
    id: r.id,
    score,
    matchType,
    title: r.title ?? "(untitled)",
    preview: safePreview(r.text, 160),
    provider: r.provider,
    projectKey: r.project_key ?? null,
    role: r.role ?? null,
    sourceType: r.source_type ?? null,
    createdAt: r.created_at ?? null,
    provenance: { source_id: r.source_id, conversation_uuid: r.conv_uuid, message_uuid: r.msg_uuid, message_id: r.id },
  };
}

function memHit(r: any, matchType: "fts" | "like", score: number): SearchHit {
  return {
    kind: "memory",
    id: r.id,
    score: score + 0.15, // slight boost: curated memory over raw messages
    matchType,
    title: r.title,
    preview: r.sensitivity !== "normal" ? `⟪${r.sensitivity} memory — body hidden⟫` : safePreview(r.body, 160),
    provider: "memory",
    projectKey: r.scope === "project" ? r.scope_ref : null,
    role: r.mem_type,
    sourceType: `memory/${r.status}`,
    createdAt: r.created_at ?? null,
    provenance: { memory_id: r.id, mem_type: r.mem_type, confidence: r.confidence, status: r.status },
  };
}

// ---- scope SQL (all values bound; no interpolation of user input) ----
function scopeSql(o: SearchScope, cAlias: string, mAlias: string, sAlias: string): string {
  const parts: string[] = [];
  if (o.provider) parts.push(`AND ${cAlias}.provider = ?`);
  if (o.projectKey) parts.push(`AND ${cAlias}.project_key = ?`);
  if (o.role) parts.push(`AND ${mAlias}.role = ?`);
  if (o.sourceType) parts.push(`AND ${sAlias}.source_type = ?`);
  if (o.since) parts.push(`AND ${mAlias}.created_at >= ?`);
  if (o.until) parts.push(`AND ${mAlias}.created_at <= ?`);
  return parts.join(" ");
}
function scopeParams(o: SearchScope): any[] {
  const p: any[] = [];
  if (o.provider) p.push(o.provider);
  if (o.projectKey) p.push(o.projectKey);
  if (o.role) p.push(o.role);
  if (o.sourceType) p.push(o.sourceType);
  if (o.since) p.push(o.since);
  if (o.until) p.push(o.until);
  return p;
}
// Admit: always global; project(P) when projectKey set; the specific task when
// taskId set. When both are set, a single OR clause covers all three so a
// project filter never hides the requested task's memories (was a bug).
function memScopeSql(o: SearchScope): string {
  if (o.projectKey && o.taskId != null)
    return `AND (mi.scope = 'global' OR (mi.scope = 'project' AND mi.scope_ref = ?) OR (mi.scope = 'task' AND mi.scope_ref = ?))`;
  if (o.projectKey) return `AND (mi.scope = 'global' OR (mi.scope = 'project' AND mi.scope_ref = ?))`;
  if (o.taskId != null) return `AND (mi.scope != 'task' OR mi.scope_ref = ?)`;
  return "";
}
function memScopeParams(o: SearchScope): any[] {
  if (o.projectKey && o.taskId != null) return [o.projectKey, String(o.taskId)];
  if (o.projectKey) return [o.projectKey];
  if (o.taskId != null) return [String(o.taskId)];
  return [];
}
