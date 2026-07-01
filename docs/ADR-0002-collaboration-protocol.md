# ADR-0002: Collaboration protocol & single-writer guarantee

_Status: accepted · 2026-07-01_

## Context
Two independent agents (Claude, Codex) must answer one question without anchoring on each other, then critique and reconcile. When code changes are involved, **two agents must never write the same workspace concurrently** — a hard acceptance criterion, not a best-effort convention.

## Decision

### Structured message protocol
Four typed shapes, each with a JSON Schema handed to the CLIs (`claude --json-schema`, `codex --output-schema`) so output is validated, not parsed heuristically:
- `TaskPacket` — question, project, constraints, retrieved memory refs, workspace state, phase.
- `AgentResult` — answer, claims, evidence, assumptions, risks, plan, confidence.
- `PeerReview` — agreements, disagreements, missingEvidence, suggestedChanges, verdict.
- `Synthesis` — finalAnswer, rationale, executor, verificationPlan, stopConditions, openQuestions, proposedMemories.

### Flow (council)
`retrieve → independent (parallel, no cross-talk) → cross-review → synthesis`. Independence is enforced by running both analyses in parallel with no shared context beyond the identical `TaskPacket`. Every step is persisted to `agent_runs` / `agent_messages` / `artifacts`; the task carries `phase` for **resume** (completed phases are reused, never re-run).

### Single-writer lease (structural)
`worktree_leases` has a **partial unique index**: `UNIQUE(workspace_path) WHERE status='held'`. Acquiring a lease is an `INSERT`; a second acquire on a held workspace violates the constraint and throws `LeaseHeldError` **at the database layer**. It is therefore *impossible* to hold two write leases on one workspace — the guarantee doesn't depend on orchestrator correctness. `withWriteLease()` always releases (even on throw). Verified in tests + demo.

**Crash recovery.** A `finally` release doesn't run on `SIGKILL`/panic/power-loss, which would leave a `held` row forever and brick the workspace. So each lease records its holder `pid`, and `acquireLease` first calls `reclaimStaleLeases()`, which marks `held` leases `reclaimed` when their pid is provably dead on this machine (`process.kill(pid, 0)` → `ESRCH`). A live long-running holder is never stolen; PID reuse can only keep a stale lease held slightly longer (a safe failure, never a double-write). Verified with a dead-pid regression test.

### Task modes
- `council` — analysis only; no workspace writes. **Implemented.**
- `builder-reviewer` — the synthesizer names one `executor`; that agent holds the lease and writes, the other reviews + runs verification; ≤3 fix rounds. **Lease + flow defined; execution loop is the next slice.**
- `tournament` — each agent implements in its **own git worktree** (separate checkouts → no shared write target), then tests/review pick a winner. **Lease model in place; worktree provisioning is the next slice.**

### SQLite as the bus
For MVP the DB is also the task queue + event log. Simpler than Redis/broker, fully auditable, crash-safe (run-state persisted). Revisit if concurrency outgrows single-node.

## Consequences
- ✅ Independent-then-adversarial reduces single-model blind spots; disagreements are first-class data.
- ✅ Double-write is structurally impossible, not merely avoided.
- ✅ Resumable, fully auditable runs.
- ⚠️ Synthesis is currently drafted by one agent (configurable) with the orchestrator owning the record; a neutral third-model arbiter is a possible upgrade.
- ⚠️ Mock adapters make divergence deterministic for the demo; real disagreement quality depends on the live models.
