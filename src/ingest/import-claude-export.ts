import { createReadStream, existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ChainMod from "stream-chain";
import ParserMod from "stream-json";
import StreamArrayMod from "stream-json/streamers/StreamArray.js";

// CJS→ESM interop: default export is the factory fn, with a named alias too.
const chain = (ChainMod as any).chain ?? (ChainMod as any);
const parser = (ParserMod as any).parser ?? (ParserMod as any);
const streamArray = (StreamArrayMod as any).streamArray ?? (StreamArrayMod as any);
import type { UMemDB } from "../db/db.ts";
import { nowIso } from "../util/time.ts";
import { sha256, sha256File } from "./hash.ts";
import { classifySensitivity, stripSecrets } from "./redact.ts";
import { upsertSource, getCheckpoint, setCheckpoint, purgeConversation } from "./sources.ts";
import { log } from "../util/log.ts";

const PROVIDER = "claude-web";

export interface ImportStats {
  conversations: number;
  conversationsSkipped: number;
  messages: number;
  memories: number;
  projects: number;
  designChats: number;
  sourcesRecorded: number;
}

/** Extract the human-readable text of an export message from its content blocks. */
function extractMessageText(msg: any): string {
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const parts: string[] = [];
  for (const b of blocks) {
    if (b && typeof b === "object" && typeof b.text === "string" && b.text) parts.push(b.text);
  }
  const joined = parts.join("\n").trim();
  if (joined) return joined;
  return typeof msg.text === "string" ? msg.text : "";
}

/** Insert one conversation + its messages inside a transaction. Idempotent via checkpoint. */
function importOneConversation(db: UMemDB, conv: any, filePath: string): { imported: boolean; nMessages: number } {
  const uuid: string = conv.uuid;
  if (!uuid) return { imported: false, nMessages: 0 };
  const raw = JSON.stringify(conv);
  const hash = sha256(raw);
  const cp = getCheckpoint(db, "conversation", uuid);
  if (cp && cp.content_hash === hash && cp.status === "done") {
    return { imported: false, nMessages: cp.n_messages };
  }
  return db.transaction(() => {
    // Clean re-import if the content changed.
    if (cp) purgeConversation(db, PROVIDER, uuid);

    const msgs: any[] = Array.isArray(conv.chat_messages) ? conv.chat_messages : [];
    // Convo-level sensitivity = max over messages (heuristic flag only).
    let convSensitive = "normal";
    const sourceId = upsertSource(db, {
      provider: PROVIDER,
      sourceType: "conversation",
      filePath,
      externalId: uuid,
      contentHash: hash,
      byteSize: raw.length,
      originTs: conv.created_at ?? null,
      meta: { name: conv.name, messageCount: msgs.length },
    });
    const convInfo = db.db
      .prepare(
        `INSERT INTO conversations(source_id, provider, external_uuid, project_key, title, summary,
            created_at, updated_at, message_count)
         VALUES (@source_id, @provider, @uuid, NULL, @title, @summary, @created, @updated, @count)`,
      )
      .run({
        source_id: sourceId,
        provider: PROVIDER,
        uuid,
        title: conv.name ?? null,
        summary: conv.summary ?? null,
        created: conv.created_at ?? null,
        updated: conv.updated_at ?? null,
        count: msgs.length,
      });
    const convId = Number(convInfo.lastInsertRowid);

    const insMsg = db.db.prepare(
      `INSERT INTO messages(conversation_id, source_id, external_uuid, message_key, role, seq, text,
         created_at, parent_uuid, char_len, sensitivity)
       VALUES (@conversation_id,@source_id,@external_uuid,@message_key,@role,@seq,@text,@created_at,@parent_uuid,@char_len,@sensitivity)`,
    );
    const insFts = db.db.prepare("INSERT INTO fts_messages(message_id, body) VALUES (?, ?)");
    let seq = 0;
    let count = 0;
    for (const m of msgs) {
      const text = extractMessageText(m);
      const sensitivity = classifySensitivity(text);
      if (sensitivity !== "normal") convSensitive = "sensitive";
      const info = insMsg.run({
        conversation_id: convId,
        source_id: sourceId,
        external_uuid: m.uuid ?? null,
        message_key: null,
        role: m.sender ?? "unknown",
        seq: seq++,
        text,
        created_at: m.created_at ?? null,
        parent_uuid: m.parent_message_uuid ?? null,
        char_len: text.length,
        sensitivity,
      });
      if (text) insFts.run(Number(info.lastInsertRowid), text);
      count++;
    }
    if (convSensitive !== "normal") {
      db.db.prepare("UPDATE sources SET sensitivity='sensitive' WHERE id=?").run(sourceId);
    }
    setCheckpoint(db, "conversation", uuid, hash, "done", count);
    return { imported: true, nMessages: count };
  });
}

/** Stream conversations.json (193MB) element by element — memory safe. */
export async function importConversations(
  db: UMemDB,
  filePath: string,
  onProgress?: (n: number) => void,
): Promise<{ imported: number; skipped: number; messages: number }> {
  if (!existsSync(filePath)) return { imported: 0, skipped: 0, messages: 0 };
  let imported = 0,
    skipped = 0,
    messages = 0,
    failed = 0,
    seen = 0;
  const pipeline = chain([createReadStream(filePath), parser(), streamArray()]);
  for await (const { value } of pipeline as AsyncIterable<{ value: any }>) {
    // Per-record isolation: one malformed conversation must not abort the whole
    // stream. Each conversation import is its own transaction, so a failure
    // rolls back that record only; a re-run resumes it cleanly via checkpoint.
    try {
      const r = importOneConversation(db, value, filePath);
      if (r.imported) imported++;
      else skipped++;
      messages += r.nMessages;
    } catch (e) {
      failed++;
      log.warn("import.conversation.fail", { uuid: value?.uuid, err: String(e) });
    }
    seen++;
    if (onProgress && seen % 100 === 0) onProgress(seen);
  }
  log.info("import.conversations.done", { imported, skipped, messages, failed });
  return { imported, skipped, messages };
}

/** memories.json — the account-level summary memory (one derived item). */
export function importAccountMemory(db: UMemDB, filePath: string): number {
  if (!existsSync(filePath)) return 0;
  const arr = JSON.parse(readFileSync(filePath, "utf-8")) as any[];
  let n = 0;
  for (const entry of arr) {
    const rawBody: string = entry.conversations_memory ?? "";
    if (!rawBody) continue;
    const acct: string = entry.account_uuid ?? "account";
    const hash = sha256(rawBody);
    const sourceId = upsertSource(db, {
      provider: PROVIDER,
      sourceType: "account_memory",
      filePath,
      externalId: acct,
      contentHash: hash,
      byteSize: rawBody.length,
      sensitivity: classifySensitivity(rawBody),
      meta: { note: "Claude account-level rolling memory summary" },
    });
    // Strip credentials before storing in the derived memory layer (ADR-0003).
    const { text: body, stripped } = stripSecrets(rawBody);
    if (stripped) db.audit({ actor: "import", action: "memory.secret_stripped", entityType: "source", entityId: sourceId, detail: { file: "memories.json", count: stripped } });
    const sens = classifySensitivity(body);
    const ts = nowIso();
    // Key by account_uuid (title) so multiple accounts each get their own item,
    // and UPDATE on re-import so a changed memories.json isn't left stale.
    const title = `Claude account rolling memory (${acct})`;
    const existing = db.db.prepare("SELECT id FROM memory_items WHERE title=? AND created_by='import'").get(title) as { id: number } | undefined;
    if (existing) {
      db.db.prepare("UPDATE memory_items SET body=?, sensitivity=?, updated_at=?, current_version=current_version+1 WHERE id=?").run(body, sens, ts, existing.id);
      db.db.prepare("DELETE FROM fts_memory WHERE memory_id=?").run(existing.id);
      db.db.prepare("INSERT INTO fts_memory(memory_id, title, body) VALUES (?,?,?)").run(existing.id, title, body);
    } else {
      const info = db.db
        .prepare(
          `INSERT INTO memory_items(mem_type, title, body, scope, confidence, sensitivity, status,
              source_refs, created_by, current_version, created_at, updated_at, valid_from)
           VALUES ('semantic', ?, ?, 'global', 0.7, ?, 'active', ?, 'import', 1, ?, ?, ?)`,
        )
        .run(title, body, sens, JSON.stringify([{ source_id: sourceId, note: "memories.json" }]), ts, ts, ts);
      const id = Number(info.lastInsertRowid);
      db.db.prepare("INSERT INTO fts_memory(memory_id, title, body) VALUES (?,?,?)").run(id, title, body);
      db.audit({ actor: "import", action: "memory.import_account", entityType: "memory", entityId: id, sensitivity: sens });
    }
    n++;
  }
  return n;
}

/** projects/*.json — Claude Projects + their docs. */
export function importProjects(db: UMemDB, dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const fp = join(dir, f);
    const p = JSON.parse(readFileSync(fp, "utf-8")) as any;
    const raw = JSON.stringify(p);
    const hash = sha256(raw);
    const projectKey = `claude-web:${p.name ?? p.uuid}`;
    const sourceId = upsertSource(db, {
      provider: PROVIDER,
      sourceType: "project_doc",
      filePath: fp,
      externalId: p.uuid,
      contentHash: hash,
      byteSize: raw.length,
      meta: { name: p.name, docs: (p.docs ?? []).length },
    });
    db.db
      .prepare(
        `INSERT INTO projects(provider, external_id, project_key, name, description, created_at, updated_at, meta_json)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(provider, project_key) DO UPDATE SET name=excluded.name, description=excluded.description, updated_at=excluded.updated_at`,
      )
      .run(PROVIDER, p.uuid, projectKey, p.name ?? null, p.description ?? null, p.created_at ?? null, p.updated_at ?? null, JSON.stringify({ sourceId }));

    // Index each project doc as a searchable, project-scoped semantic memory.
    for (const doc of (p.docs ?? []) as any[]) {
      const rawContent: string = doc.content ?? "";
      if (!rawContent) continue;
      const title = `${p.name ?? "project"} · ${doc.filename ?? "doc"}`;
      // Strip credentials before storing in the derived memory layer (ADR-0003).
      const { text: content, stripped } = stripSecrets(rawContent);
      if (stripped) db.audit({ actor: "import", action: "memory.secret_stripped", entityType: "source", entityId: sourceId, detail: { file: doc.filename, count: stripped } });
      const sens = classifySensitivity(content);
      const ts = nowIso();
      const existing = db.db.prepare("SELECT id FROM memory_items WHERE title=? AND scope_ref=? AND created_by='import'").get(title, projectKey) as { id: number } | undefined;
      if (existing) {
        db.db.prepare("UPDATE memory_items SET body=?, sensitivity=?, updated_at=?, current_version=current_version+1 WHERE id=?").run(content, sens, ts, existing.id);
        db.db.prepare("DELETE FROM fts_memory WHERE memory_id=?").run(existing.id);
        db.db.prepare("INSERT INTO fts_memory(memory_id,title,body) VALUES (?,?,?)").run(existing.id, title, content);
      } else {
        const info = db.db
          .prepare(
            `INSERT INTO memory_items(mem_type,title,body,scope,scope_ref,confidence,sensitivity,status,source_refs,created_by,current_version,created_at,updated_at,valid_from)
             VALUES ('semantic',?,?,'project',?,0.75,?,'active',?,'import',1,?,?,?)`,
          )
          .run(title, content, projectKey, sens, JSON.stringify([{ source_id: sourceId, note: `project doc: ${doc.filename}` }]), ts, ts, ts);
        db.db.prepare("INSERT INTO fts_memory(memory_id,title,body) VALUES (?,?,?)").run(Number(info.lastInsertRowid), title, content);
      }
    }
    n++;
  }
  return n;
}

