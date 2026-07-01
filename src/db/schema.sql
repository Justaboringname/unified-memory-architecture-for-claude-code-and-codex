-- ============================================================================
-- Unified Memory — SQLite schema (MVP)
--
-- Layering (see docs/ADR-0003-privacy-model.md):
--   * RAW ARCHIVE (evidence layer): `sources` + `conversations` + `messages`
--     store content AS-IS. Access is gated by living in the gitignored `data/`
--     dir. We do NOT scrub secrets out of raw messages — that would destroy the
--     evidence layer. Secrets/PII scrubbing applies to DERIVED artifacts, logs,
--     and test fixtures only.
--   * DERIVED KNOWLEDGE (revocable): `memory_items` + `memory_versions`.
--   * COLLABORATION (auditable): `tasks`, `agent_runs`, `agent_messages`,
--     `artifacts`, `worktree_leases`.
--   * PROVENANCE + SAFETY: every derived row keeps a pointer back to its
--     `source`. `audit_log` records every mutation. `import_checkpoints` make
--     import idempotent + resumable.
--
-- Retrieval: FTS5 with the `trigram` tokenizer (handles English + CJK
--   substrings >= 3 chars). The search layer adds a LIKE recall net for short
--   (<=2 char) CJK terms, which trigram cannot match. See ADR-0001.
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Schema version marker so migrations are deterministic.
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- SOURCES — immutable provenance. One row per ingested file / logical origin.
-- We never rewrite the original file; we record how to find it + a content hash
-- so we can prove what we indexed and detect drift on re-import.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id            INTEGER PRIMARY KEY,
  provider      TEXT NOT NULL,            -- 'claude-web' | 'claude-code' | 'codex' | 'user'
  source_type   TEXT NOT NULL,            -- 'conversation'|'account_memory'|'project_doc'|
                                          -- 'design_chat'|'user_profile'|'claude_md'|
                                          -- 'cc_memory'|'cc_session'
  project_key   TEXT,                     -- logical project slug, if any
  external_id   TEXT,                     -- conversation / session / doc uuid
  file_path     TEXT NOT NULL,            -- absolute path to the ORIGINAL (read-only)
  content_hash  TEXT NOT NULL,            -- sha256 of the original bytes/segment
  byte_size     INTEGER,
  origin_ts     TEXT,                     -- source's own timestamp (ISO8601) if known
  imported_at   TEXT NOT NULL,
  sensitivity   TEXT NOT NULL DEFAULT 'normal',  -- 'normal'|'sensitive'|'secret'
  ingested      INTEGER NOT NULL DEFAULT 1,      -- 0 = recorded-but-content-not-ingested
                                                 --     (e.g. users.json: PII, path+hash only)
  meta_json     TEXT,
  UNIQUE (provider, source_type, file_path, external_id)
);
CREATE INDEX IF NOT EXISTS idx_sources_provider ON sources(provider, source_type);
CREATE INDEX IF NOT EXISTS idx_sources_project  ON sources(project_key);

-- ---------------------------------------------------------------------------
-- PROJECTS — logical grouping across providers.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY,
  provider     TEXT NOT NULL,
  external_id  TEXT,                      -- provider project uuid, or NULL for local
  project_key  TEXT NOT NULL,             -- stable slug used for scoping
  name         TEXT,
  description  TEXT,
  root_path    TEXT,                      -- local repo root, if applicable
  created_at   TEXT,
  updated_at   TEXT,
  meta_json    TEXT,
  UNIQUE (provider, project_key)
);

-- ---------------------------------------------------------------------------
-- CONVERSATIONS — a thread of messages (web export conv, design chat, or a
-- Claude Code session).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id            INTEGER PRIMARY KEY,
  source_id     INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  external_uuid TEXT,                     -- conversation/session uuid
  project_id    INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  project_key   TEXT,
  title         TEXT,
  summary       TEXT,                     -- provider-supplied summary (derived, revocable)
  created_at    TEXT,
  updated_at    TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  meta_json     TEXT,
  UNIQUE (provider, external_uuid)
);
CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_key);
CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at);

