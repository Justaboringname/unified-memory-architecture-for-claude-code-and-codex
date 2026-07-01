import type { UMemDB } from "../db/db.ts";
import type { AgentAdapter } from "../agents/adapter.ts";
import {
  AGENT_RESULT_SCHEMA,
  PEER_REVIEW_SCHEMA,
  SYNTHESIS_SCHEMA,
  type AgentResult,
  type PeerReview,
  type Synthesis,
  type TaskPacket,
  type MemoryRef,
} from "../agents/types.ts";
import { search } from "../search/search.ts";
import { nowIso } from "../util/time.ts";
import { safePreview } from "../ingest/redact.ts";
import { log } from "../util/log.ts";

export interface CouncilOpts {
  question: string;
  projectKey?: string | null;
  constraints?: string[];
  memoryLimit?: number;
  /** which agent synthesizes (default 'claude'); orchestrator still owns the flow */
  synthesizer?: "claude" | "codex";
  resumeTaskId?: number;
}

export interface CouncilResult {
  taskId: number;
  question: string;
  memoryRefs: MemoryRef[];
  claude: AgentResult;
  codex: AgentResult;
  claudeReviewOfCodex: PeerReview;
  codexReviewOfClaude: PeerReview;
  synthesis: Synthesis;
}

const SYS_ANALYST =
  "You are one of two INDEPENDENT expert engineering agents collaborating via a coordinator. " +
  "Analyze the task on your own; do not assume or defer to the other agent. Be concrete, cite evidence, " +
  "state assumptions and risks honestly. Return ONLY the requested JSON.";
const SYS_REVIEWER =
  "You are a skeptical peer reviewer. Find real errors, omissions, unsupported claims, and risks in the peer's analysis. " +
  "Do not rubber-stamp. Return ONLY the requested JSON.";
const SYS_SYNTH =
  "You are the coordinator reconciling two independent analyses and their mutual reviews into one plan. " +
  "Prefer evidence over confidence. If code changes are needed, pick a SINGLE executor (the other agent reviews). " +
  "Only propose memories that are durable and non-sensitive. Return ONLY the requested JSON.";

function renderMemory(refs: MemoryRef[]): string {
  if (!refs.length) return "(no relevant memory retrieved)";
  return refs.map((r) => `- [${r.title}] ${r.snippet}`).join("\n");
}

function analystPrompt(p: TaskPacket, agentName: string): string {
  return [
    `Agent: ${agentName}`,
    `Question: ${p.question}`,
    `Project: ${p.projectKey ?? "(none)"}`,
    `Constraints:`,
    ...(p.constraints.length ? p.constraints.map((c) => `- ${c}`) : ["- (none)"]),
    `Relevant unified-memory context (retrieved, may be partial):`,
    renderMemory(p.memoryRefs),
    p.workspaceState ? `Workspace state:\n${p.workspaceState}` : "",
    ``,
    `Produce your INDEPENDENT analysis as JSON (answer, claims, evidence, assumptions, risks, plan, confidence).`,
  ].filter(Boolean).join("\n");
}

function reviewPrompt(p: TaskPacket, agentName: string): string {
  return [
    `Agent: ${agentName}`,
    `You are reviewing the peer agent (${p.peerName})'s analysis of this task.`,
    `Question: ${p.question}`,
    `Peer analysis (JSON):`,
    JSON.stringify(p.peerResult, null, 2),
    ``,
    `Critically review it. Return JSON (agreements, disagreements, missingEvidence, suggestedChanges, verdict, confidence).`,
  ].join("\n");
}

function synthPrompt(q: string, claude: AgentResult, codex: AgentResult, rC: PeerReview, rX: PeerReview): string {
  return [
    `Question: ${q}`,
    `Claude analysis:`,
    JSON.stringify(claude, null, 2),
    `Codex analysis:`,
    JSON.stringify(codex, null, 2),
    `Claude's review of Codex:`,
    JSON.stringify(rC, null, 2),
    `Codex's review of Claude:`,
    JSON.stringify(rX, null, 2),
    ``,
    `Reconcile into one plan. Return JSON (finalAnswer, rationale, executor, verificationPlan, stopConditions, openQuestions, proposedMemories).`,
  ].join("\n");
}

