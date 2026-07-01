# Architecture

_Last updated: 2026-07-01_

Two decoupled components share one SQLite database.

```
                    ┌──────────────────────── unified-memory.db (SQLite/WAL) ────────────────────────┐
                    │                                                                                  │
  RAW ARCHIVE       │  sources ──< conversations ──< messages ──(FTS trigram)── fts_messages           │
  (evidence)        │     provenance: provider, type, path, sha256, external_id, sensitivity           │
                    │                                                                                  │
  DERIVED KNOWLEDGE │  memory_items ──< memory_versions (append-only, hash-chained)                     │
  (revocable)       │     typed · scoped · confidence · sensitivity · status · source_refs             │
                    │     └──(FTS trigram)── fts_memory                                                 │
                    │                                                                                  │
  COLLABORATION     │  tasks ──< agent_runs ──< agent_messages ; artifacts ; worktree_leases            │
  (auditable)       │                                                                                  │
  SAFETY/RESUME     │  import_checkpoints ; audit_log                                                   │
                    └──────────────────────────────────────────────────────────────────────────────────┘
        ▲                                   ▲                                    ▲
        │ importers                         │ search + memory API                │ orchestrator
   ┌────┴─────┐                       ┌─────┴──────┐                      ┌───────┴────────┐
   │ ingest/  │                       │ search/    │  Memory MCP server   │ orchestrator/  │
   │ export + │                       │ memory/    │──(stdio)── Claude ────│ council        │
   │ cc layer │                       └────────────┘            Codex     │ lease (1-writer)│
   └──────────┘                                                           └────────────────┘
```

## Component 1 — Unified memory layer

**Ingest** (`src/ingest/`). Two importers, both **idempotent + resumable** (content-hash checkpoints keyed by conversation uuid / session path):
- `import-claude-export.ts` streams the 193 MB `conversations.json` with `stream-json` (one conversation in memory at a time), plus account memory, projects (docs indexed as project-scoped memories), design chats, and records `users.json` as provenance-only (PII, not ingested).
- `import-claude-code.ts` walks `~/.claude`: global + repo `CLAUDE.md` → instruction memories; `memory/*.md` → typed memories (frontmatter-mapped); session `*.jsonl` → conversations (parses `user`/`assistant` lines; session identity comes from the **filename** — not the first line's `sessionId`, which is the parent's in a fork — and distinct text blocks sharing one `message.id` are **concatenated** in order). Credentials in any imported file are `stripSecrets()`-masked before reaching the derived memory layer.

**Retrieval** (`src/search/`). FTS5 trigram (ranked) + LIKE recall net for short CJK; keyword tokenization; scope filters (provider/project/role/source_type/date/kind). Every hit carries provenance back to its source.

**Memory** (`src/memory/`). Typed, scoped, versioned. Propose→confirm→update→forget→restore, each writing an append-only, hash-chained version. Secret-blocking + PII-gating at write time.

**MCP** (`src/mcp/`). Wraps search + memory as 7 stdio tools. Propose-only for agents; global/active protection.

## Component 2 — Collaboration scheduler

**Protocol** (`src/agents/types.ts`). `TaskPacket → AgentResult → PeerReview → Synthesis`, each with a JSON Schema handed to the CLIs for structured output.

**Adapters** (`src/agents/`). Uniform `complete(prompt, {schema, systemPrompt, workdir, model})`. `MockAdapter` (deterministic, offline), `ClaudeCliAdapter`, `CodexCliAdapter`.

**Orchestrator** (`src/orchestrator/`). `council.ts` runs retrieve → parallel independent analysis → cross-review → synthesis, recording every step to `agent_runs`/`agent_messages`/`artifacts`. Resumable (completed phases reused). `lease.ts` provides the structural single-writer guarantee used by builder-reviewer/tournament.

## Data flow for one council question

1. Orchestrator creates a `task`, retrieves scoped memory (`search`), writes a `task_packet` message.
2. Claude and Codex each `complete()` **in parallel** with `AGENT_RESULT_SCHEMA`; results recorded as `agent_result` messages + artifacts + runs.
3. Each reviews the other's result with `PEER_REVIEW_SCHEMA` → `peer_review` messages.
4. The synthesizer reconciles all four into `SYNTHESIS_SCHEMA` → final artifact; task marked `done`, `result_ref` set.
5. `proposedMemories` are surfaced (not auto-written) for user confirmation.

## Why SQLite is the bus

For an MVP, the same DB is the knowledge store **and** the task/event log. No Redis, no broker. `agent_messages` is the message bus; `agent_runs` the run log; `audit_log` the immutable trail; run-state on `tasks`/`import_checkpoints` gives crash-safe resume. This keeps the whole system inspectable with one `sqlite3` shell.

## Known limitations (honest)

- Sessions ingested are bounded by `--max-sessions` in this pass; full 499 MB ingest is supported but not run by default.
- Retrieval is keyword/lexical (trigram + LIKE). No embeddings yet — added only if lexical proves insufficient on real queries, and only locally or with explicit consent (see ADR-0001).
- builder-reviewer/tournament execution loops are interfaces over the working lease, not full implementations.
- Codex token/cost parsing is best-effort from the JSONL event stream; Claude cost comes from `total_cost_usd`.