-- ---------------------------------------------------------------------------
-- MESSAGES — the raw evidence layer. `text` is stored AS-IS.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_id       INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_uuid   TEXT,
  message_key     TEXT,                   -- dedup key (message.id for cc sessions)
  role            TEXT NOT NULL,          -- 'human'|'user'|'assistant'|'system'|'tool'
  seq             INTEGER NOT NULL DEFAULT 0,   -- order within conversation
  text            TEXT NOT NULL DEFAULT '',
  created_at      TEXT,
  parent_uuid     TEXT,
  char_len        INTEGER NOT NULL DEFAULT 0,
  sensitivity     TEXT NOT NULL DEFAULT 'normal',  -- heuristic flag (does NOT scrub text)
  meta_json       TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_msg_role ON messages(role);
-- Partial uniqueness for cc-session dedup: same message_key never inserted twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_dedup
  ON messages(source_id, message_key) WHERE message_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- FTS — trigram index over message text. Standalone (not external-content) so
-- the importer manages it directly inside the same transaction. `message_id`
-- is UNINDEXED (stored, not tokenized). See search layer for the LIKE net.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(
  message_id UNINDEXED,
  body,
  tokenize = 'trigram'
);

-- ---------------------------------------------------------------------------
-- MEMORY ITEMS — derived, typed, revocable knowledge.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_items (
  id              INTEGER PRIMARY KEY,
  mem_type        TEXT NOT NULL,          -- instruction|semantic|decision|episodic|
                                          -- procedural|working
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'global',  -- 'global'|'project'|'task'
  scope_ref       TEXT,                   -- project_key or task id when scoped
  confidence      REAL NOT NULL DEFAULT 0.6,       -- 0..1
  sensitivity     TEXT NOT NULL DEFAULT 'normal',  -- 'normal'|'sensitive'|'secret'
  status          TEXT NOT NULL DEFAULT 'proposed',-- proposed|active|superseded|forgotten
  valid_from      TEXT,
  valid_until     TEXT,
  source_refs     TEXT,                   -- JSON array of {source_id, message_id?, note?}
  created_by      TEXT NOT NULL DEFAULT 'system',  -- 'user'|'claude'|'codex'|'import'|'system'
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  meta_json       TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_type   ON memory_items(mem_type);
CREATE INDEX IF NOT EXISTS idx_mem_scope  ON memory_items(scope, scope_ref);
CREATE INDEX IF NOT EXISTS idx_mem_status ON memory_items(status);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_memory USING fts5(
  memory_id UNINDEXED,
  title,
  body,
  tokenize = 'trigram'
);

-- ---------------------------------------------------------------------------
-- MEMORY VERSIONS — append-only history. Every propose/update/confirm/forget
-- writes a version. Enables undo, audit, and "what did we know when".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_versions (
  id           INTEGER PRIMARY KEY,
  memory_id    INTEGER NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  change_type  TEXT NOT NULL,            -- propose|update|confirm|forget|restore
  status_after TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  confidence   REAL,
  author       TEXT NOT NULL,            -- 'user'|'claude'|'codex'|'import'|'system'
  rationale    TEXT,
  prev_hash    TEXT,                     -- sha256 of prior version row (tamper-evident chain)
  created_at   TEXT NOT NULL,
  meta_json    TEXT,
  UNIQUE (memory_id, version)
);

-- ---------------------------------------------------------------------------
-- TASKS — one collaboration run driven by a user question.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id               INTEGER PRIMARY KEY,
  title            TEXT,
  question         TEXT NOT NULL,
  project_id       INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  project_key      TEXT,
  mode             TEXT NOT NULL DEFAULT 'council',  -- council|builder-reviewer|tournament
  status           TEXT NOT NULL DEFAULT 'created',  -- created|running|blocked|done|failed|cancelled
  phase            TEXT,                             -- current phase label (for resume)
  constraints_json TEXT,
  workspace_path   TEXT,
  builder_agent    TEXT,                             -- which agent holds the write role
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  result_ref       INTEGER,                          -- artifact id of final synthesis
  meta_json        TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_status ON tasks(status);

-- ---------------------------------------------------------------------------
-- AGENT RUNS — one invocation of one agent in one phase. Cost + timing audit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_runs (
  id           INTEGER PRIMARY KEY,
  task_id      INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent        TEXT NOT NULL,            -- 'claude'|'codex'|'mock-claude'|'mock-codex'
  role         TEXT NOT NULL,            -- 'analyst'|'reviewer'|'builder'|'synthesizer'|'verifier'
  phase        TEXT NOT NULL,            -- 'independent'|'review'|'synthesis'|'execute'|'verify'
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed|skipped
  model        TEXT,
  adapter      TEXT,                     -- adapter id used
  started_at   TEXT,
  ended_at     TEXT,
  duration_ms  INTEGER,
  cost_json    TEXT,                     -- {usd?, tokens?} if the adapter reports it
  input_ref    INTEGER,                  -- artifact id (task packet given)
  output_ref   INTEGER,                  -- artifact id (structured result)
  error        TEXT,
  meta_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_task ON agent_runs(task_id, phase);

-- ---------------------------------------------------------------------------
-- AGENT MESSAGES — the structured collaboration bus. Every TaskPacket /
-- AgentResult / PeerReview / Synthesis passed between agents is a row here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_messages (
  id          INTEGER PRIMARY KEY,
  task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id      INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
  seq         INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL,            -- task_packet|agent_result|peer_review|synthesis|note
  from_agent  TEXT NOT NULL,           -- 'orchestrator'|'claude'|'codex'|...
  to_agent    TEXT,                    -- recipient or NULL for broadcast
  body_json   TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_amsg_task ON agent_messages(task_id, seq);

-- ---------------------------------------------------------------------------
-- ARTIFACTS — any produced blob (analysis, review, synthesis, patch, test log).
-- Stored inline for small text; large blobs kept on disk under data/ with a path.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifacts (
  id          INTEGER PRIMARY KEY,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  run_id      INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,           -- analysis|review|synthesis|patch|test-output|file|packet
  body        TEXT,                    -- inline content (small)
  file_path   TEXT,                    -- on-disk path (large / binary)
  content_hash TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  created_at  TEXT NOT NULL,
  meta_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_artifact_task ON artifacts(task_id, kind);

-- ---------------------------------------------------------------------------
-- WORKTREE LEASES — STRUCTURAL single-writer guarantee.
-- A partial UNIQUE index makes it *impossible* for two runs to hold a write
-- lease on the same workspace at once: a second acquire violates the unique
-- constraint and throws. (Acceptance criterion: never two agents writing one
-- worktree.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS worktree_leases (
  id             INTEGER PRIMARY KEY,
  task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_path TEXT NOT NULL,
  holder_agent   TEXT NOT NULL,
  holder_run_id  INTEGER,
  holder_pid     INTEGER,                        -- OS pid of the holder, for crash reclaim
  status         TEXT NOT NULL DEFAULT 'held',   -- 'held'|'released'|'reclaimed'
  acquired_at    TEXT NOT NULL,
  released_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lease_one_writer
  ON worktree_leases(workspace_path) WHERE status = 'held';

-- ---------------------------------------------------------------------------
-- IMPORT CHECKPOINTS — idempotent + resumable import. Keyed by logical unit
-- (e.g. one conversation uuid). Re-running import skips unchanged units and
-- re-imports changed ones (content_hash mismatch).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_checkpoints (
  id           INTEGER PRIMARY KEY,
  unit_type    TEXT NOT NULL,           -- 'conversation'|'session'|'memory_md'|'claude_md'|...
  unit_key     TEXT NOT NULL,           -- uuid / path
  content_hash TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'done',  -- 'done'|'partial'|'failed'
  n_messages   INTEGER DEFAULT 0,
  imported_at  TEXT NOT NULL,
  meta_json    TEXT,
  UNIQUE (unit_type, unit_key)
);

-- ---------------------------------------------------------------------------
-- AUDIT LOG — append-only record of every mutation worth tracing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL,
  actor       TEXT NOT NULL,           -- 'user'|'claude'|'codex'|'import'|'system'|'mcp'
  action      TEXT NOT NULL,           -- e.g. 'memory.propose','memory.update','lease.acquire'
  entity_type TEXT,
  entity_id   TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
