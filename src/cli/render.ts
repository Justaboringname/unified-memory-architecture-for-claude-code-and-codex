// ============================================================================
// Terminal two-column renderer for `ccc` — display-width aware (CJK chars
// occupy 2 terminal columns), ANSI-safe, degrades to stacked panels on narrow
// terminals. Pure functions, unit-tested.
// ============================================================================

export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  orange: "\x1b[38;5;208m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip ANSI escapes (for width math). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Display width of one code point (wide CJK/fullwidth = 2, else 1). */
function cpWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // hangul jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // kana, CJK symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+
  )
    return 2;
  return 1;
}

/** Display width of a string (ANSI stripped, CJK = 2 cols). */
export function dispWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += cpWidth(ch.codePointAt(0)!);
  return w;
}

/** Pad (display-width aware) to exactly `width` columns. Truncates if longer. */
export function padDisplay(s: string, width: number): string {
  const w = dispWidth(s);
  if (w <= width) return s + " ".repeat(width - w);
  // truncate (keep ANSI out of the picture for simplicity: strip, cut, no color)
  let out = "";
  let acc = 0;
  for (const ch of stripAnsi(s)) {
    const cw = cpWidth(ch.codePointAt(0)!);
    if (acc + cw > width - 1) break;
    out += ch;
    acc += cw;
  }
  return out + "…" + " ".repeat(Math.max(0, width - acc - 1));
}

/**
 * Wrap text to `width` display columns. Preserves paragraph breaks; breaks
 * latin words at spaces when possible; CJK breaks anywhere.
 */
export function wrapDisplay(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n/g, "\n").split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    let lineW = 0;
    let lastSpaceIdx = -1; // index in `line` of last breakable space
    for (const ch of para) {
      const cw = cpWidth(ch.codePointAt(0)!);
      if (lineW + cw > width) {
        if (ch === " ") {
          out.push(line);
          line = "";
          lineW = 0;
          lastSpaceIdx = -1;
          continue;
        }
        if (lastSpaceIdx > 0 && cw === 1) {
          // break latin word at the last space
          out.push(line.slice(0, lastSpaceIdx));
          line = line.slice(lastSpaceIdx + 1);
          lineW = dispWidth(line);
          lastSpaceIdx = -1;
        } else {
          out.push(line);
          line = "";
          lineW = 0;
          lastSpaceIdx = -1;
        }
      }
      line += ch;
      lineW += cw;
      if (ch === " ") lastSpaceIdx = line.length - 1;
    }
    out.push(line);
  }
  return out;
}

export interface Panel {
  title: string; // plain text (color applied internally)
  titleColor?: string; // ANSI color code for the title
  body: string;
  footer?: string; // e.g. "⏱ 42s · $0.31"
}

/**
 * Render one framed panel at `width` total columns. With `tailLines`, only the
 * last N body lines are shown (live-streaming view), with a dim ellipsis row.
 */
export function renderPanel(p: Panel, width: number, tailLines?: number): string[] {
  const inner = width - 4; // "│ " + " │"
  const d = ANSI.dim;
  const r = ANSI.reset;
  const tc = p.titleColor ?? "";
  const title = ` ${p.title} `;
  const tW = dispWidth(title);
  const dashRight = Math.max(0, width - 3 - tW);
  const lines: string[] = [];
  lines.push(`${d}╭─${r}${tc}${ANSI.bold}${padDisplay(title, Math.min(tW, width - 3))}${r}${d}${"─".repeat(dashRight)}╮${r}`);
  let body = wrapDisplay(p.body, inner);
  if (tailLines != null && body.length > tailLines) {
    body = [`${ANSI.gray}…(前文 ${body.length - tailLines + 1} 行)${ANSI.reset}`, ...body.slice(-(tailLines - 1))];
  }
  for (const l of body) {
    lines.push(`${d}│${r} ${padDisplay(l, inner)} ${d}│${r}`);
  }
  if (p.footer) {
    lines.push(`${d}├${"─".repeat(width - 2)}┤${r}`);
    lines.push(`${d}│${r} ${ANSI.gray}${padDisplay(p.footer, inner)}${r} ${d}│${r}`);
  }
  lines.push(`${d}╰${"─".repeat(width - 2)}╯${r}`);
  return lines;
}

/**
 * Render two panels side by side (or stacked when the terminal is narrow).
 * Returns the full string ready to print.
 */
export function renderSideBySide(left: Panel, right: Panel, termWidth: number, tailLines?: number): string {
  const gap = 2;
  if (termWidth < 90) {
    // stacked fallback
    const w = Math.max(40, Math.min(termWidth, 100));
    return [...renderPanel(left, w, tailLines), "", ...renderPanel(right, w, tailLines)].join("\n");
  }
  const colW = Math.floor((Math.min(termWidth, 190) - gap) / 2);
  const L = renderPanel(left, colW, tailLines);
  const R = renderPanel(right, colW, tailLines);
  const n = Math.max(L.length, R.length);
  const blankL = " ".repeat(colW);
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(`${L[i] ?? blankL}${" ".repeat(gap)}${R[i] ?? ""}`);
  }
  return rows.join("\n");
}
