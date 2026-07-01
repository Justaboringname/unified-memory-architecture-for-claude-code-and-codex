#!/usr/bin/env node
import { openDb } from "../db/db.ts";
import { loadConfig, type Config } from "../util/config.ts";
import { importClaudeExport } from "../ingest/import-claude-export.ts";
import { importClaudeCode, importRepoClaudeMds } from "../ingest/import-claude-code.ts";
import { search, type SearchScope } from "../search/search.ts";
import {
  proposeMemory, confirmMemory, updateMemory, forgetMemory, getMemory, listVersions, recentMemory, type MemType, type MemScope,
} from "../memory/memory.ts";
import { makeAdapter } from "../agents/adapter.ts";
import { runCouncil } from "../orchestrator/council.ts";
import { safePreview } from "../ingest/redact.ts";

// ---- tiny arg parser ----
interface Args { _: string[]; flags: Record<string, string | boolean | string[]>; }
function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        // allow repeated flags -> array
        if (flags[key] !== undefined) flags[key] = ([] as string[]).concat(flags[key] as any, next);
        else flags[key] = next;
        i++;
      }
    } else _.push(a);
  }
  return { _, flags };
}
const str = (f: Args["flags"], k: string): string | undefined => (typeof f[k] === "string" ? (f[k] as string) : undefined);
const arr = (f: Args["flags"], k: string): string[] => (f[k] === undefined ? [] : Array.isArray(f[k]) ? (f[k] as string[]) : [f[k] as string]);

function withDb<T>(cfg: Config, fn: (db: ReturnType<typeof openDb>) => T): T {
  const db = openDb(cfg.dbPath);
  try { return fn(db); } finally { db.close(); }
}

const HELP = `unified-memory (umem) — local memory + Claude/Codex council

USAGE
  umem <command> [options]

DATA
  import claude-export [--dir PATH]      Import a Claude web/account export
  import claude-code [--sessions] [--max-sessions N] [--project SLUG]
                                         Import ~/.claude CLAUDE.md, auto-memory, sessions
  import repos <path...>                 Import CLAUDE.md from repo roots
  import all [--sessions]                Import everything the config points at
  inventory                             Show what's indexed (counts, no content)

SEARCH
  search <query...> [--provider P] [--project K] [--role R]
         [--source-type T] [--kind message|memory] [--limit N] [--json]

MEMORY
  memory recent [--type T] [--scope S] [--status ST] [--limit N]
  memory get <id>            memory versions <id>
  memory propose --type T --title X --body Y [--scope S] [--project K] [--confidence C]
  memory confirm <id>        memory forget <id> [--why R]

COLLABORATION
  council "<question>" [--project K] [--constraint C ...] [--resume ID] [--synth claude|codex]
  agents status              Show configured adapters + availability

INTEGRATION
  mcp-config                 Print an --mcp-config JSON snippet for claude
  demo                       Run an offline dual-agent council demo (mock adapters)

Config: config.json (see config.example.json). Env: UMEM_DB, UMEM_CONFIG, UMEM_LOG.`;

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0];
  const cfg = loadConfig(str(flags, "config"));

  if (!cmd || cmd === "help" || flags.help) { console.log(HELP); return; }

  switch (cmd) {
    case "import": return cmdImport(_.slice(1), flags, cfg);
    case "search": return cmdSearch(_.slice(1), flags, cfg);
    case "inventory":
    case "stats": return cmdInventory(cfg);
    case "memory": return cmdMemory(_.slice(1), flags, cfg);
    case "council": return cmdCouncil(_.slice(1), flags, cfg);
    case "agents": return cmdAgents(_.slice(1), cfg);
    case "mcp-config": return cmdMcpConfig(cfg);
    case "demo": return cmdDemo(cfg);
    default: console.error(`unknown command: ${cmd}\n`); console.log(HELP); process.exitCode = 1;
  }
}

