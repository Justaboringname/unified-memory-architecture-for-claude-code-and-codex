import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";
import type { UMemDB } from "../db/db.ts";
import { nowIso } from "../util/time.ts";
import { sha256, sha256File } from "./hash.ts";
import { classifySensitivity, stripSecrets } from "./redact.ts";
import { upsertSource, getCheckpoint, setCheckpoint, purgeConversation } from "./sources.ts";
import { log } from "../util/log.ts";

const PROVIDER = "claude-code";

export interface CcImportStats {
  claudeMdFiles: number;
  memoryFiles: number;
  sessions: number;
  sessionsSkipped: number;
  sessionMessages: number;
}

// ---- frontmatter (minimal; avoids a YAML dependency) ----
interface Frontmatter {
  name?: string;
  description?: string;
  type?: string;
  body: string;
}
function parseFrontmatter(md: string): Frontmatter {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { body: md };
  const [, fmRaw, body] = m;
  const name = fmRaw!.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = fmRaw!.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  const type = fmRaw!.match(/^\s*type:\s*(.+)$/m)?.[1]?.trim();
  return { name, description, type, body: (body ?? "").trim() };
}

// Claude Code memory type -> unified mem_type
function mapMemType(ccType: string | undefined): string {
  switch ((ccType ?? "").toLowerCase()) {
    case "feedback": return "instruction";
    case "user": return "semantic";
    case "project": return "working";
    case "reference": return "semantic";
    case "decision": return "decision";
    default: return "semantic";
  }
}

/** Import a single CLAUDE.md as an active 'instruction' memory scoped to its dir. */
export function importClaudeMd(db: UMemDB, filePath: string, projectKey: string): boolean {
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, "utf-8");
  const hash = sha256(content);
  const cp = getCheckpoint(db, "claude_md", filePath);
  if (cp && cp.content_hash === hash) return false;
  return db.transaction(() => {
    const sourceId = upsertSource(db, {
      provider: PROVIDER,
      sourceType: "claude_md",
      filePath,
      externalId: projectKey,
      contentHash: hash,
      byteSize: content.length,
      projectKey,
      originTs: statSync(filePath).mtime.toISOString(),
      sensitivity: classifySensitivity(content),
    });
    const title = `CLAUDE.md (${projectKey})`;
    // Credentials must never enter the derived memory layer (ADR-0003). Strip
    // secrets from the copy stored in memory_items; the raw file on disk is
    // untouched and remains the (access-gated) source of record.
    const { text: body, stripped } = stripSecrets(content);
    if (stripped) db.audit({ actor: "import", action: "memory.secret_stripped", entityType: "source", entityId: sourceId, detail: { file: "claude_md", count: stripped } });
    const existing = db.db.prepare("SELECT id FROM memory_items WHERE title=? AND created_by='import'").get(title) as { id: number } | undefined;
    const ts = nowIso();
    const sens = classifySensitivity(body);
    if (existing) {
      db.db.prepare("UPDATE memory_items SET body=?, sensitivity=?, updated_at=?, current_version=current_version+1 WHERE id=?").run(body, sens, ts, existing.id);
      db.db.prepare("DELETE FROM fts_memory WHERE memory_id=?").run(existing.id);
      db.db.prepare("INSERT INTO fts_memory(memory_id,title,body) VALUES (?,?,?)").run(existing.id, title, body);
    } else {
      const info = db.db
        .prepare(
          `INSERT INTO memory_items(mem_type,title,body,scope,scope_ref,confidence,sensitivity,status,source_refs,created_by,current_version,created_at,updated_at,valid_from)
           VALUES ('instruction',?,?,'project',?,0.85,?,'active',?,'import',1,?,?,?)`,
        )
        .run(title, body, projectKey, sens, JSON.stringify([{ source_id: sourceId }]), ts, ts, ts);
      db.db.prepare("INSERT INTO fts_memory(memory_id,title,body) VALUES (?,?,?)").run(Number(info.lastInsertRowid), title, body);
    }
    setCheckpoint(db, "claude_md", filePath, hash, "done", 0);
    return true;
  });
}

