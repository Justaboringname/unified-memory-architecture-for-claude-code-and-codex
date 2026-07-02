// ============================================================================
// Claude-Code-style bordered input box for the `ccc` REPL.
//
// A raw-mode single-line editor that draws a rounded frame with the cursor
// living INSIDE it, redrawn on each keystroke. CJK-width aware, horizontally
// scrolls when the input outgrows the box, and falls back to plain readline on
// a non-TTY. The pure render math (buildInputFrame) is unit-tested.
// ============================================================================
import { createInterface } from "node:readline/promises";
import { ANSI, dispWidth } from "./render.ts";

interface Cell { ch: string; w: number; }
function toCells(s: string): Cell[] {
  const out: Cell[] = [];
  for (const ch of s) out.push({ ch, w: dispWidth(ch) });
  return out;
}

export interface FrameSpec {
  text: string;
  cursor: number; // code-point index within text
  totalWidth: number; // full terminal columns to occupy
  label?: string; // small label on the top border
  placeholder?: string; // shown dim when text is empty
}

export interface Frame {
  lines: string[]; // rows to print (top, input, bottom, hint)
  cursorRow: number; // 0-based row of the cursor within `lines`
  cursorCol: number; // 0-based column of the cursor
}

const PROMPT = "› ";

/**
 * Build the 3-row box + hint row, and the cursor position. Horizontal scroll
 * keeps the cursor visible. Pure — no I/O.
 */
export function buildInputFrame(spec: FrameSpec): Frame {
  const width = Math.max(24, Math.min(spec.totalWidth, 160));
  const d = ANSI.dim, r = ANSI.reset;
  const prefixCols = 1 /*│*/ + 1 /*space*/ + dispWidth(PROMPT); // "│ › "
  const inner = width - 2; // inside the two vertical bars
  // inside-bars layout: " " + PROMPT + textArea + " "  → textArea = inner - 2 - PROMPT
  const textArea = inner - 2 - dispWidth(PROMPT);

  const cells = toCells(spec.text);
  // clamp cursor
  const cur = Math.max(0, Math.min(spec.cursor, cells.length));
  // width up to cursor
  const widthTo = (i: number) => cells.slice(0, i).reduce((a, c) => a + c.w, 0);

  // horizontal window [start, end) so the cursor is visible in textArea columns
  let start = 0;
  // advance start until cursor column fits
  while (widthTo(cur) - widthTo(start) > textArea) start++;
  // also don't leave dead space if we scrolled but text shrank
  const visible: Cell[] = [];
  let acc = 0;
  for (let i = start; i < cells.length; i++) {
    if (acc + cells[i]!.w > textArea) break;
    visible.push(cells[i]!);
    acc += cells[i]!.w;
  }
  const cursorColInText = widthTo(cur) - widthTo(start);

  const empty = spec.text.length === 0;
  const label = spec.label ? ` ${spec.label} ` : "─";
  const labelW = spec.label ? dispWidth(label) : 0;
  const topDashes = "─".repeat(Math.max(0, width - 2 - labelW - 1));
  const top = `${d}╭─${r}${spec.label ? `${ANSI.gray}${label}${r}` : ""}${d}${topDashes}╮${r}`;

  let content: string;
  if (empty && spec.placeholder) {
    const ph = spec.placeholder.slice(0, textArea);
    content = `${d}${ANSI.gray}${ph}${" ".repeat(Math.max(0, textArea - dispWidth(ph)))}${r}`;
  } else {
    const vis = visible.map((c) => c.ch).join("");
    content = `${vis}${" ".repeat(Math.max(0, textArea - acc))}`;
  }
  const inputLine = `${d}│${r} ${ANSI.bold}${PROMPT}${r}${content} ${d}│${r}`;
  const bottom = `${d}╰${"─".repeat(width - 2)}╯${r}`;
  const hint = `  ${ANSI.gray}⏎ 提问   ⌫ 删除   ← → 移动   ctrl-c 退出${r}`;

  return {
    lines: [top, inputLine, bottom, hint],
    cursorRow: 1,
    cursorCol: prefixCols + cursorColInText,
  };
}

/**
 * Escape prefix that moves the cursor from wherever the last frame left it
 * (row `cursorRow` of the previous frame) back to the frame's FIRST row and
 * clears downward. Moving by the frame height instead of the cursor row is the
 * classic bug that climbs above the frame and erases prior output.
 */
