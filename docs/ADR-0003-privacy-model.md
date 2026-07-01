# ADR-0003: Privacy model & data layering

_Status: accepted · 2026-07-01_

## Context
The export contains highly sensitive personal, financial, identity, address, education, company, and immigration information. The brief demands: originals read-only; no raw sensitive content in logs/tests/git; no credentials in memory; derived data in the working dir only; delete/undo/audit; no external upload without consent.

## Decision: get the scrubbing direction right

The failure mode is scrubbing the wrong layer. Two directions, both wrong if swapped:

| Layer | Rule | Rationale |
|---|---|---|
| **Raw archive** (`sources`, `conversations`, `messages`) | store content **AS-IS**, never scrub | It's the **evidence layer**. Scrubbing secrets out of raw messages destroys the ground truth. Protected by *access*, not redaction: lives in gitignored `data/`, never committed, never printed. |
| **Derived memory** (`memory_items`) | **block secrets**, gate PII | Memory is distilled, portable, agent-writable — a credential here would leak widely. Secrets are rejected at write time; PII is flagged and requires opt-in. |
| **Logs / test fixtures / reports** | redact + synthetic only | Output surfaces. Logs carry counts/hashes/redacted previews; fixtures are fabricated. |

### Concrete rules
- **Credentials never enter `memory_items`, on any path.** `containsSecret()` (Anthropic/OpenAI/AWS/GitHub/Google/Slack keys, private-key blocks, JWTs, bearer/`key=` assignments) hard-rejects agent/user `propose`/`update` (throws, audited). The **bulk import** paths (CLAUDE.md, auto-memory, project/account docs → derived memory) instead call `stripSecrets()` to **mask credentials** before writing to `memory_items` + FTS, so the file stays searchable minus the secret and the credential lands in no table (the raw file on disk is untouched). Every strip is audited (`memory.secret_stripped`). Defense-in-depth: `memory_get`/search hide the body for both `sensitive` **and** `secret` tiers.
- **PII is soft-flagged** (`sensitive`): emails, SSN, cards, phones, passports, + identity/immigration/financial keywords. Sensitive memory bodies are hidden by default (`memory_get`, search previews); storing global sensitive memory needs `allowSensitive`.
- **`users.json` (pure PII) is recorded as a `source` (path + sha256) with `ingested=0`** — content never loaded. Confirmed on real data (no `users.json` field appears in any message).
- **The DB is a sensitive artifact** → gitignored (`data/`, `*.db`). `config.json` (absolute paths) gitignored; only `config.example.json` is committed.
- **Provenance always retained**: every derived row links back to `source_id`/`message_id`, so you can trace and delete.
- **Delete / undo / audit**: `forget` (soft, history kept), `restore` (undo), append-only `memory_versions` with a prev-hash chain, and `audit_log` for every mutation.
- **No egress without consent**: nothing uploads, calls a third-party embedding API, or leaves the machine. Real Claude/Codex CLI calls are opt-in (adapter must be switched off `mock`) and their auth is the user's, not managed here.

## Consequences
- ✅ Evidence integrity **and** leak-resistance — because they apply to different layers.
- ✅ Tests/logs/reports are safe to share (redacted, synthetic).
- ⚠️ Raw content sits in `data/` in plaintext SQLite. Access-gated, not encrypted-at-rest; OS-level disk encryption is assumed. At-rest encryption (SQLCipher) is a possible hardening step.
- ⚠️ Secret/PII detection is heuristic (regex) — high-recall for common credential formats but not exhaustive; the raw-layer access-gating is the real backstop.
