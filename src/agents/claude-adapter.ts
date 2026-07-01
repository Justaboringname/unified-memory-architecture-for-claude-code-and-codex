import type { AgentAdapter, CompleteOpts, CompleteResult, StreamUpdate } from "./adapter.ts";
import { run, runStream, binaryAvailable } from "./spawn.ts";

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

  /**
   * Streaming completion via `--output-format stream-json --include-partial-messages`
   * (which requires --verbose in print mode). Text deltas arrive per
   * content_block_delta; the trailing `result` event is the same envelope as
   * json mode (cost/usage/model), so the final return matches complete().
   */
  async stream(prompt: string, opts: CompleteOpts, onUpdate: (u: StreamUpdate) => void): Promise<CompleteResult> {
    const args = [
      "-p", "--verbose",
      "--output-format", "stream-json", "--include-partial-messages",
      "--permission-mode", opts.permissionMode ?? "plan",
    ];
    const model = opts.model ?? this.model;
    if (model) args.push("--model", model);
    if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);

    let acc = "";
    let actualModel: string | undefined;
    let envelope: any;
    onUpdate({ text: "", status: "连接中…" });
    const r = await runStream("claude", args, {
      stdin: prompt,
      cwd: opts.workdir,
      timeoutMs: opts.timeoutMs ?? 300000,
      onLine: (line) => {
        if (!line.startsWith("{")) return;
        let ev: any;
        try { ev = JSON.parse(line); } catch { return; }
        if (ev.type === "stream_event") {
          const e = ev.event;
          if (e?.type === "message_start" && e.message?.model) {
            actualModel = e.message.model;
            onUpdate({ text: acc, status: "生成中…", model: actualModel });
          } else if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") {
            acc += e.delta.text;
            onUpdate({ text: acc });
          }
        } else if (ev.type === "assistant" && ev.message?.content) {
          // full-message sync point: authoritative text so far
          const txt = (ev.message.content as any[])
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text).join("\n");
          if (txt.length >= acc.length) { acc = txt; onUpdate({ text: acc }); }
        } else if (ev.type === "result") {
          envelope = ev;
        }
      },
    });
    if (!envelope && r.code !== 0) {
      throw new Error(`claude exited ${r.code}${r.timedOut ? " (timeout)" : ""}: ${r.stderr.slice(0, 400)}`);
    }
    const finalText = typeof envelope?.result === "string" && envelope.result ? envelope.result : acc;
    const cost = envelope
      ? { usd: envelope.total_cost_usd ?? undefined, tokens: envelope.usage ? (envelope.usage.input_tokens ?? 0) + (envelope.usage.output_tokens ?? 0) : undefined }
      : undefined;
    return { text: finalText, cost, adapter: this.id, model: actualModel ?? model, raw: envelope };
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
