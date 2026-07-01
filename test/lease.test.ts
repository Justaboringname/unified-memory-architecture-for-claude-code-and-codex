import { test } from "node:test";
import assert from "node:assert/strict";
import { tempDb } from "./helpers.ts";
import { acquireLease, releaseLease, withWriteLease, LeaseHeldError, currentHolder } from "../src/orchestrator/lease.ts";
import { nowIso } from "../src/util/time.ts";

function mkTask(db: any): number {
  const info = db.db.prepare("INSERT INTO tasks(question, mode, status, created_at, updated_at) VALUES (?,?,?,?,?)").run("q", "builder-reviewer", "running", nowIso(), nowIso());
  return Number(info.lastInsertRowid);
}

test("second writer on the same workspace is structurally blocked", () => {
  const { db, cleanup } = tempDb();
  try {
    const task = mkTask(db);
    const l = acquireLease(db, task, "/tmp/ws-a", "codex");
    assert.equal(currentHolder(db, "/tmp/ws-a"), "codex");
    assert.throws(() => acquireLease(db, task, "/tmp/ws-a", "claude"), LeaseHeldError);
    releaseLease(db, l);
    // after release, a new holder can acquire
    const l2 = acquireLease(db, task, "/tmp/ws-a", "claude");
    assert.equal(currentHolder(db, "/tmp/ws-a"), "claude");
    releaseLease(db, l2);
  } finally { cleanup(); }
});

test("different workspaces can be held concurrently", () => {
  const { db, cleanup } = tempDb();
  try {
    const task = mkTask(db);
    const a = acquireLease(db, task, "/tmp/ws-1", "codex");
    const b = acquireLease(db, task, "/tmp/ws-2", "claude");
    assert.ok(a.id !== b.id);
    releaseLease(db, a); releaseLease(db, b);
  } finally { cleanup(); }
});

test("withWriteLease releases even on throw", async () => {
  const { db, cleanup } = tempDb();
  try {
    const task = mkTask(db);
    await assert.rejects(withWriteLease(db, task, "/tmp/ws-x", "codex", async () => { throw new Error("boom"); }));
    assert.equal(currentHolder(db, "/tmp/ws-x"), null, "lease released after throw");
  } finally { cleanup(); }
});