/** design_chats/*.json — treated as conversations under their project. */
export function importDesignChats(db: UMemDB, dir: string): { chats: number; messages: number } {
  if (!existsSync(dir)) return { chats: 0, messages: 0 };
  let chats = 0,
    messages = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const fp = join(dir, f);
    const c = JSON.parse(readFileSync(fp, "utf-8")) as any;
    const msgs: any[] = Array.isArray(c.messages) ? c.messages : [];
    if (msgs.length === 0) continue; // one design chat is empty
    const raw = JSON.stringify(c);
    const hash = sha256(raw);
    const projectKey = c.project?.name ? `claude-web:${c.project.name}` : null;
    const r = db.transaction(() => {
      purgeConversation(db, PROVIDER, c.uuid);
      const sourceId = upsertSource(db, {
        provider: PROVIDER,
        sourceType: "design_chat",
        filePath: fp,
        externalId: c.uuid,
        contentHash: hash,
        byteSize: raw.length,
        projectKey,
        meta: { title: c.title },
      });
      const convInfo = db.db
        .prepare(
          `INSERT INTO conversations(source_id, provider, external_uuid, project_key, title, created_at, updated_at, message_count)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(sourceId, PROVIDER, c.uuid, projectKey, c.title ?? null, c.created_at ?? null, c.updated_at ?? null, msgs.length);
      const convId = Number(convInfo.lastInsertRowid);
      const insMsg = db.db.prepare(
        `INSERT INTO messages(conversation_id, source_id, external_uuid, message_key, role, seq, text, created_at, char_len, sensitivity)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      );
      const insFts = db.db.prepare("INSERT INTO fts_messages(message_id, body) VALUES (?,?)");
      let seq = 0,
        cnt = 0;
      for (const m of msgs) {
        const inner = m.content ?? {};
        const text = typeof inner.content === "string" ? inner.content : "";
        const info = insMsg.run(convId, sourceId, m.uuid ?? null, null, m.role ?? "unknown", seq++, text, m.created_at ?? null, text.length, classifySensitivity(text));
        if (text) insFts.run(Number(info.lastInsertRowid), text);
        cnt++;
      }
      return cnt;
    });
    chats++;
    messages += r;
  }
  return { chats, messages };
}

