import { test } from "node:test";
import assert from "node:assert/strict";
import { seededDb, FIXTURES } from "./helpers.ts";
import { importClaudeExport } from "../src/ingest/import-claude-export.ts";

test("imports synthetic export with expected counts", async () => {
  const { db, cleanup } = await seededDb();
  try {
    const conv = (db.db.prepare("SELECT COUNT(*) c FROM conversations").get() as any).c;
    const msg = (db.db.prepare("SELECT COUNT(*) c FROM messages").get() as any).c;
    // 2 web conversations + 1 non-empty design chat (the empty one is skipped)
    assert.equal(conv, 3);
    assert.ok(msg >= 5, "at least 5 messages");
    const projMem = (db.db.prepare("SELECT COUNT(*) c FROM memory_items WHERE mem_type='semantic' AND scope='project'").get() as any).c;
    assert.ok(projMem >= 1, "project doc indexed as memory");
  } finally { cleanup(); }
});

test("raw archive KEEPS credentials (evidence layer, not scrubbed)", async () => {
  const { db, cleanup } = await seededDb();
  try {
    const n = (db.db.prepare("SELECT COUNT(*) c FROM messages WHERE text LIKE '%sk-ant-FAKE%'").get() as any).c;
    assert.equal(n, 1, "the fake credential is preserved in the raw message");
  } finally { cleanup(); }
});

test("users.json is recorded as a source but NOT ingested", async () => {
  const { db, cleanup } = await seededDb();
  try {
    const row = db.db.prepare("SELECT ingested, sensitivity FROM sources WHERE source_type='user_profile'").get() as any;
    assert.equal(row.ingested, 0);
    assert.equal(row.sensitivity, "sensitive");
    // ensure no user profile content leaked into messages
    const leak = (db.db.prepare("SELECT COUNT(*) c FROM messages WHERE text LIKE '%fake@example.com%'").get() as any).c;
    assert.equal(leak, 0);
  } finally { cleanup(); }
});

test("re-import is idempotent (checkpoint by content hash)", async () => {
  const { db, cleanup } = await seededDb();
  try {
    const before = (db.db.prepare("SELECT COUNT(*) c FROM messages").get() as any).c;
    const st = await importClaudeExport(db, FIXTURES);
    const after = (db.db.prepare("SELECT COUNT(*) c FROM messages").get() as any).c;
    assert.equal(st.conversations, 0, "nothing re-imported");
    assert.equal(before, after, "message count unchanged");
  } finally { cleanup(); }
});