/** Import one auto-memory .md file as a typed active memory item. */
export function importMemoryMd(db: UMemDB, filePath: string, projectKey: string): boolean {
  const raw = readFileSync(filePath, "utf-8");
  const fname = basename(filePath);
  if (fname === "MEMORY.md") return false; // index file — recorded as source below, not a memory item
  const fm = parseFrontmatter(raw);
  const hash = sha256(raw);
  const cp = getCheckpoint(db, "memory_md", filePath);
  if (cp && cp.content_hash === hash) return false;
  const title = fm.name ?? fname.replace(/\.md$/, "");
  const rawBody = fm.description ? `${fm.description}\n\n${fm.body}` : fm.body;
  // Strip credentials before they enter the derived memory layer (ADR-0003).
  const { text: body, stripped } = stripSecrets(rawBody);
  const memType = mapMemType(fm.type);
  const sens = classifySensitivity(body);
  return db.transaction(() => {
    if (stripped) db.audit({ actor: "import", action: "memory.secret_stripped", entityType: "source", detail: { file: fname, count: stripped } });
    const sourceId = upsertSource(db, {
      provider: PROVIDER,
      sourceType: "cc_memory",
      filePath,
      externalId: title,
      contentHash: hash,
      byteSize: raw.length,
      projectKey,
      originTs: statSync(filePath).mtime.toISOString(),
      sensitivity: sens,
    });
    const existing = db.db.prepare("SELECT id FROM memory_items WHERE title=? AND scope_ref=? AND created_by='import'").get(title, projectKey) as { id: number } | undefined;
    const ts = nowIso();
    if (existing) {
      db.db.prepare("UPDATE memory_items SET body=?, mem_type=?, sensitivity=?, updated_at=?, current_version=current_version+1 WHERE id=?").run(body, memType, sens, ts, existing.id);
      db.db.prepare("DELETE FROM fts_memory WHERE memory_id=?").run(existing.id);
      db.db.prepare("INSERT INTO fts_memory(memory_id,title,body) VALUES (?,?,?)").run(existing.id, title, body);
    } else {
      const info = db.db
        .prepare(
          `INSERT INTO memory_items(mem_type,title,body,scope,scope_ref,confidence,sensitivity,status,source_refs,created_by,current_version,created_at,updated_at,valid_from)
           VALUES (?,?,?,'project',?,0.8,?,'active',?,'import',1,?,?,?)`,
        )
        .run(memType, title, body, projectKey, sens, JSON.stringify([{ source_id: sourceId, note: `cc auto-memory: ${fname}` }]), ts, ts, ts);
      db.db.prepare("INSERT INTO fts_memory(memory_id,title,body) VALUES (?,?,?)").run(Number(info.lastInsertRowid), title, body);
    }
    setCheckpoint(db, "memory_md", filePath, hash, "done", 0);
    return true;
  });
}

// ---- session jsonl ----
function extractCcText(message: any): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
    return parts.join("\n");
  }
  return "";
}