// ---- import ----
async function cmdImport(sub: string[], flags: Args["flags"], cfg: Config) {
  const what = sub[0];
  const db = openDb(cfg.dbPath);
  try {
    if (what === "claude-export" || what === "all") {
      const dir = str(flags, "dir") ?? cfg.claudeExportDir;
      if (!dir) { console.error("no export dir (config.claudeExportDir or --dir)"); process.exitCode = 1; return; }
      console.error(`importing Claude export from ${dir} …`);
      const st = await importClaudeExport(db, dir, (n) => process.stderr.write(`\r  ${n} conversations…`));
      process.stderr.write("\n");
      console.log(`Claude export: +${st.conversations} conv (${st.conversationsSkipped} unchanged), ${st.messages} msgs, ${st.memories} account-mem, ${st.projects} projects, ${st.designChats} design-chats, ${st.sourcesRecorded} recorded-only`);
    }
    if (what === "claude-code" || what === "all") {
      console.error(`importing Claude Code layer from ${cfg.claudeHome} …`);
      const st = await importClaudeCode(db, cfg.claudeHome, {
        projects: cfg.claudeProjects.length ? cfg.claudeProjects : undefined,
        includeSessions: !!flags.sessions || what === "all" && !!flags.sessions,
        maxSessionsPerProject: str(flags, "max-sessions") ? parseInt(str(flags, "max-sessions")!, 10) : undefined,
        onProgress: (n) => process.stderr.write(`\r  ${n} sessions…`),
      });
      process.stderr.write("\n");
      console.log(`Claude Code: ${st.claudeMdFiles} CLAUDE.md, ${st.memoryFiles} memory files, ${st.sessions} sessions (+${st.sessionMessages} msgs, ${st.sessionsSkipped} unchanged)`);
    }
    if (what === "repos") {
      const roots = sub.slice(1);
      const n = importRepoClaudeMds(db, roots);
      console.log(`imported ${n} repo CLAUDE.md files`);
    }
    if (!["claude-export", "claude-code", "all", "repos"].includes(what ?? "")) {
      console.error("usage: umem import <claude-export|claude-code|all|repos>"); process.exitCode = 1;
    }
  } finally { db.close(); }
}

// ---- search ----
function cmdSearch(sub: string[], flags: Args["flags"], cfg: Config) {
  const query = sub.join(" ");
  if (!query) { console.error("usage: umem search <query>"); process.exitCode = 1; return; }
  const scope: SearchScope = {
    provider: str(flags, "provider"),
    projectKey: str(flags, "project"),
    role: str(flags, "role"),
    sourceType: str(flags, "source-type"),
    kinds: str(flags, "kind") ? [str(flags, "kind") as "message" | "memory"] : undefined,
  };
  const limit = str(flags, "limit") ? parseInt(str(flags, "limit")!, 10) : 15;
  withDb(cfg, (db) => {
    const hits = search(db, query, scope, limit);
    if (flags.json) { console.log(JSON.stringify(hits, null, 2)); return; }
    console.log(`${hits.length} hit(s) for "${query}"${scope.provider ? ` [provider=${scope.provider}]` : ""}${scope.projectKey ? ` [project=${scope.projectKey}]` : ""}\n`);
    for (const h of hits) {
      const tag = h.kind === "memory" ? `mem/${h.role}` : `${h.provider}/${h.role}`;
      console.log(`• [${h.matchType}] ${tag}  ${h.title}`);
      console.log(`    ${h.preview}`);
      console.log(`    ↳ ${JSON.stringify(h.provenance)}\n`);
    }
  });
}

// ---- inventory ----
function cmdInventory(cfg: Config) {
  withDb(cfg, (db) => {
    const sources = db.db.prepare("SELECT provider, source_type, COUNT(*) n, IFNULL(SUM(byte_size),0) bytes FROM sources GROUP BY provider, source_type ORDER BY n DESC").all() as any[];
    const convs = (db.db.prepare("SELECT COUNT(*) c FROM conversations").get() as any).c;
    const msgs = (db.db.prepare("SELECT COUNT(*) c FROM messages").get() as any).c;
    const mems = db.db.prepare("SELECT status, COUNT(*) n FROM memory_items GROUP BY status").all() as any[];
    const tasks = (db.db.prepare("SELECT COUNT(*) c FROM tasks").get() as any).c;
    const runs = (db.db.prepare("SELECT COUNT(*) c FROM agent_runs").get() as any).c;
    const sens = db.db.prepare("SELECT sensitivity, COUNT(*) n FROM sources GROUP BY sensitivity").all() as any[];
    console.log("SOURCES (provenance):");
    for (const s of sources) console.log(`  ${s.provider.padEnd(12)} ${s.source_type.padEnd(16)} ${String(s.n).padStart(6)}  ${(s.bytes / 1e6).toFixed(1)}MB`);
    console.log(`\nCONVERSATIONS: ${convs}   MESSAGES: ${msgs}`);
    console.log(`MEMORY ITEMS:`, mems.map((m) => `${m.status}=${m.n}`).join(", ") || "none");
    console.log(`SENSITIVITY:`, sens.map((s) => `${s.sensitivity}=${s.n}`).join(", "));
    console.log(`TASKS: ${tasks}   AGENT RUNS: ${runs}`);
  });
}

