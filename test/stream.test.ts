import { test } from "node:test";
import assert from "node:assert/strict";
import { runStream } from "../src/agents/spawn.ts";
import { MockAdapter } from "../src/agents/adapter.ts";
import { renderPanel, dispWidth, stripAnsi } from "../src/cli/render.ts";

test("runStream delivers complete lines incrementally and flushes the tail", async () => {
  const lines: string[] = [];
  // printf without trailing newline exercises the close-flush path
  const r = await runStream("printf", ["a\\nbb\\nccc"], { onLine: (l) => lines.push(l) });
  assert.equal(r.code, 0);
  assert.deepEqual(lines, ["a", "bb", "ccc"]);
});

test("runStream survives a consumer that throws", async () => {
  let n = 0;
  const r = await runStream("printf", ["x\\ny\\n"], { onLine: () => { n++; throw new Error("boom"); } });
  assert.equal(r.code, 0);
  assert.equal(n, 2, "both lines still delivered");
});

test("mock stream: text grows monotonically and final equals resolved text", async () => {
  const m = new MockAdapter("claude");
  const seen: string[] = [];
  const res = await m.stream!("Question: 测试", {}, (u) => seen.push(u.text));
  assert.ok(seen.length > 3, "multiple incremental updates");
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i]!.startsWith(seen[i - 1]!), "each update extends the previous");
  }
  assert.equal(seen[seen.length - 1], res.text);
});

test("renderPanel tail mode caps body height and shows ellipsis", () => {
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const rows = renderPanel({ title: "T", body }, 40, 8);
  // top + 8 body rows + bottom = 10
  assert.equal(rows.length, 10);
  assert.ok(stripAnsi(rows[1]!).includes("前文"), "ellipsis row present");
  for (const r of rows) assert.equal(dispWidth(stripAnsi(r)), 40);
});

test("renderPanel without tail keeps all lines", () => {
  const body = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n");
  const rows = renderPanel({ title: "T", body }, 40);
  assert.equal(rows.length, 14); // top + 12 + bottom
});
