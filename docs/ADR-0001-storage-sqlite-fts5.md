# ADR-0001: Storage = SQLite + FTS5 (trigram) + LIKE recall net

_Status: accepted · 2026-07-01_

## Context
Corpus: ~1,656 conversations / 19,249 messages + local Claude Code memory/sessions, **heavily bilingual (English + Chinese)**. The brief asks for a local, auditable, low-dependency MVP and explicitly says *don't* vectorize 185 MB up front.

## Decision
Single **SQLite** database (WAL) with **FTS5** for full-text search. Standalone FTS tables (`fts_messages`, `fts_memory`) managed by the importer inside its transactions. No vector DB in v1.

**Tokenizer: `trigram`, with a `LIKE` substring recall net.** Verified empirically before building:
- Default `unicode61` does **not** segment CJK — a Chinese run becomes one token, so only exact-token queries match; substrings fail.
- `trigram` matches any substring **≥ 3 characters** (English words + longer CJK), but **returns 0 for 2-character queries** — and most meaningful Chinese terms are exactly 2 chars (e.g. `索引`, `检索`, `数据`, `会话`).
- Therefore: trigram is the ranked primary; a `LIKE '%term%'` net (per keyword) guarantees recall for short/2-char CJK. The corpus is small enough (~20k rows) that the LIKE scan is <50 ms.

Queries are **tokenized into keywords** (Latin words + CJK runs, minus stopwords) and OR-combined — a natural-language question is not matched as one phrase. FTS input is always quoted/bound (injection- and syntax-safe; tested against `"`, `AND`, `NEAR/3`, etc.).

## Consequences
- ✅ Bilingual retrieval works, including 2-char Chinese terms (tested with a 2-char query, e.g. `索引`).
- ✅ Zero external services; the DB is the store *and* the task/event bus (see ADR-0002). Inspectable with `sqlite3`.
- ✅ Ranking via `bm25()` for FTS hits; LIKE hits scored lower and recency-ordered.
- ⚠️ Trigram indexes are larger than word indexes and LIKE is a scan — fine at this scale, revisit if the corpus grows 10×.
- ⚠️ Lexical only. If real-query evaluation shows lexical gaps, add a **bigram-expanded index** (proper bm25 for 2-char CJK) or **local embeddings** — the latter only offline or with explicit user consent. Raw messages remain the evidence layer; any embedding is a revocable derived layer.

## Alternatives considered
- **Vector DB first** — rejected per brief (premature, opaque, heavy).
- **ICU/jieba tokenizer** — needs a native FTS5 extension (build/dependency cost); deferred.
- **Bigram n-gram indexing now** — more code; the LIKE net covers the 2-char gap for MVP with far less surface area. Documented as the first upgrade if ranking quality on CJK matters.
