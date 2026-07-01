import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb, type UMemDB } from "../db/db.ts";
import { loadConfig } from "../util/config.ts";
import { search } from "../search/search.ts";
import {
  proposeMemory,
  updateMemory,
  forgetMemory,
  getMemory,
  listVersions,
  recentMemory,
  SecretRejectedError,
  SensitiveBlockedError,
  type Author,
  type MemType,
  type MemScope,
} from "../memory/memory.ts";

// ============================================================================
// Memory MCP server. Exposes the MVP-compatible tool set. Policy:
//   * Agents may only PROPOSE (status='proposed'). MCP never activates memory.
//   * Updating/forgetting a GLOBAL or ACTIVE item is blocked unless
//     UMEM_MCP_ALLOW_OVERRIDE=1 — agents should propose a replacement instead.
//   * Secrets are always rejected; PII-flagged content is blocked unless opted in.
// ============================================================================

const ALLOW_OVERRIDE = process.env.UMEM_MCP_ALLOW_OVERRIDE === "1";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function err(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

export function buildServer(db: UMemDB, actor: Author): McpServer {
  const server = new McpServer({ name: "unified-memory", version: "0.1.0" });

  server.registerTool(
    "memory_search",
    {
      description:
        "Search unified memory (imported conversations + Claude Code memory/sessions + derived memory items). " +
        "Handles English and CJK. Scope by provider/project/role/source_type. Returns ranked hits with provenance.",
      inputSchema: {
        query: z.string().describe("free-text query; keywords or a natural-language question"),
        provider: z.string().optional().describe("claude-web | claude-code | memory"),
        projectKey: z.string().optional(),
        role: z.string().optional().describe("human | assistant | user | ..."),
        sourceType: z.string().optional(),
        kinds: z.array(z.enum(["message", "memory"])).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (a) => {
      const hits = search(db, a.query, { provider: a.provider, projectKey: a.projectKey, role: a.role, sourceType: a.sourceType, kinds: a.kinds }, a.limit ?? 15);
      db.audit({ actor, action: "mcp.memory_search", detail: { q: a.query.slice(0, 60), n: hits.length } });
      return ok({ count: hits.length, hits });
    },
  );

  server.registerTool(
    "memory_get",
    {
      description: "Fetch one memory item by id, with its version history and source references.",
      inputSchema: { id: z.number().int() },
    },
    async (a) => {
      const item = getMemory(db, a.id);
      if (!item) return err(`memory ${a.id} not found`);
      if (item.sensitivity !== "normal") {
        // 'sensitive' or 'secret' — never return the body over MCP.
        return ok({ item: { ...item, body: `⟪${item.sensitivity} — body withheld; use CLI with explicit reveal⟫` }, versions: listVersions(db, a.id) });
      }
      return ok({ item, versions: listVersions(db, a.id) });
    },
  );

  server.registerTool(
    "memory_propose",
    {
      description:
        "Propose a NEW memory item (created as status='proposed'; requires user confirmation to activate). " +
        "Use for durable knowledge: instructions, project facts, decisions, procedures. Never store credentials.",
      inputSchema: {
        memType: z.enum(["instruction", "semantic", "decision", "episodic", "procedural", "working"]),
        title: z.string(),
        body: z.string(),
        scope: z.enum(["global", "project", "task"]).optional(),
        scopeRef: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
        sourceRefs: z.array(z.object({ source_id: z.number().optional(), message_id: z.number().optional(), note: z.string().optional() })).optional(),
      },
    },
    async (a) => {
      try {
        const item = proposeMemory(db, {
          memType: a.memType as MemType,
          title: a.title,
          body: a.body,
          scope: (a.scope as MemScope) ?? "global",
          scopeRef: a.scopeRef ?? null,
          confidence: a.confidence,
          sourceRefs: a.sourceRefs,
          createdBy: actor,
        });
        return ok({ status: "proposed", id: item.id, note: "awaiting user confirmation (umem memory confirm <id>)" });
      } catch (e) {
        if (e instanceof SecretRejectedError) return err(`rejected: ${e.message}`);
        if (e instanceof SensitiveBlockedError) return err(`blocked: ${e.message}`);
        return err(String((e as Error).message));
      }
    },
  );

  server.registerTool(
    "memory_update",
    {
      description:
        "Update an existing memory item (writes a new version). GLOBAL or ACTIVE items are protected: updating them " +
        "requires operator override; otherwise propose a replacement. Task/project 'proposed' items are freely editable.",
      inputSchema: {
        id: z.number().int(),
        title: z.string().optional(),
        body: z.string().optional(),
        confidence: z.number().min(0).max(1).optional(),
        rationale: z.string().optional(),
      },
    },
    async (a) => {
      const cur = getMemory(db, a.id);
      if (!cur) return err(`memory ${a.id} not found`);
      if ((cur.scope === "global" || cur.status === "active") && !ALLOW_OVERRIDE) {
        db.audit({ actor, action: "mcp.memory_update.blocked", entityId: a.id, detail: { scope: cur.scope, status: cur.status } });
        return err(`memory ${a.id} is ${cur.status}/${cur.scope}-scoped and protected. Propose a replacement (memory_propose) or ask the user to confirm.`);
      }
      try {
        const item = updateMemory(db, a.id, { title: a.title, body: a.body, confidence: a.confidence, rationale: a.rationale, author: actor });
        return ok({ status: "updated", id: item.id, version: item.current_version });
      } catch (e) {
        if (e instanceof SecretRejectedError) return err(`rejected: ${e.message}`);
        if (e instanceof SensitiveBlockedError) return err(`blocked: ${e.message}`);
        return err(String((e as Error).message));
      }
    },
  );

  server.registerTool(
    "memory_forget",
    {
      description: "Mark a memory item forgotten (soft-delete; history retained, removed from search). GLOBAL/ACTIVE items require operator override.",
      inputSchema: { id: z.number().int(), rationale: z.string().optional() },
    },
    async (a) => {
      const cur = getMemory(db, a.id);
      if (!cur) return err(`memory ${a.id} not found`);
      if ((cur.scope === "global" || cur.status === "active") && !ALLOW_OVERRIDE) {
        return err(`memory ${a.id} is protected (${cur.status}/${cur.scope}). Ask the user to confirm deletion via CLI.`);
      }
      const item = forgetMemory(db, a.id, actor, a.rationale);
      return ok({ status: "forgotten", id: item.id });
    },
  );

  server.registerTool(
    "memory_recent",
    {
      description: "List recent memory items, optionally filtered by type/scope/status.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        memType: z.enum(["instruction", "semantic", "decision", "episodic", "procedural", "working"]).optional(),
        scope: z.enum(["global", "project", "task"]).optional(),
        status: z.enum(["proposed", "active", "superseded", "forgotten"]).optional(),
      },
    },
    async (a) => {
      const items = recentMemory(db, { limit: a.limit, memType: a.memType as MemType, scope: a.scope as MemScope, status: a.status as any });
      return ok({ count: items.length, items: items.map((i) => ({ id: i.id, memType: i.mem_type, title: i.title, scope: i.scope, status: i.status, confidence: i.confidence, sensitivity: i.sensitivity })) });
    },
  );

  server.registerTool(
    "memory_sources",
    {
      description: "Resolve provenance: given a memory id, return the source files/messages it derives from; with no id, return a source inventory by provider/type.",
      inputSchema: { memoryId: z.number().int().optional() },
    },
    async (a) => {
      if (a.memoryId != null) {
        const item = getMemory(db, a.memoryId);
        if (!item) return err(`memory ${a.memoryId} not found`);
        const refs = item.source_refs ? JSON.parse(item.source_refs) : [];
        const sources = refs
          .map((r: any) => r.source_id)
          .filter(Boolean)
          .map((sid: number) => db.db.prepare("SELECT id, provider, source_type, file_path, external_id, content_hash, sensitivity FROM sources WHERE id=?").get(sid));
        return ok({ memoryId: a.memoryId, refs, sources });
      }
      const inv = db.db.prepare("SELECT provider, source_type, COUNT(*) n, SUM(byte_size) bytes FROM sources GROUP BY provider, source_type ORDER BY n DESC").all();
      return ok({ inventory: inv });
    },
  );

  return server;
}

async function main() {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const actor = (process.env.UMEM_AGENT as Author) || "claude";
  const server = buildServer(db, actor);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe (stdout is the MCP channel)
  process.stderr.write(`[unified-memory mcp] connected; db=${cfg.dbPath} actor=${actor}\n`);
}

// Run as a server only when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`[unified-memory mcp] fatal: ${e?.message ?? e}\n`);
    process.exit(1);
  });
}