// ---- memory ----
function cmdMemory(sub: string[], flags: Args["flags"], cfg: Config) {
  const op = sub[0];
  withDb(cfg, (db) => {
    switch (op) {
      case "recent": {
        const items = recentMemory(db, { limit: str(flags, "limit") ? parseInt(str(flags, "limit")!, 10) : 20, memType: str(flags, "type") as MemType, scope: str(flags, "scope") as MemScope, status: str(flags, "status") as any });
        for (const i of items) console.log(`#${i.id} [${i.status}] ${i.mem_type}/${i.scope}${i.scope_ref ? `:${i.scope_ref}` : ""}  ${i.title}  (conf ${i.confidence}${i.sensitivity !== "normal" ? ", " + i.sensitivity : ""})`);
        console.log(`\n${items.length} item(s)`);
        break;
      }
      case "get": {
        const id = parseInt(sub[1] ?? "", 10);
        const item = getMemory(db, id);
        if (!item) { console.error(`memory ${id} not found`); process.exitCode = 1; return; }
        const body = item.sensitivity !== "normal" && !flags.reveal ? `⟪${item.sensitivity} — pass --reveal to show⟫` : item.body;
        console.log(JSON.stringify({ ...item, body }, null, 2));
        break;
      }
      case "versions": {
        const id = parseInt(sub[1] ?? "", 10);
        console.log(JSON.stringify(listVersions(db, id), null, 2));
        break;
      }
      case "propose": {
        const item = proposeMemory(db, {
          memType: (str(flags, "type") as MemType) ?? "semantic",
          title: str(flags, "title") ?? "(untitled)",
          body: str(flags, "body") ?? "",
          scope: (str(flags, "scope") as MemScope) ?? "global",
          scopeRef: str(flags, "project") ?? null,
          confidence: str(flags, "confidence") ? parseFloat(str(flags, "confidence")!) : undefined,
          createdBy: "user",
          activate: !!flags.activate,
          allowSensitive: !!flags["allow-sensitive"],
        });
        console.log(`proposed memory #${item.id} (status ${item.status})`);
        break;
      }
      case "confirm": {
        const id = parseInt(sub[1] ?? "", 10);
        const item = confirmMemory(db, id, "user");
        console.log(`memory #${item.id} -> ${item.status}`);
        break;
      }
      case "update": {
        const id = parseInt(sub[1] ?? "", 10);
        const item = updateMemory(db, id, { title: str(flags, "title"), body: str(flags, "body"), confidence: str(flags, "confidence") ? parseFloat(str(flags, "confidence")!) : undefined, rationale: str(flags, "why"), author: "user", allowSensitive: !!flags["allow-sensitive"] });
        console.log(`memory #${item.id} -> v${item.current_version}`);
        break;
      }
      case "forget": {
        const id = parseInt(sub[1] ?? "", 10);
        const item = forgetMemory(db, id, "user", str(flags, "why"));
        console.log(`memory #${item.id} -> ${item.status}`);
        break;
      }
      default: console.error("usage: umem memory <recent|get|versions|propose|confirm|update|forget>"); process.exitCode = 1;
    }
  });
}

