// Minimal structured logger. IMPORTANT: never log raw message content — only
// counts, ids, hashes, and redacted summaries. All logs go to stderr so stdout
// stays clean for machine-readable output (MCP stdio, JSON results).
type Level = "debug" | "info" | "warn" | "error";
const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = RANK[(process.env.UMEM_LOG as Level) ?? "info"] ?? 1;

function emit(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (RANK[level] < threshold) return;
  const line = extra ? `${msg} ${JSON.stringify(extra)}` : msg;
  process.stderr.write(`[${level}] ${line}\n`);
}

export const log = {
  debug: (m: string, e?: Record<string, unknown>) => emit("debug", m, e),
  info: (m: string, e?: Record<string, unknown>) => emit("info", m, e),
  warn: (m: string, e?: Record<string, unknown>) => emit("warn", m, e),
  error: (m: string, e?: Record<string, unknown>) => emit("error", m, e),
};
