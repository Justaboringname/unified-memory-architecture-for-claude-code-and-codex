import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import { openDb } from "../db/db.ts";
import { REPO_ROOT, type Config } from "../util/config.ts";
import { importClaudeExport } from "../ingest/import-claude-export.ts";
import { MockAdapter } from "../agents/adapter.ts";
import { runCouncil } from "../orchestrator/council.ts";
import { acquireLease, LeaseHeldError, releaseLease } from "../orchestrator/lease.ts";
import { search } from "../search/search.ts";

/**
 * Offline end-to-end demo: import synthetic data, run a dual-agent council with
 * mock adapters (independent → cross-review → synthesis), and prove the
 * single-writer lease. No network, no auth, no cost.
 */
export async function runDemo(_cfg: Config) {
  const dbPath = join(REPO_ROOT, "data", "demo.db");
  for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
  const db = openDb(dbPath);
  const fixtures = join(REPO_ROOT, "fixtures", "synthetic-export");

  console.log("① Importing synthetic export (fake data)…");
  const st = await importClaudeExport(db, fixtures);
  console.log(`   +${st.conversations} conversations, ${st.messages} messages, ${st.projects} project, ${st.designChats} design-chat\n`);

  console.log("② Scoped bilingual search:");
  for (const q of ["索引", "flywheel exit velocity", "dumper efficiency"]) {
    const hits = search(db, q, {}, 3);
    console.log(`   "${q}" → ${hits.length} hit(s): ${hits.map((h) => `${h.kind}/${h.matchType}`).join(", ") || "—"}`);
  }

  console.log("\n③ Dual-agent council (mock adapters, deterministic):");
  const claude = new MockAdapter("claude", "claude-opus-4-8");
  const codex = new MockAdapter("codex", "gpt-5-codex");
  const res = await runCouncil(db, claude, codex, {
    question: "How should I tune the flywheel shooter for foam balls, energy-efficiently?",
    projectKey: null,
    constraints: ["prioritise energy efficiency", "~45° launch angle"],
  });
  console.log(`   Claude (conf ${res.claude.confidence}): ${res.claude.answer.slice(0, 90)}…`);
  console.log(`   Codex  (conf ${res.codex.confidence}): ${res.codex.answer.slice(0, 90)}…`);
  console.log(`   Claude→Codex: ${res.claudeReviewOfCodex.verdict}; Codex→Claude: ${res.codexReviewOfClaude.verdict}`);
  console.log(`   Synthesis executor (single writer): ${res.synthesis.executor}`);
  console.log(`   Final: ${res.synthesis.finalAnswer.slice(0, 120)}…`);

  console.log("\n④ Single-writer lease (structural guarantee):");
  const ws = "/tmp/demo-workspace";
  const l1 = acquireLease(db, res.taskId, ws, "codex");
  console.log(`   codex acquired write lease on ${ws}`);
  try {
    acquireLease(db, res.taskId, ws, "claude");
    console.log("   ✗ BUG: claude also acquired the lease!");
  } catch (e) {
    if (e instanceof LeaseHeldError) console.log(`   ✓ claude BLOCKED from same workspace: ${e.message}`);
    else throw e;
  }
  releaseLease(db, l1);
  console.log("   codex released; workspace is free again.");

  console.log("\n⑤ Auditability:");
  const runs = (db.db.prepare("SELECT COUNT(*) c FROM agent_runs").get() as any).c;
  const audits = (db.db.prepare("SELECT COUNT(*) c FROM audit_log").get() as any).c;
  const leases = (db.db.prepare("SELECT COUNT(*) c FROM worktree_leases").get() as any).c;
  console.log(`   ${runs} agent runs, ${audits} audit entries, ${leases} lease record(s) — all persisted in SQLite.`);
  console.log(`\nDemo DB: ${dbPath}  (inspect with: umem inventory)`);
  db.close();
}
