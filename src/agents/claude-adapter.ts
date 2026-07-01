import type { AgentAdapter, CompleteOpts, CompleteResult } from "./adapter.ts";
import { run, binaryAvailable } from "./spawn.ts";

/**
 * Claude Code headless adapter.
 *   claude -p --output-format json [--model] [--append-system-prompt]
 *          [--json-schema <file>] [--mcp-config <file>] [--permission-mode]
 * Prompt is passed on stdin. Structured output requested via --json-schema.
 *
 * NOTE: real invocation requires an authenticated Claude Code CLI and may incur
 * cost. Until the user authorises real runs, prefer the mock adapter.
 */
export class ClaudeCliAdapter implements AgentAdapter {
  readonly kind = "claude" as const;
  readonly id = "claude";
  readonly displayName: string;
  private model?: string;
  constructor(model?: string) {
    this.model = model;
    this.displayName = `Claude Code (${model ?? "default"})`;
  }

  async available() {
    const ok = await binaryAvailable("claude");
    return ok
      ? { ok: true }
      : { ok: false, reason: "`claude` CLI not found or not responding to --version" };
  }

  async complete(prompt: string, opts: CompleteOpts = {}): Promise<CompleteResult> {
    {
      const args = ["-p", "--output-format", "json", "--permission-mode", opts.permissionMode ?? "plan"];
      const model = opts.model ?? this.model;
      if (model) args.push("--model", model);
      if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
      if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
      // Claude's --json-schema takes the schema INLINE as a JSON string (not a
      // file path — unlike Codex's --output-schema which takes a file).
      if (opts.schema) args.push("--json-schema", JSON.stringify(opts.schema));
      // 300s default: real structured reviews carry large peer-JSON context and
      // can exceed 180s under load (observed empirically in a full real council).
      const r = await run("claude", args, { stdin: prompt, cwd: opts.workdir, timeoutMs: opts.timeoutMs ?? 300000 });
      if (r.code !== 0) {
        throw new Error(`claude exited ${r.code}${r.timedOut ? " (timeout)" : ""}: ${r.stderr.slice(0, 400)}`);
      }
      const outer = JSON.parse(r.stdout);
      // --output-format json wraps: { type:'result', result: <string|object>, total_cost_usd, usage }
      let json: any;
      let text = "";
      const result = outer.result ?? outer.output ?? outer;
      if (typeof result === "string") {
        text = result;
        if (opts.schema) {
          try { json = JSON.parse(result); } catch { json = undefined; }
        }
      } else {
        json = result;
        text = JSON.stringify(result);
      }
      const cost = {
        usd: outer.total_cost_usd ?? undefined,
        tokens: outer.usage ? (outer.usage.input_tokens ?? 0) + (outer.usage.output_tokens ?? 0) : undefined,
      };
      return { text, json, cost, adapter: this.id, model, raw: outer };
    }
  }
}
