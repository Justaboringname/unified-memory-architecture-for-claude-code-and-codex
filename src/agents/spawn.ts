import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a command with optional stdin + timeout. Never rejects on non-zero exit. */
export function run(
  cmd: string,
  args: string[],
  opts: { stdin?: string; cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + `\n[spawn error] ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (opts.stdin != null) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

/** True if a binary is resolvable + responds to --version quickly. */
export async function binaryAvailable(cmd: string): Promise<boolean> {
  const r = await run(cmd, ["--version"], { timeoutMs: 8000 });
  return r.code === 0;
}

export interface StreamRunResult {
  code: number | null;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a command and deliver each complete stdout LINE to `onLine` as it
 * arrives (JSONL streaming). Never rejects on non-zero exit.
 */
export function runStream(
  cmd: string,
  args: string[],
  opts: { stdin?: string; cwd?: string; timeoutMs?: number; onLine: (line: string) => void },
): Promise<StreamRunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: process.env });
    let stderr = "";
    let timedOut = false;
    let buf = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          try { opts.onLine(line); } catch { /* consumer errors must not kill the stream */ }
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stderr: stderr + `\n[spawn error] ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (buf.trim()) { try { opts.onLine(buf); } catch { /* ignore */ } }
      resolve({ code, stderr, timedOut });
    });
    if (opts.stdin != null) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}