// ---- run + artifact + message recording ----
function recordRun(
  db: UMemDB,
  taskId: number,
  agent: AgentAdapter,
  role: string,
  phase: string,
  started: string,
  ended: string,
  result: { json?: any; text: string; cost?: { usd?: number; tokens?: number }; model?: string; adapter: string },
  kind: string,
  ok: boolean,
  error?: string,
): number {
  const artInfo = db.db
    .prepare(`INSERT INTO artifacts(task_id, kind, body, created_at) VALUES (?,?,?,?)`)
    .run(taskId, kind, result.text, nowIso());
  const artId = Number(artInfo.lastInsertRowid);
  const runInfo = db.db
    .prepare(
      `INSERT INTO agent_runs(task_id, agent, role, phase, status, model, adapter, started_at, ended_at, duration_ms, cost_json, output_ref, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      taskId,
      agent.id,
      role,
      phase,
      ok ? "done" : "failed",
      result.model ?? null,
      result.adapter,
      started,
      ended,
      new Date(ended).getTime() - new Date(started).getTime(),
      result.cost ? JSON.stringify(result.cost) : null,
      artId,
      error ?? null,
    );
  const runId = Number(runInfo.lastInsertRowid);
  const seq = (db.db.prepare("SELECT COUNT(*) c FROM agent_messages WHERE task_id=?").get(taskId) as any).c;
  db.db
    .prepare(`INSERT INTO agent_messages(task_id, run_id, seq, kind, from_agent, body_json, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(taskId, runId, seq, kind, agent.id, JSON.stringify(result.json ?? { text: result.text }), nowIso());
  db.audit({ actor: agent.id, action: `agent.${phase}`, entityType: "task", entityId: taskId, detail: { role, ok, cost: result.cost } });
  return runId;
}

// Coerce adapter output into a typed result. A run that ERRORED (text starts
// with "ERROR:") or returned no structured JSON is an INFRASTRUCTURE failure,
// not a low-confidence analysis — mark confidence 0 so it can't be silently
// consumed downstream as a partial answer (a live reviewer flagged this).
function asAgentResult(r: { json?: any; text: string }): AgentResult {
  if (r.json && typeof r.json === "object" && "answer" in r.json) return r.json as AgentResult;
  const errored = r.text.startsWith("ERROR:");
  return { answer: r.text || "(no structured output)", claims: [], evidence: [], assumptions: [], risks: [errored ? "infrastructure failure — retry required, not a valid analysis" : "adapter returned unstructured output"], plan: [], confidence: 0 };
}
function asPeerReview(r: { json?: any; text: string }): PeerReview {
  if (r.json && typeof r.json === "object" && "verdict" in r.json) return r.json as PeerReview;
  return { agreements: [], disagreements: [], missingEvidence: [r.text.startsWith("ERROR:") ? "infrastructure failure — review not produced" : "adapter returned unstructured output"], suggestedChanges: [], verdict: "reject", confidence: 0 };
}
function asSynthesis(r: { json?: any; text: string }): Synthesis {
  if (r.json && typeof r.json === "object" && "finalAnswer" in r.json) return r.json as Synthesis;
  return { finalAnswer: r.text || "(no synthesis)", rationale: "", executor: "none", verificationPlan: [], stopConditions: [], openQuestions: [], proposedMemories: [] };
}

/** Load a prior phase's structured result from agent_messages (for resume). */
function loadPhaseMessage(db: UMemDB, taskId: number, agentId: string, kind: string): any | undefined {
  const row = db.db
    .prepare("SELECT body_json FROM agent_messages WHERE task_id=? AND from_agent=? AND kind=? ORDER BY id DESC LIMIT 1")
    .get(taskId, agentId, kind) as { body_json: string } | undefined;
  return row ? JSON.parse(row.body_json) : undefined;
}

export async function runCouncil(db: UMemDB, claude: AgentAdapter, codex: AgentAdapter, opts: CouncilOpts): Promise<CouncilResult> {
  const constraints = opts.constraints ?? [];
  const ts = nowIso();
  // 1) task
  let taskId = opts.resumeTaskId ?? 0;
  if (!taskId) {
    const info = db.db
      .prepare(`INSERT INTO tasks(title, question, project_key, mode, status, phase, constraints_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(opts.question.slice(0, 80), opts.question, opts.projectKey ?? null, "council", "running", "independent", JSON.stringify(constraints), ts, ts);
    taskId = Number(info.lastInsertRowid);
    db.audit({ actor: "user", action: "task.create", entityType: "task", entityId: taskId, detail: { mode: "council" } });
  }

  // 2) retrieve memory context (scoped + redacted)
  const hits = search(db, opts.question, { projectKey: opts.projectKey ?? undefined }, opts.memoryLimit ?? 8);
  const memoryRefs: MemoryRef[] = hits.map((h) => ({
    memory_id: h.kind === "memory" ? h.id : undefined,
    source_id: h.provenance.source_id as number | undefined,
    title: h.title,
    snippet: safePreview(h.preview, 140),
  }));
  db.db.prepare(`INSERT INTO agent_messages(task_id, seq, kind, from_agent, body_json, created_at) VALUES (?,?,?,?,?,?)`)
    .run(taskId, 0, "task_packet", "orchestrator", JSON.stringify({ question: opts.question, projectKey: opts.projectKey, constraints, memoryRefs }), nowIso());

  const basePacket: TaskPacket = { taskId, question: opts.question, projectKey: opts.projectKey ?? null, constraints, memoryRefs, phase: "independent" };

  // 3) INDEPENDENT analysis (parallel, no cross-talk) — with resume
  log.info("council.independent", { taskId });
  const [claudeRes, codexRes] = await Promise.all([
    resumeOr(db, taskId, claude.id, "agent_result", () => runPhase(db, taskId, claude, "analyst", "independent", analystPrompt(basePacket, claude.displayName), AGENT_RESULT_SCHEMA, SYS_ANALYST, "agent_result", asAgentResult)),
    resumeOr(db, taskId, codex.id, "agent_result", () => runPhase(db, taskId, codex, "analyst", "independent", analystPrompt(basePacket, codex.displayName), AGENT_RESULT_SCHEMA, SYS_ANALYST, "agent_result", asAgentResult)),
  ]);
  db.db.prepare("UPDATE tasks SET phase='review', updated_at=? WHERE id=?").run(nowIso(), taskId);

  // 4) CROSS-REVIEW (each reviews the other's result)
  log.info("council.review", { taskId });
  const claudeReviewPacket: TaskPacket = { ...basePacket, phase: "review", peerResult: codexRes, peerName: codex.displayName };
  const codexReviewPacket: TaskPacket = { ...basePacket, phase: "review", peerResult: claudeRes, peerName: claude.displayName };
  const [claudeReviewOfCodex, codexReviewOfClaude] = await Promise.all([
    resumeOr(db, taskId, claude.id, "peer_review", () => runPhase(db, taskId, claude, "reviewer", "review", reviewPrompt(claudeReviewPacket, claude.displayName), PEER_REVIEW_SCHEMA, SYS_REVIEWER, "peer_review", asPeerReview)),
    resumeOr(db, taskId, codex.id, "peer_review", () => runPhase(db, taskId, codex, "reviewer", "review", reviewPrompt(codexReviewPacket, codex.displayName), PEER_REVIEW_SCHEMA, SYS_REVIEWER, "peer_review", asPeerReview)),
  ]);
  db.db.prepare("UPDATE tasks SET phase='synthesis', updated_at=? WHERE id=?").run(nowIso(), taskId);

  // 5) SYNTHESIS (coordinator; one agent drafts, orchestrator owns the record)
  log.info("council.synthesis", { taskId });
  const synthAgent = opts.synthesizer === "codex" ? codex : claude;
  const synthesis = await resumeOr(db, taskId, synthAgent.id, "synthesis", () =>
    runPhase(db, taskId, synthAgent, "synthesizer", "synthesis", synthPrompt(opts.question, claudeRes, codexRes, claudeReviewOfCodex, codexReviewOfClaude), SYNTHESIS_SCHEMA, SYS_SYNTH, "synthesis", asSynthesis),
  );

  // 6) finalize
  const finalArt = db.db.prepare("SELECT id FROM artifacts WHERE task_id=? AND kind='synthesis' ORDER BY id DESC LIMIT 1").get(taskId) as any;
  db.db.prepare("UPDATE tasks SET status='done', phase='done', result_ref=?, updated_at=? WHERE id=?").run(finalArt?.id ?? null, nowIso(), taskId);
  db.audit({ actor: "orchestrator", action: "task.done", entityType: "task", entityId: taskId, detail: { executor: synthesis.executor, proposedMemories: synthesis.proposedMemories.length } });

  return { taskId, question: opts.question, memoryRefs, claude: claudeRes, codex: codexRes, claudeReviewOfCodex, codexReviewOfClaude, synthesis };
}

// run one adapter phase, record it, and coerce the output
async function runPhase<T>(
  db: UMemDB,
  taskId: number,
  agent: AgentAdapter,
  role: string,
  phase: string,
  prompt: string,
  schema: object,
  system: string,
  kind: string,
  coerce: (r: { json?: any; text: string }) => T,
): Promise<T> {
  const started = nowIso();
  try {
    const r = await agent.complete(prompt, { schema, systemPrompt: system });
    const ended = nowIso();
    recordRun(db, taskId, agent, role, phase, started, ended, r, kind, true);
    return coerce(r);
  } catch (e: any) {
    const ended = nowIso();
    recordRun(db, taskId, agent, role, phase, started, ended, { text: String(e?.message ?? e), adapter: agent.id }, kind, false, String(e?.message ?? e));
    log.error("council.phase.fail", { agent: agent.id, phase, err: String(e?.message ?? e) });
    return coerce({ text: `ERROR: ${e?.message ?? e}` });
  }
}

// resume helper: if a prior structured message of (agent, kind) exists, reuse it
async function resumeOr<T>(db: UMemDB, taskId: number, agentId: string, kind: string, fn: () => Promise<T>): Promise<T> {
  const prior = loadPhaseMessage(db, taskId, agentId, kind);
  if (prior && (("answer" in prior) || ("verdict" in prior) || ("finalAnswer" in prior))) {
    log.info("council.resume", { taskId, agentId, kind });
    return prior as T;
  }
  return fn();
}