/** users.json — pure PII. Record path + hash ONLY; never ingest content. */
export async function recordUserProfile(db: UMemDB, filePath: string): Promise<number> {
  if (!existsSync(filePath)) return 0;
  const hash = await sha256File(filePath);
  const size = statSync(filePath).size;
  upsertSource(db, {
    provider: PROVIDER,
    sourceType: "user_profile",
    filePath,
    externalId: "users.json",
    contentHash: hash,
    byteSize: size,
    sensitivity: "sensitive",
    ingested: false, // content NOT loaded into the DB
    meta: { note: "PII account profile — recorded as provenance only, content not ingested" },
  });
  db.audit({ actor: "import", action: "source.record_only", entityType: "source", detail: { file: "users.json", reason: "PII, no retrieval value" } });
  return 1;
}

/** Full Claude web-export import from the export directory. */
export async function importClaudeExport(db: UMemDB, exportDir: string, onProgress?: (n: number) => void): Promise<ImportStats> {
  const stats: ImportStats = { conversations: 0, conversationsSkipped: 0, messages: 0, memories: 0, projects: 0, designChats: 0, sourcesRecorded: 0 };
  const conv = await importConversations(db, join(exportDir, "conversations.json"), onProgress);
  stats.conversations = conv.imported;
  stats.conversationsSkipped = conv.skipped;
  stats.messages += conv.messages;
  stats.memories = importAccountMemory(db, join(exportDir, "memories.json"));
  stats.projects = importProjects(db, join(exportDir, "projects"));
  const dc = importDesignChats(db, join(exportDir, "design_chats"));
  stats.designChats = dc.chats;
  stats.messages += dc.messages;
  stats.sourcesRecorded = await recordUserProfile(db, join(exportDir, "users.json"));
  return stats;
}