// ---- council ----
async function cmdCouncil(sub: string[], flags: Args["flags"], cfg: Config) {
  const question = sub.join(" ") || str(flags, "question");
  if (!question) { console.error('usage: umem council "<question>"'); process.exitCode = 1; return; }
  const db = openDb(cfg.dbPath);
  try {
    const claude = await makeAdapter("claude", cfg.agents.claude);
    const codex = await makeAdapter("codex", cfg.agents.codex);
    const [ca, cx] = await Promise.all([claude.available(), codex.available()]);
    console.error(`agents: ${claude.displayName} [${ca.ok ? "ok" : "unavailable: " + ca.reason}], ${codex.displayName} [${cx.ok ? "ok" : "unavailable: " + cx.reason}]`);
    const res = await runCouncil(db, claude, codex, {
      question,
      projectKey: str(flags, "project") ?? null,
      constraints: arr(flags, "constraint"),
      resumeTaskId: str(flags, "resume") ? parseInt(str(flags, "resume")!, 10) : undefined,
      synthesizer: (str(flags, "synth") as "claude" | "codex") ?? "claude",
    });
    printCouncil(res);
  } finally { db.close(); }
}

function printCouncil(res: Awaited<ReturnType<typeof runCouncil>>) {
  const line = (s = "") => console.log(s);
  line(`\n════════ COUNCIL (task #${res.taskId}) ════════`);
  line(`Q: ${res.question}`);
  line(`\nRetrieved memory context: ${res.memoryRefs.length} item(s)`);
  for (const m of res.memoryRefs.slice(0, 5)) line(`  · [${m.title}] ${m.snippet}`);
  line(`\n── Independent analysis ──`);
  line(`[Claude] (conf ${res.claude.confidence}) ${res.claude.answer}`);
  line(`   risks: ${res.claude.risks.join("; ") || "—"}`);
  line(`[Codex]  (conf ${res.codex.confidence}) ${res.codex.answer}`);
  line(`   risks: ${res.codex.risks.join("; ") || "—"}`);
  line(`\n── Cross-review ──`);
  line(`[Claude→Codex] ${res.claudeReviewOfCodex.verdict}: ${res.claudeReviewOfCodex.disagreements.join("; ") || "no disagreements"}`);
  line(`[Codex→Claude] ${res.codexReviewOfClaude.verdict}: ${res.codexReviewOfClaude.disagreements.join("; ") || "no disagreements"}`);
  line(`\n── Synthesis ──`);
  line(res.synthesis.finalAnswer);
  line(`rationale: ${res.synthesis.rationale}`);
  line(`executor (single writer): ${res.synthesis.executor}`);
  line(`verification: ${res.synthesis.verificationPlan.join("; ") || "—"}`);
  line(`stop conditions: ${res.synthesis.stopConditions.join("; ") || "—"}`);
  if (res.synthesis.openQuestions.length) line(`open questions: ${res.synthesis.openQuestions.join("; ")}`);
  if (res.synthesis.proposedMemories.length) {
    line(`\nProposed memories (NOT auto-saved — confirm with 'umem memory propose'):`);
    for (const m of res.synthesis.proposedMemories) line(`  · (${m.memType}/${m.scope}) ${m.title}: ${safePreview(m.body, 100)}`);
  }
  line();
}

// ---- agents status ----
async function cmdAgents(sub: string[], cfg: Config) {
  const claude = await makeAdapter("claude", cfg.agents.claude);
  const codex = await makeAdapter("codex", cfg.agents.codex);
  for (const a of [claude, codex]) {
    const av = await a.available();
    console.log(`${a.id.padEnd(8)} ${a.displayName.padEnd(28)} ${av.ok ? "available" : "UNAVAILABLE — " + av.reason}`);
  }
}

// ---- mcp-config ----
function cmdMcpConfig(cfg: Config) {
  const serverPath = new URL("../mcp/server.ts", import.meta.url).pathname;
  const snippet = {
    mcpServers: {
      "unified-memory": {
        command: "node",
        args: ["--experimental-strip-types", "--no-warnings", serverPath],
        env: { UMEM_DB: cfg.dbPath, UMEM_AGENT: "claude" },
      },
    },
  };
  console.log(JSON.stringify(snippet, null, 2));
  console.error(`\n# Attach to a headless Claude run with:\n#   claude -p --mcp-config <(umem mcp-config) --allowed-tools 'mcp__unified-memory__*'`);
}

// ---- demo ----
async function cmdDemo(cfg: Config) {
  const { runDemo } = await import("./demo.ts");
  await runDemo(cfg);
}

main().catch((e) => { console.error(`error: ${e?.stack ?? e}`); process.exit(1); });