/** Import one Claude Code session .jsonl as a conversation. Dedup by message.id. */
export async function importSessionJsonl(db: UMemDB, filePath: string, projectKey: string): Promise<{ imported: boolean; nMessages: number }> {
  const hash = await sha256File(filePath);
  const cp = getCheckpoint(db, "session", filePath);
  if (cp && cp.content_hash === hash && cp.status === "done") return { imported: false, nMessages: cp.n_messages };

  // Canonical session identity = the FILENAME (`<sessionId>.jsonl`), which is
  // 1:1 with the file and the checkpoint key. The first-line `o.sessionId` can
  // be a PARENT session's id in a forked/resumed transcript, so using it for
  // purge/identity would delete a different session's conversation (data loss).
  const sessionId = basename(filePath).replace(/\.jsonl$/, "");
  let innerSessionId: string | null = null;

  // Accumulate transcript turns in order. A single logical assistant message is
  // written across multiple lines sharing one message.id, each carrying a
  // DISTINCT content block (thinking/text around tool_use) — so concatenate the
  // distinct text blocks in order rather than keeping only the longest.
  interface Turn { role: string; text: string; uuid: string | null; messageKey: string | null; createdAt: string | null; parentUuid: string | null; seq: number; }
  const turns: Turn[] = [];
  const byKey = new Map<string, number>(); // message.id -> index in turns
  let seq = 0;

  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try { o = JSON.parse(t); } catch { continue; }
    if (o.sessionId && !innerSessionId) innerSessionId = o.sessionId;
    if (o.type !== "user" && o.type !== "assistant") continue;
    const text = extractCcText(o.message);
    if (!text) continue;
    const messageKey: string | null = o.message?.id ?? null;
    if (messageKey && byKey.has(messageKey)) {
      const idx = byKey.get(messageKey)!;
      const existing = turns[idx]!.text;
      // Concatenate distinct content blocks; collapse cumulative-prefix streams
      // in either direction (old⊆new → replace; new⊆old → skip) to avoid dup.
      if (text.includes(existing)) turns[idx]!.text = text;
      else if (!existing.includes(text)) turns[idx]!.text = `${existing}\n${text}`;
      continue;
    }
    const turn: Turn = {
      role: o.type,
      text,
      uuid: o.uuid ?? null,
      messageKey,
      createdAt: o.timestamp ?? null,
      parentUuid: o.parentUuid ?? null,
      seq: seq++,
    };
    if (messageKey) byKey.set(messageKey, turns.length);
    turns.push(turn);
  }
  if (turns.length === 0) {
    setCheckpoint(db, "session", filePath, hash, "done", 0);
    return { imported: false, nMessages: 0 };
  }
  return db.transaction(() => {
    purgeConversation(db, PROVIDER, sessionId);
    let convSensitive = "normal";
    const sourceId = upsertSource(db, {
      provider: PROVIDER,
      sourceType: "cc_session",
      filePath,
      externalId: sessionId,
      contentHash: hash,
      byteSize: statSync(filePath).size,
      projectKey,
      meta: { turns: turns.length, innerSessionId: innerSessionId ?? undefined },
    });
    const convInfo = db.db
      .prepare(`INSERT INTO conversations(source_id,provider,external_uuid,project_key,title,created_at,message_count) VALUES (?,?,?,?,?,?,?)`)
      .run(sourceId, PROVIDER, sessionId, projectKey, `cc session ${sessionId.slice(0, 8)}`, turns[0]!.createdAt, turns.length);
    const convId = Number(convInfo.lastInsertRowid);
    const insMsg = db.db.prepare(
      `INSERT INTO messages(conversation_id,source_id,external_uuid,message_key,role,seq,text,created_at,parent_uuid,char_len,sensitivity)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insFts = db.db.prepare("INSERT INTO fts_messages(message_id,body) VALUES (?,?)");
    for (const tn of turns) {
      const sens = classifySensitivity(tn.text);
      if (sens !== "normal") convSensitive = "sensitive";
      const info = insMsg.run(convId, sourceId, tn.uuid, tn.messageKey, tn.role, tn.seq, tn.text, tn.createdAt, tn.parentUuid, tn.text.length, sens);
      insFts.run(Number(info.lastInsertRowid), tn.text);
    }
    if (convSensitive !== "normal") db.db.prepare("UPDATE sources SET sensitivity='sensitive' WHERE id=?").run(sourceId);
    setCheckpoint(db, "session", filePath, hash, "done", turns.length);
    return { imported: true, nMessages: turns.length };
  });
}

/** Import the whole local Claude Code layer under a ~/.claude home. */
export async function importClaudeCode(
  db: UMemDB,
  claudeHome: string,
  opts: { projects?: string[]; includeSessions?: boolean; maxSessionsPerProject?: number; onProgress?: (n: number) => void } = {},
): Promise<CcImportStats> {
  const stats: CcImportStats = { claudeMdFiles: 0, memoryFiles: 0, sessions: 0, sessionsSkipped: 0, sessionMessages: 0 };

  // 1) Global ~/.claude/CLAUDE.md
  const globalMd = join(claudeHome, "CLAUDE.md");
  if (importClaudeMd(db, globalMd, "~/.claude")) stats.claudeMdFiles++;

  // 2) Per-project memory + sessions
  const projectsDir = join(claudeHome, "projects");
  if (existsSync(projectsDir)) {
    let slugs = readdirSync(projectsDir).filter((d) => statSync(join(projectsDir, d)).isDirectory());
    if (opts.projects && opts.projects.length) slugs = slugs.filter((s) => opts.projects!.includes(s));
    for (const slug of slugs) {
      const pdir = join(projectsDir, slug);
      // memory/*.md
      const memDir = join(pdir, "memory");
      if (existsSync(memDir)) {
        for (const f of readdirSync(memDir).filter((x) => x.endsWith(".md"))) {
          try { if (importMemoryMd(db, join(memDir, f), slug)) stats.memoryFiles++; }
          catch (e) { log.warn("import.memory_md.fail", { file: f, err: String(e) }); }
        }
      }
      // sessions/*.jsonl
      if (opts.includeSessions) {
        let files = readdirSync(pdir).filter((x) => x.endsWith(".jsonl")).map((x) => join(pdir, x));
        files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs); // newest first
        if (opts.maxSessionsPerProject) files = files.slice(0, opts.maxSessionsPerProject);
        let n = 0;
        for (const fp of files) {
          try {
            const r = await importSessionJsonl(db, fp, slug);
            if (r.imported) stats.sessions++;
            else stats.sessionsSkipped++;
            stats.sessionMessages += r.nMessages;
          } catch (e) {
            log.warn("import.session.fail", { file: basename(fp), err: String(e) });
          }
          if (opts.onProgress && ++n % 10 === 0) opts.onProgress(n);
        }
      }
    }
  }
  return stats;
}

/** Discover CLAUDE.md files under given repo roots and import each. */
export function importRepoClaudeMds(db: UMemDB, roots: string[]): number {
  let n = 0;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const key = `repo:${basename(root)}`;
    if (importClaudeMd(db, join(root, "CLAUDE.md"), key)) n++;
  }
  return n;
}
