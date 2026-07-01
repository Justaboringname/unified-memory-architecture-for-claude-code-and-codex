import type { UMemDB } from "../db/db.ts";
import { nowIso } from "../util/time.ts";

export interface SourceInput {
  provider: string;
  sourceType: string;
  filePath: string;
  contentHash: string;
  projectKey?: string | null;
  externalId?: string | null;
  byteSize?: number | null;
  originTs?: string | null;
  sensitivity?: string;
  ingested?: boolean;
  meta?: unknown;
}

/** Idempotent upsert of a provenance source; returns its id. */
export function upsertSource(db: UMemDB, s: SourceInput): number {
  const existing = db.db
    .prepare(
      `SELECT id FROM sources WHERE provider=? AND source_type=? AND file_path=? AND IFNULL(external_id,'')=IFNULL(?, '')`,
    )
    .get(s.provider, s.sourceType, s.filePath, s.externalId ?? null) as { id: number } | undefined;
  if (existing) {
    db.db
      .prepare("UPDATE sources SET content_hash=?, byte_size=?, imported_at=?, sensitivity=?, ingested=?, meta_json=? WHERE id=?")
      .run(
        s.contentHash,
        s.byteSize ?? null,
        nowIso(),
        s.sensitivity ?? "normal",
        s.ingested === false ? 0 : 1,
        s.meta != null ? JSON.stringify(s.meta) : null,
        existing.id,
      );
    return existing.id;
  }
  const info = db.db
    .prepare(
      `INSERT INTO sources(provider, source_type, project_key, external_id, file_path, content_hash,
         byte_size, origin_ts, imported_at, sensitivity, ingested, meta_json)
       VALUES (@provider,@sourceType,@projectKey,@externalId,@filePath,@contentHash,
         @byteSize,@originTs,@importedAt,@sensitivity,@ingested,@meta)`,
    )
    .run({
      provider: s.provider,
      sourceType: s.sourceType,
      projectKey: s.projectKey ?? null,
      externalId: s.externalId ?? null,
      filePath: s.filePath,
      contentHash: s.contentHash,
      byteSize: s.byteSize ?? null,
      originTs: s.originTs ?? null,
      importedAt: nowIso(),
      sensitivity: s.sensitivity ?? "normal",
      ingested: s.ingested === false ? 0 : 1,
      meta: s.meta != null ? JSON.stringify(s.meta) : null,
    });
  return Number(info.lastInsertRowid);
}

export interface Checkpoint {
  content_hash: string;
  status: string;
  n_messages: number;
}

export function getCheckpoint(db: UMemDB, unitType: string, unitKey: string): Checkpoint | undefined {
  return db.db
    .prepare("SELECT content_hash, status, n_messages FROM import_checkpoints WHERE unit_type=? AND unit_key=?")
    .get(unitType, unitKey) as Checkpoint | undefined;
}

export function setCheckpoint(
  db: UMemDB,
  unitType: string,
  unitKey: string,
  contentHash: string,
  status: string,
  nMessages: number,
): void {
  db.db
    .prepare(
      `INSERT INTO import_checkpoints(unit_type, unit_key, content_hash, status, n_messages, imported_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(unit_type, unit_key) DO UPDATE SET
         content_hash=excluded.content_hash, status=excluded.status,
         n_messages=excluded.n_messages, imported_at=excluded.imported_at`,
    )
    .run(unitType, unitKey, contentHash, status, nMessages, nowIso());
}

/** Remove a conversation and its messages + FTS rows (for clean re-import). */
export function purgeConversation(db: UMemDB, provider: string, externalUuid: string): void {
  const conv = db.db
    .prepare("SELECT id FROM conversations WHERE provider=? AND external_uuid=?")
    .get(provider, externalUuid) as { id: number } | undefined;
  if (!conv) return;
  db.db.prepare("DELETE FROM fts_messages WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)").run(conv.id);
  db.db.prepare("DELETE FROM conversations WHERE id=?").run(conv.id); // cascades messages
}
