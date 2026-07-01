import type { UMemDB } from "../db/db.ts";
import { nowIso } from "../util/time.ts";
import { sha256 } from "../ingest/hash.ts";
import { containsSecret, classifySensitivity, scan } from "../ingest/redact.ts";

export type MemType = "instruction" | "semantic" | "decision" | "episodic" | "procedural" | "working";
export type MemScope = "global" | "project" | "task";
export type MemStatus = "proposed" | "active" | "superseded" | "forgotten";
export type Author = "user" | "claude" | "codex" | "import" | "system";

export interface SourceRef {
  source_id?: number;
  message_id?: number;
  note?: string;
}

export interface ProposeInput {
  memType: MemType;
  title: string;
  body: string;
  scope?: MemScope;
  scopeRef?: string | null;
  confidence?: number;
  sourceRefs?: SourceRef[];
  createdBy: Author;
  /** If true and author is trusted (user), create as 'active' immediately. */
  activate?: boolean;
  /** Explicit opt-in to store a PII-flagged item (secrets are ALWAYS blocked). */
  allowSensitive?: boolean;
}

export interface MemoryItem {
  id: number;
  mem_type: MemType;
  title: string;
  body: string;
  scope: MemScope;
  scope_ref: string | null;
  confidence: number;
  sensitivity: string;
  status: MemStatus;
  valid_from: string | null;
  valid_until: string | null;
  source_refs: string | null;
  created_by: Author;
  current_version: number;
  created_at: string;
  updated_at: string;
}

export class SecretRejectedError extends Error {}
export class SensitiveBlockedError extends Error {}

function syncItemFts(db: UMemDB, id: number): void {
  db.db.prepare("DELETE FROM fts_memory WHERE memory_id = ?").run(id);
  const it = db.db
    .prepare("SELECT title, body, status FROM memory_items WHERE id = ?")
    .get(id) as { title: string; body: string; status: string } | undefined;
  if (it && it.status !== "forgotten") {
    db.db
      .prepare("INSERT INTO fts_memory(memory_id, title, body) VALUES (?, ?, ?)")
      .run(id, it.title, it.body);
  }
}

function writeVersion(
  db: UMemDB,
  memoryId: number,
  version: number,
  changeType: string,
  statusAfter: MemStatus,
  title: string,
  body: string,
  confidence: number | null,
  author: Author,
  rationale: string | null,
): void {
  const prev = db.db
    .prepare("SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY version DESC LIMIT 1")
    .get(memoryId) as Record<string, unknown> | undefined;
  const prevHash = prev ? sha256(JSON.stringify(prev)) : null;
  db.db
    .prepare(
      `INSERT INTO memory_versions
        (memory_id, version, change_type, status_after, title, body, confidence, author, rationale, prev_hash, created_at)
       VALUES (@memory_id, @version, @change_type, @status_after, @title, @body, @confidence, @author, @rationale, @prev_hash, @created_at)`,
    )
    .run({
      memory_id: memoryId,
      version,
      change_type: changeType,
      status_after: statusAfter,
      title,
      body,
      confidence,
      author,
      rationale,
      prev_hash: prevHash,
      created_at: nowIso(),
    });
}

/** Propose (or, for the user, optionally activate) a new memory item. */
export function proposeMemory(db: UMemDB, input: ProposeInput): MemoryItem {
  const combined = `${input.title}\n${input.body}`;
  if (containsSecret(combined)) {
    const kinds = scan(combined).secretKinds;
    db.audit({
      actor: input.createdBy,
      action: "memory.reject_secret",
      entityType: "memory",
      detail: { reason: "credential detected", kinds },
    });
    throw new SecretRejectedError(`Refusing to store memory: credential(s) detected (${kinds.join(", ")}).`);
  }
  const sensitivity = classifySensitivity(combined);
  if (sensitivity === "sensitive" && input.scope !== "task" && !input.allowSensitive) {
    throw new SensitiveBlockedError(
      "Memory flagged sensitive (PII/identity/financial). Pass allowSensitive to store, or scope to a task.",
    );
  }
  const status: MemStatus = input.activate && input.createdBy === "user" ? "active" : "proposed";
  const ts = nowIso();
  return db.transaction(() => {
    const info = db.db
      .prepare(
        `INSERT INTO memory_items
          (mem_type, title, body, scope, scope_ref, confidence, sensitivity, status,
           source_refs, created_by, current_version, created_at, updated_at, valid_from)
         VALUES (@mem_type, @title, @body, @scope, @scope_ref, @confidence, @sensitivity, @status,
           @source_refs, @created_by, 1, @ts, @ts, @ts)`,
      )
      .run({
        mem_type: input.memType,
        title: input.title,
        body: input.body,
        scope: input.scope ?? "global",
        scope_ref: input.scopeRef ?? null,
        confidence: input.confidence ?? 0.6,
        sensitivity,
        status,
        source_refs: input.sourceRefs ? JSON.stringify(input.sourceRefs) : null,
        created_by: input.createdBy,
        ts,
      });
    const id = Number(info.lastInsertRowid);
    writeVersion(db, id, 1, "propose", status, input.title, input.body, input.confidence ?? 0.6, input.createdBy, null);
    syncItemFts(db, id);
    db.audit({
      actor: input.createdBy,
      action: "memory.propose",
      entityType: "memory",
      entityId: id,
      sensitivity,
      detail: { memType: input.memType, scope: input.scope ?? "global", status },
    });
    return getMemory(db, id)!;
  });
}

