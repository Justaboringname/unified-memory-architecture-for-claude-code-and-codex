import { test } from "node:test";
import assert from "node:assert/strict";
import { seededDb } from "./helpers.ts";
import { search } from "../src/search/search.ts";

test("2-char CJK term is findable (LIKE recall net past trigram's >=3 floor)", async () => {
  const { db, cleanup } = await seededDb();
  try {
    const hits = search(db, "索引", {}, 5);
    assert.ok(hits.length >= 1, "索引 (2 chars) must be found");
    assert.ok(hits.some((h) => h.matchType === "like"));
  } finally { cleanup(); }
});

test("English keyword hits FTS (trigram)", async () => {
  const { db, cleanup } = await seededDb();
  try {
    const hits = search(db, "flywheel", {}, 5);
    assert.ok(hits.some((h) => h.matchType === "fts"));
  } finally { cleanup(); }
});

test("natural-language question is tokenized, not phrase-matched", async () => {
  const { db, cleanup } = await seededDb();
  try {
    const hits = search(db, "How should I tune the flywheel shooter for foam balls?", {}, 5);
    assert.ok(hits.length >= 1, "keyword tokenization finds the relevant messages/memory");
  } finally { cleanup(); }
});

test("scope filters restrict results", async () => {
  const { db, cleanup } = await seededDb();
  try {
    const all = search(db, "flywheel", {}, 10);
    const human = search(db, "flywheel", { role: "human" }, 10);
    const assistant = search(db, "flywheel", { role: "assistant" }, 10);
    assert.ok(all.length >= human.length);
    // human asked about flywheel; assistant answered about hood angle — role scope must differ
    assert.notEqual(human.length, 0);
    assert.ok(human.every((h) => h.role === "human" || h.kind === "memory"));
  } finally { cleanup(); }
});

test("project doc content is searchable", async () => {
  const { db, cleanup } = await seededDb();
  try {
    const hits = search(db, "dumper efficiency", {}, 5);
    assert.ok(hits.length >= 1, "project doc indexed and retrievable");
  } finally { cleanup(); }
});

test("FTS special characters do not crash the query", async () => {
  const { db, cleanup } = await seededDb();
  try {
    for (const q of ['"', "a AND b", "foo(bar)", "* OR *", "NEAR/3"]) {
      assert.doesNotThrow(() => search(db, q, {}, 3));
    }
  } finally { cleanup(); }
});
