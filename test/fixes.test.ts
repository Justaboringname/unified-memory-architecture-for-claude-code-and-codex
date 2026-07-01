// Regression tests for the confirmed adversarial-review findings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDb } from "./helpers.ts";
import { importMemoryMd, importSessionJsonl } from "../src/ingest/import-claude-code.ts";
import { importAccountMemory } from "../src/ingest/import-claude-export.ts";
import { search } from "../src/search/search.ts";
import { nowIso } from "../src/util/time.ts";
import { acquireLease, reclaimStaleLeases, currentHolder } from "../src/orchestrator/lease.ts";

function tmpFile(name: string, content: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "umem-fix-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return { path, dir };
}

// Finding #1: import paths must strip secrets before writing to memory_items.
test("imported auto-memory has credentials stripped from the derived layer", () => {
  const { db, cleanup } = tempDb();
  const { path, dir } = tmpFile("secret_note.md", "---\nname: secret_note\ntype: reference\n---\nDeploy key: sk-ant-FAKEFAKEFAKEFAKEFAKE1234567890 do not lose it. Also useful flywheel context.");
  try {
    importMemoryMd(db, path, "proj");
    const row = db.db.prepare("SELECT body FROM memory_items WHERE title='secret_note'").get() as { body: string };
    assert.ok(!row.body.includes("sk-ant-FAKEFAKEFAKEFAKEFAKE1234567890"), "credential must not be stored in memory_items");
    assert.ok(row.body.includes("removed"), "secret is masked");
    // and the credential is not searchable
    assert.equal(search(db, "sk-ant-FAKEFAKEFAKEFAKEFAKE1234567890", { kinds: ["memory"] }, 5).length, 0);
    // but the surrounding content is still searchable
    assert.ok(search(db, "flywheel context", { kinds: ["memory"] }, 5).length >= 1);
  } finally { cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

// Finding #2: memory_get/search must hide the body for 'secret' tier, not just 'sensitive'.
test("'secret'-tier memory body is hidden in search preview", () => {
  const { db, cleanup } = tempDb();
  try {
    const ts = nowIso();
    const info = db.db.prepare(
      `INSERT INTO memory_items(mem_type,title,body,scope,confidence,sensitivity,status,created_by,current_version,created_at,updated_at)
       VALUES ('semantic','leaky','flywheel secret body','global',0.5,'secret','active','import',1,?,?)`,
    ).run(ts, ts);
    db.db.prepare("INSERT INTO fts_memory(memory_id,title,body) VALUES (?,?,?)").run(Number(info.lastInsertRowid), "leaky", "flywheel secret body");
    const hits = search(db, "flywheel", { kinds: ["memory"] }, 5);
    const h = hits.find((x) => x.title === "leaky");
    assert.ok(h, "item is found");
    assert.ok(h!.preview.includes("hidden"), "secret body is not previewed");
    assert.ok(!h!.preview.includes("secret body"));
  } finally { cleanup(); }
});

// Finding #4: session identity comes from the FILENAME, so a forked file whose
// first-line sessionId is the PARENT's must not delete the parent's conversation.
test("forked session file does not delete the parent session's conversation", async () => {
  const { db, cleanup } = tempDb();
  const parentId = "aaaaaaaa-0000-0000-0000-000000000001";
  const forkId = "bbbbbbbb-0000-0000-0000-000000000002";
  const parent = tmpFile(`${parentId}.jsonl`,
    `{"type":"user","sessionId":"${parentId}","uuid":"u1","timestamp":"2025-01-01T00:00:00Z","message":{"role":"user","content":"parent question about rockets"}}\n`);
  // fork file: filename is forkId, but its lines carry the PARENT's sessionId
  const fork = tmpFile(`${forkId}.jsonl`,
    `{"type":"user","sessionId":"${parentId}","uuid":"u2","timestamp":"2025-01-02T00:00:00Z","message":{"role":"user","content":"forked question about engines"}}\n`);
  try {
    await importSessionJsonl(db, parent.path, "proj");
    await importSessionJsonl(db, fork.path, "proj");
    const convs = db.db.prepare("SELECT external_uuid FROM conversations WHERE provider='claude-code' ORDER BY external_uuid").all() as any[];
    assert.equal(convs.length, 2, "both parent and fork conversations survive");
    assert.deepEqual(convs.map((c) => c.external_uuid), [parentId, forkId]);
  } finally { cleanup(); rmSync(parent.dir, { recursive: true, force: true }); rmSync(fork.dir, { recursive: true, force: true }); }
});

// Finding #7: distinct assistant text blocks under one message.id are concatenated.
test("distinct assistant text blocks under one message.id are concatenated, not dropped", async () => {
  const { db, cleanup } = tempDb();
  const id = "cccccccc-0000-0000-0000-000000000003";
  const f = tmpFile(`${id}.jsonl`,
    `{"type":"assistant","sessionId":"${id}","uuid":"a1","timestamp":"2025-01-01T00:00:00Z","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"First long block about aerodynamics and drag coefficients here"}]}}\n` +
    `{"type":"assistant","sessionId":"${id}","uuid":"a2","timestamp":"2025-01-01T00:00:01Z","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Second distinct block on nozzle geometry"}]}}\n`);
  try {
    await importSessionJsonl(db, f.path, "proj");
    const msg = db.db.prepare("SELECT text FROM messages WHERE role='assistant'").get() as { text: string };
    assert.ok(msg.text.includes("aerodynamics"), "first block kept");
    assert.ok(msg.text.includes("nozzle geometry"), "second distinct block NOT dropped");
  } finally { cleanup(); rmSync(f.dir, { recursive: true, force: true }); }
});

// Finding #5/#6: account memory updates on re-import and supports multiple accounts.
test("account memory updates on change and keeps per-account items", () => {
  const { db, cleanup } = tempDb();
  const v1 = tmpFile("memories.json", JSON.stringify([
    { conversations_memory: "alpha content one", account_uuid: "acc-A" },
    { conversations_memory: "beta content two", account_uuid: "acc-B" },
  ]));
  try {
    assert.equal(importAccountMemory(db, v1.path), 2);
    assert.equal((db.db.prepare("SELECT COUNT(*) c FROM memory_items WHERE title LIKE 'Claude account rolling memory%'").get() as any).c, 2, "two accounts, two items");
    // change acc-A's content and re-import
    writeFileSync(v1.path, JSON.stringify([
      { conversations_memory: "alpha content UPDATED", account_uuid: "acc-A" },
      { conversations_memory: "beta content two", account_uuid: "acc-B" },
    ]));
    importAccountMemory(db, v1.path);
    // Inspect the acc-A item body directly (OR-tokenized search would still
    // match on shared words like "alpha"/"content").
    const accA = db.db.prepare("SELECT body FROM memory_items WHERE title='Claude account rolling memory (acc-A)'").get() as { body: string };
    assert.ok(accA.body.includes("UPDATED"), "changed body persisted");
    assert.ok(!accA.body.includes("alpha content one"), "stale body replaced");
    assert.ok(search(db, "UPDATED", { kinds: ["memory"] }, 5).length >= 1, "changed body is retrievable");
    // still exactly two account items (no duplicate created on re-import)
    assert.equal((db.db.prepare("SELECT COUNT(*) c FROM memory_items WHERE title LIKE 'Claude account rolling memory%'").get() as any).c, 2);
  } finally { cleanup(); rmSync(v1.dir, { recursive: true, force: true }); }
});

// Finding #3: a lease held by a DEAD process is reclaimed so the workspace isn't bricked.
test("stale lease from a crashed (dead-pid) holder is reclaimed on next acquire", () => {
  const { db, cleanup } = tempDb();
  try {
    const ts = nowIso();
    const task = Number(db.db.prepare("INSERT INTO tasks(question,mode,status,created_at,updated_at) VALUES ('q','builder-reviewer','running',?,?)").run(ts, ts).lastInsertRowid);
    const deadPid = 2147483646; // effectively never a live pid
    // simulate a crashed holder: a 'held' lease whose process is gone
    db.db.prepare("INSERT INTO worktree_leases(task_id,workspace_path,holder_agent,holder_pid,status,acquired_at) VALUES (?,?,?,?,'held',?)")
      .run(task, "/tmp/ws-crash", "codex", deadPid, ts);
    assert.equal(currentHolder(db, "/tmp/ws-crash"), "codex", "stale lease initially blocks");
    // acquire reclaims the dead holder and succeeds
    const l = acquireLease(db, task, "/tmp/ws-crash", "claude");
    assert.equal(currentHolder(db, "/tmp/ws-crash"), "claude", "new holder acquired after reclaim");
    assert.equal((db.db.prepare("SELECT COUNT(*) c FROM worktree_leases WHERE status='reclaimed'").get() as any).c, 1);
    assert.ok(l.id);
  } finally { cleanup(); }
});

// Finding #6 (search): task-scoped memory is reachable when both project+task scope set.
test("task-scoped memory is not hidden by a concurrent project scope", () => {
  const { db, cleanup } = tempDb();
  try {
    const ts = nowIso();
    const info = db.db.prepare(
      `INSERT INTO memory_items(mem_type,title,body,scope,scope_ref,confidence,sensitivity,status,created_by,current_version,created_at,updated_at)
       VALUES ('working','task note','flywheel task detail','task','5',0.6,'normal','active','user',1,?,?)`,
    ).run(ts, ts);
    db.db.prepare("INSERT INTO fts_memory(memory_id,title,body) VALUES (?,?,?)").run(Number(info.lastInsertRowid), "task note", "flywheel task detail");
    const hits = search(db, "flywheel", { projectKey: "P", taskId: 5, kinds: ["memory"] }, 5);
    assert.ok(hits.some((h) => h.title === "task note"), "task memory retrievable under project+task scope");
  } finally { cleanup(); }
});