export interface UpdateInput {
  title?: string;
  body?: string;
  confidence?: number;
  status?: MemStatus;
  scope?: MemScope;
  scopeRef?: string | null;
  author: Author;
  rationale?: string;
  allowSensitive?: boolean;
  /** version-ledger change type (default 'update'); confirm/restore pass their own */
  changeType?: string;
}

/** Update an item, writing a new version. Supersede-then-replace semantics. */
export function updateMemory(db: UMemDB, id: number, patch: UpdateInput): MemoryItem {
  const cur = getMemory(db, id);
  if (!cur) throw new Error(`memory ${id} not found`);
  const title = patch.title ?? cur.title;
  const body = patch.body ?? cur.body;
  const combined = `${title}\n${body}`;
  if (containsSecret(combined)) {
    db.audit({ actor: patch.author, action: "memory.reject_secret", entityType: "memory", entityId: id });
    throw new SecretRejectedError("Refusing to update memory: credential detected.");
  }
  const sensitivity = classifySensitivity(combined);
  if (sensitivity === "sensitive" && cur.scope !== "task" && !patch.allowSensitive && (patch.title || patch.body)) {
    throw new SensitiveBlockedError("Updated memory flagged sensitive; pass allowSensitive.");
  }
  const status = patch.status ?? cur.status;
  const version = cur.current_version + 1;
  const ts = nowIso();
  return db.transaction(() => {
    db.db
      .prepare(
        `UPDATE memory_items
         SET title=@title, body=@body, confidence=@confidence, status=@status,
             scope=@scope, scope_ref=@scope_ref, sensitivity=@sensitivity,
             current_version=@version, updated_at=@ts
         WHERE id=@id`,
      )
      .run({
        id,
        title,
        body,
        confidence: patch.confidence ?? cur.confidence,
        status,
        scope: patch.scope ?? cur.scope,
        scope_ref: patch.scopeRef !== undefined ? patch.scopeRef : cur.scope_ref,
        sensitivity,
        version,
        ts,
      });
    writeVersion(db, id, version, patch.changeType ?? "update", status, title, body, patch.confidence ?? cur.confidence, patch.author, patch.rationale ?? null);
    syncItemFts(db, id);
    db.audit({
      actor: patch.author,
      action: patch.changeType ? `memory.${patch.changeType}` : "memory.update",
      entityType: "memory",
      entityId: id,
      sensitivity,
      detail: { version, statusFrom: cur.status, statusTo: status },
    });
    return getMemory(db, id)!;
  });
}

/** Confirm a proposed item -> active. */
export function confirmMemory(db: UMemDB, id: number, author: Author): MemoryItem {
  return updateMemory(db, id, { status: "active", author, rationale: "confirmed", changeType: "confirm" });
}

/** Forget an item: status -> forgotten, drop from search. History is retained. */
export function forgetMemory(db: UMemDB, id: number, author: Author, rationale?: string): MemoryItem {
  const cur = getMemory(db, id);
  if (!cur) throw new Error(`memory ${id} not found`);
  const version = cur.current_version + 1;
  const ts = nowIso();
  return db.transaction(() => {
    db.db.prepare("UPDATE memory_items SET status='forgotten', current_version=?, updated_at=? WHERE id=?").run(version, ts, id);
    writeVersion(db, id, version, "forget", "forgotten", cur.title, cur.body, cur.confidence, author, rationale ?? null);
    syncItemFts(db, id);
    db.audit({ actor: author, action: "memory.forget", entityType: "memory", entityId: id, detail: { rationale } });
    return getMemory(db, id)!;
  });
}

/** Restore a prior version (undo). */
export function restoreVersion(db: UMemDB, id: number, version: number, author: Author): MemoryItem {
  const v = db.db
    .prepare("SELECT * FROM memory_versions WHERE memory_id=? AND version=?")
    .get(id, version) as any;
  if (!v) throw new Error(`version ${version} of memory ${id} not found`);
  return updateMemory(db, id, {
    title: v.title,
    body: v.body,
    confidence: v.confidence,
    status: "active",
    author,
    rationale: `restore v${version}`,
    changeType: "restore",
  });
}

export function getMemory(db: UMemDB, id: number): MemoryItem | undefined {
  return db.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id) as MemoryItem | undefined;
}

export function listVersions(db: UMemDB, id: number): any[] {
  return db.db.prepare("SELECT version, change_type, status_after, author, rationale, created_at FROM memory_versions WHERE memory_id=? ORDER BY version").all(id);
}

export interface RecentOpts {
  limit?: number;
  memType?: MemType;
  scope?: MemScope;
  scopeRef?: string;
  status?: MemStatus;
  includeForgotten?: boolean;
}

export function recentMemory(db: UMemDB, opts: RecentOpts = {}): MemoryItem[] {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.memType) { where.push("mem_type = ?"); params.push(opts.memType); }
  if (opts.scope) { where.push("scope = ?"); params.push(opts.scope); }
  if (opts.scopeRef) { where.push("scope_ref = ?"); params.push(opts.scopeRef); }
  if (opts.status) { where.push("status = ?"); params.push(opts.status); }
  else if (!opts.includeForgotten) where.push("status != 'forgotten'");
  const sql = `SELECT * FROM memory_items ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY updated_at DESC LIMIT ?`;
  params.push(opts.limit ?? 20);
  return db.db.prepare(sql).all(...params) as MemoryItem[];
}
