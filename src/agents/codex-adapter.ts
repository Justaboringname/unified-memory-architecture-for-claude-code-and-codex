import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, CompleteOpts, CompleteResult } from "./adapter.ts";
import { run, binaryAvailable } from "./spawn.ts";

/**
 * Codex CLI headless adapter.
 *   codex exec --json [--model] [-C <workdir>] [--skip-git-repo-check]
 *              [--output-schema <file>] --output-last-message <file> -
 * Prompt on stdin ("-"). Final structured message read from --output-last-message.
 * Sandbox defaults to read-only for analysis; builder mode passes -s workspace-write.
 *
 * NOTE: requires an authenticated `codex` CLI; real runs may incur cost. Prefer
 * the mock adapter until the user authorises real runs.
 */
export class CodexCliAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  readonly id = "codex";
  readonly displayName: string;
  private model?: string;
  constructor(model?: string) {
    this.model = model;
    this.displayName = `Codex CLI (${model ?? "default"})`;
  }

  async available() {
    const ok = await binaryAvailable("codex");
    return ok ? { ok: true } : { ok: false, reason: "`codex` CLI not found or not responding to --version" };
  }

  async complete(prompt: string, opts: CompleteOpts = {}): Promise<CompleteResult> {
    const tmp = mkdtempSync(join(tmpdir(), "umem-codex-"));
    try {
      const lastMsg = join(tmp, "last.txt");
      const sandbox = (opts as any).sandbox ?? "read-only";
      const args = ["exec", "--json", "--skip-git-repo-check", "-s", sandbox, "--output-last-message", lastMsg];
      const model = opts.model ?? this.model;
      if (model) args.push("-m", model);
      if (opts.workdir) args.push("-C", opts.workdir);
      if (opts.schema) {
        const sf = join(tmp, "schema.json");
        writeFileSync(sf, JSON.stringify(opts.schema));
        args.push("--output-schema", sf);
      }
      // Codex has no dedicated system-prompt flag in `exec`; prepend it to the prompt.
      const fullPrompt = opts.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt;
      args.push("-"); // read prompt from stdin
      const r = await run("codex", args, { stdin: fullPrompt, cwd: opts.workdir, timeoutMs: opts.timeoutMs ?? 300000 });
      // `codex --json` emits errors as stdout EVENTS, not stderr. On failure,
      // mine the event stream for an error/turn.failed so the message is useful.
      // Also recover the last agent_message text if --output-last-message wasn't written.
      let eventText = "";
      let eventErr = "";
      for (const line of r.stdout.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          const ev = JSON.parse(t);
          const item = ev?.item;
          if (item?.type === "agent_message" && typeof item.text === "string") eventText = item.text;
          if (/error|failed/i.test(String(ev?.type)) || ev?.error) eventErr = JSON.stringify(ev).slice(0, 300);
        } catch { /* ignore */ }
      }
      const fileText = existsSync(lastMsg) ? readFileSync(lastMsg, "utf-8").trim() : "";
      const text = fileText || eventText;
      if (r.code !== 0 && !text) {
        throw new Error(`codex exited ${r.code}${r.timedOut ? " (timeout)" : ""}: ${eventErr || r.stderr.slice(0, 400) || "(no diagnostic output)"}`);
      }
      let json: any;
      if (opts.schema && text) {
        try { json = JSON.parse(text); } catch { json = undefined; }
      }
      // best-effort token usage from the JSONL event stream
      let tokens: number | undefined;
      for (const line of r.stdout.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          const ev = JSON.parse(t);
          const u = ev?.msg?.usage ?? ev?.usage ?? ev?.token_usage;
          if (u) tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
        } catch { /* ignore */ }
      }
      return { text, json, cost: { tokens }, adapter: this.id, model, raw: { stderrTail: r.stderr.slice(-200) } };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
