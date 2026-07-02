import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInputFrame, banner, repaintPrefix } from "../src/cli/prompt-box.ts";
import { dispWidth, stripAnsi } from "../src/cli/render.ts";

test("input frame: box rows are equal display width", () => {
  const f = buildInputFrame({ text: "计算机的N和NP", cursor: 7, totalWidth: 80, label: "问点什么" });
  const w = dispWidth(stripAnsi(f.lines[0]!));
  // top, input, bottom same width (hint row excluded)
  for (const row of f.lines.slice(0, 3)) assert.equal(dispWidth(stripAnsi(row)), w, `row "${stripAnsi(row)}"`);
});

test("input frame: cursor column tracks CJK width", () => {
  const f0 = buildInputFrame({ text: "中文", cursor: 0, totalWidth: 80 });
  const f2 = buildInputFrame({ text: "中文", cursor: 2, totalWidth: 80 });
  // prefix "│ › " = 4 columns; after two CJK chars (4 cols) cursor at 8
  assert.equal(f0.cursorCol, 4);
  assert.equal(f2.cursorCol, 8);
  assert.equal(f0.cursorRow, 1);
});

test("input frame: placeholder shown only when empty", () => {
  const empty = buildInputFrame({ text: "", cursor: 0, totalWidth: 80, placeholder: "输入问题" });
  const typed = buildInputFrame({ text: "x", cursor: 1, totalWidth: 80, placeholder: "输入问题" });
  assert.ok(stripAnsi(empty.lines[1]!).includes("输入问题"));
  assert.ok(!stripAnsi(typed.lines[1]!).includes("输入问题"));
});

test("input frame: horizontal scroll keeps cursor visible for long input", () => {
  const long = "a".repeat(300);
  const f = buildInputFrame({ text: long, cursor: 300, totalWidth: 60 });
  const w = dispWidth(stripAnsi(f.lines[1]!));
  assert.equal(dispWidth(stripAnsi(f.lines[0]!)), w, "input row not wider than box");
  // cursor stays within the box interior
  assert.ok(f.cursorCol < 60, `cursor col ${f.cursorCol} within box`);
});

// Regression: backspace was erasing prior chat output. The repaint must move up
// by the CURSOR ROW (1, the input line), never by the frame height (4 → climbs
// 2 rows above the box and the clear-down eats history).
test("repaintPrefix moves up by cursor row, not frame height", () => {
  assert.equal(repaintPrefix(4, 1), "\r\x1b[1A\x1b[0J", "re-render from input row: up exactly 1");
  assert.equal(repaintPrefix(0, 0), "\x1b[0J", "first paint: no cursor movement");
  assert.equal(repaintPrefix(4, 0), "\r\x1b[0J", "cursor already on first row: no up-move");
  assert.ok(!repaintPrefix(4, 1).includes("[3A"), "the old buggy overshoot is gone");
});

test("banner renders a rounded box with equal-width rows", () => {
  const b = banner("Claude sonnet ‖ Codex gpt-5.5", 90);
  const rows = b.split("\n");
  const w = dispWidth(stripAnsi(rows[0]!));
  for (const row of rows) assert.equal(dispWidth(stripAnsi(row)), w, `banner row "${stripAnsi(row)}"`);
  assert.ok(stripAnsi(b).includes("ccc"));
});