export function repaintPrefix(prevRows: number, cursorRow: number): string {
  if (prevRows <= 0) return "\x1b[0J"; // first paint: nothing above to return to
  return `\r${cursorRow > 0 ? `\x1b[${cursorRow}A` : ""}\x1b[0J`;
}

/** Static Claude-Code-style welcome banner (rounded box). */
export function banner(subtitle: string, totalWidth: number): string {
  const width = Math.max(40, Math.min(totalWidth, 160));
  const d = ANSI.dim, r = ANSI.reset, o = ANSI.orange, c = ANSI.cyan;
  const inner = width - 4;
  const pad = (s: string) => {
    const w = dispWidth(s.replace(/\x1b\[[0-9;]*m/g, ""));
    return s + " ".repeat(Math.max(0, inner - w));
  };
  const rows = [
    `${o}✻${r} ${ANSI.bold}ccc${r}  ${d}—${r}  ${o}Claude Code${r} ${d}‖${r} ${c}Codex${r}`,
    `${d}${subtitle}${r}`,
    ``,
    `${d}提示:直接打字提问,${r}${ANSI.bold}⏎${r}${d} 发送 · 两边并排作答 · 空行或 exit 退出${r}`,
  ];
  const out = [`${d}╭${"─".repeat(width - 2)}╮${r}`];
  for (const row of rows) out.push(`${d}│${r} ${pad(row)} ${d}│${r}`);
  out.push(`${d}╰${"─".repeat(width - 2)}╯${r}`);
  return out.join("\n");
}

/**
 * Read one line inside a live bordered box (raw mode). Resolves to the entered
 * string, or null if the user asked to quit (Ctrl-C / Ctrl-D on empty / exit).
 * Falls back to plain readline when stdin is not a TTY.
 */
export function readBoxedLine(label: string, placeholder: string): Promise<string | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    // non-TTY fallback: plain readline
    const rl = createInterface({ input: stdin, output: stdout });
    return rl.question(`${ANSI.bold}${PROMPT}${ANSI.reset}`).then(
      (a) => { rl.close(); const t = a.trim(); return t && !["exit", "quit", "q"].includes(t.toLowerCase()) ? t : null; },
      () => { rl.close(); return null; },
    );
  }

  return new Promise((resolve) => {
    const chars: string[] = []; // code points
    let cursor = 0;
    let drawn = 0; // rows drawn last time
    let atRow = 0; // row (within the frame) the cursor was left on
    const width = () => stdout.columns || 100;

    const render = () => {
      const frame = buildInputFrame({ text: chars.join(""), cursor, totalWidth: width(), label, placeholder });
      // return to the frame's first row FROM THE CURSOR ROW (not frame height —
      // overshooting climbs into prior output and erases it), then clear down
      let out = repaintPrefix(drawn, atRow);
      out += frame.lines.join("\n");
      // reposition cursor to (cursorRow, cursorCol): we're at the last row now
      const upFromLast = frame.lines.length - 1 - frame.cursorRow;
      if (upFromLast > 0) out += `\x1b[${upFromLast}A`;
      out += "\r";
      if (frame.cursorCol > 0) out += `\x1b[${frame.cursorCol}C`;
      stdout.write(out);
      drawn = frame.lines.length;
      atRow = frame.cursorRow;
    };

    const finish = (val: string | null) => {
      stdin.setRawMode!(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      // move from the cursor row down past the last row, leave a clean line
      const down = drawn - 1 - atRow;
      stdout.write(`\r${down > 0 ? `\x1b[${down}B` : ""}\n`);
      resolve(val);
    };
    // piped/redirected stdin can EOF — without this the box waits forever
    const onEnd = () => finish(null);

    const onData = (buf: Buffer) => {
      const s = buf.toString("utf8");
      for (let i = 0; i < s.length; ) {
        const cp = s.codePointAt(i)!;
        const ch = String.fromCodePoint(cp);
        i += ch.length;
        if (ch === "\x03") return finish(null); // Ctrl-C
        if (ch === "\x04") { if (chars.length === 0) return finish(null); continue; } // Ctrl-D
        if (ch === "\r" || ch === "\n") {
          const text = chars.join("").trim();
          if (!text || ["exit", "quit", "q"].includes(text.toLowerCase())) return finish(null);
          return finish(text);
        }
        if (ch === "\x7f" || ch === "\b") { if (cursor > 0) { chars.splice(cursor - 1, 1); cursor--; } continue; }
        if (ch === "\x15") { chars.length = 0; cursor = 0; continue; } // Ctrl-U
        if (ch === "\x01") { cursor = 0; continue; } // Ctrl-A home
        if (ch === "\x05") { cursor = chars.length; continue; } // Ctrl-E end
        if (ch === "\x1b") {
          // escape sequence: arrows etc.
          const rest = s.slice(i);
          if (rest.startsWith("[C")) { cursor = Math.min(chars.length, cursor + 1); i += 2; continue; }
          if (rest.startsWith("[D")) { cursor = Math.max(0, cursor - 1); i += 2; continue; }
          if (rest.startsWith("[H")) { cursor = 0; i += 2; continue; }
          if (rest.startsWith("[F")) { cursor = chars.length; i += 2; continue; }
          // swallow other CSI sequences
          const m = rest.match(/^\[[0-9;]*[A-Za-z~]/);
          if (m) { i += m[0].length; continue; }
          continue;
        }
        if (cp >= 0x20) { chars.splice(cursor, 0, ch); cursor++; } // printable
      }
      render();
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    render();
  });
}
