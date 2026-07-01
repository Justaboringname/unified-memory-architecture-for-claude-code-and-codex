import { test } from "node:test";
import assert from "node:assert/strict";
import { seededDb } from "./helpers.ts";
import { MockAdapter } from "../src/agents/adapter.ts";
import { runCouncil } from "../src/orchestrator/council.ts";

test("council: independent → cross-review → synthesis, fully recorded", async () => {
  const { db, cleanup } = await seededDb();
  try {
    const claude = new MockAdapter("claude");
    const codex = new MockAdapter("codex");
    const res = await runCouncil(db, claude, codex, { question: "tune the flywheel shooter", constraints: ["efficient"] });

    // independent + divergent
    assert.ok(res.claude.answer.includes("Approach A"));
    assert.ok(res.codex.answer.includes("Approach B"));
    assert.notEqual(res.claude.answer, res.codex.answer);

    // cross review produced verdicts
    assert.ok(["endorse", "endorse-with-changes", "reject"].includes(res.claudeReviewOfCodex.verdict));

    // synthesis picks a single executor
    assert.ok(["claude", "codex", "none"].includes(res.synthesis.executor));

    // audit trail: 5 runs (2 analyst + 2 review + 1 synth), messages, audits
    const runs = (db.db.prepare("SELECT COUNT(*) c FROM agent_runs WHERE task_id=?").get(res.taskId) as any).c;
    assert.equal(runs, 5);
    const msgs = (db.db.prepare("SELECT COUNT(*) c FROM agent_messages WHERE task_id=?").get(res.taskId) as any).c;
    assert.ok(msgs >= 6);
    const task = db.db.prepare("SELECT status, result_ref FROM tasks WHERE id=?").get(res.taskId) as any;
    assert.equal(task.status, "done");
    assert.ok(task.result_ref, "final synthesis artifact linked");
  } finally { cleanup(); }
});

test("council resume reuses completed phases (no duplicate runs)", async () => {
  const { db, cleanup } = await seededDb();
  try {
    const claude = new MockAdapter("claude");
    const codex = new MockAdapter("codex");
    const q = "tune the flywheel shooter";
    const r1 = await runCouncil(db, claude, codex, { question: q });
    const runs1 = (db.db.prepare("SELECT COUNT(*) c FROM agent_runs WHERE task_id=?").get(r1.taskId) as any).c;
    await runCouncil(db, claude, codex, { question: q, resumeTaskId: r1.taskId });
    const runs2 = (db.db.prepare("SELECT COUNT(*) c FROM agent_runs WHERE task_id=?").get(r1.taskId) as any).c;
    assert.equal(runs1, runs2, "resume did not re-run any phase");
  } finally { cleanup(); }
});

test("council tolerates an adapter that throws (records failure, keeps going)", async () => {
  const { db, cleanup } = await seededDb();
  try {
    const claude = new MockAdapter("claude");
    const broken = new MockAdapter("codex");
    (broken as any).complete = async () => { throw new Error("simulated outage"); };
    const res = await runCouncil(db, claude, broken as any, { question: "tune the flywheel shooter" });
    assert.ok(res.synthesis, "synthesis still produced");
    const failed = (db.db.prepare("SELECT COUNT(*) c FROM agent_runs WHERE status='failed'").get() as any).c;
    assert.ok(failed >= 1, "the broken adapter's failure is recorded");
  } finally { cleanup(); }
});
