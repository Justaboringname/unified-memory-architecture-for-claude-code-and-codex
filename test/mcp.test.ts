import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { tempDb } from "./helpers.ts";
import { buildServer } from "../src/mcp/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Deployment-surface test: boot the server as a REAL subprocess over stdio
// (this is what `umem mcp-config` tells Claude to spawn). Verifies main(), the
// entry guard, StdioServerTransport, and that stdout stays clean for JSON-RPC.
test("MCP server boots as a real stdio subprocess and round-trips", async () => {
  const dir = mkdtempSync(join(tmpdir(), "umem-mcpboot-"));
  const serverPath = resolve(__dirname, "..", "src", "mcp", "server.ts");
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--experimental-strip-types", "--no-warnings", serverPath],
    env: { ...process.env, UMEM_DB: join(dir, "boot.db"), UMEM_AGENT: "claude" },
  });
  const client = new Client({ name: "boot-test", version: "0" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("memory_propose") && tools.length === 7);
    const prop = parse(await client.callTool({ name: "memory_propose", arguments: { memType: "decision", title: "boot", body: "stdio works" } }));
    assert.equal(prop.status, "proposed");
    const recent = parse(await client.callTool({ name: "memory_recent", arguments: { limit: 3 } }));
    assert.equal(recent.count, 1);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function connect(db: any, actor: any = "claude") {
  const server = buildServer(db, actor);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, server };
}
function parse(res: any) {
  return JSON.parse(res.content[0].text);
}

test("MCP exposes the MVP tool set", async () => {
  const { db, cleanup } = tempDb();
  try {
    const { client } = await connect(db);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const t of ["memory_search", "memory_get", "memory_propose", "memory_update", "memory_forget", "memory_recent", "memory_sources"]) {
      assert.ok(tools.includes(t), `missing tool ${t}`);
    }
  } finally { cleanup(); }
});

test("agent can propose but the item stays 'proposed'", async () => {
  const { db, cleanup } = tempDb();
  try {
    const { client } = await connect(db, "codex");
    const res = parse(await client.callTool({ name: "memory_propose", arguments: { memType: "decision", title: "use trigram", body: "for CJK retrieval" } }));
    assert.equal(res.status, "proposed");
    const got = parse(await client.callTool({ name: "memory_get", arguments: { id: res.id } }));
    assert.equal(got.item.status, "proposed");
    assert.equal(got.item.created_by, "codex");
  } finally { cleanup(); }
});

test("MCP rejects secrets on propose", async () => {
  const { db, cleanup } = tempDb();
  try {
    const { client } = await connect(db);
    const res = await client.callTool({ name: "memory_propose", arguments: { memType: "semantic", title: "creds", body: "key sk-ant-FAKEFAKEFAKEFAKE1234567890" } });
    assert.equal((res as any).isError, true);
    assert.match(parse(res).error, /credential|rejected/i);
  } finally { cleanup(); }
});

test("MCP protects global/active memory from agent update", async () => {
  const { db, cleanup } = tempDb();
  try {
    const { client } = await connect(db);
    // create a proposed global item, then confirm via direct API to make it active
    const prop = parse(await client.callTool({ name: "memory_propose", arguments: { memType: "instruction", title: "rule", body: "prefer cli", scope: "global" } }));
    const { confirmMemory } = await import("../src/memory/memory.ts");
    confirmMemory(db, prop.id, "user");
    const upd = await client.callTool({ name: "memory_update", arguments: { id: prop.id, body: "prefer cli tools only" } });
    assert.equal((upd as any).isError, true);
    assert.match(parse(upd).error, /protected/i);
  } finally { cleanup(); }
});

test("memory_get withholds the body for a 'secret'-tier item (not just 'sensitive')", async () => {
  const { db, cleanup } = tempDb();
  try {
    const { nowIso } = await import("../src/util/time.ts");
    const ts = nowIso();
    const id = Number(db.db.prepare(
      `INSERT INTO memory_items(mem_type,title,body,scope,confidence,sensitivity,status,created_by,current_version,created_at,updated_at)
       VALUES ('semantic','x','raw secret body',' global',0.5,'secret','active','import',1,?,?)`,
    ).run(ts, ts).lastInsertRowid);
    const { client } = await connect(db);
    const got = parse(await client.callTool({ name: "memory_get", arguments: { id } }));
    assert.ok(!JSON.stringify(got.item).includes("raw secret body"), "secret body must not cross MCP");
    assert.match(got.item.body, /withheld/);
  } finally { cleanup(); }
});

test("memory_search returns scoped hits with provenance", async () => {
  const { db, cleanup } = tempDb();
  try {
    const { client } = await connect(db);
    await client.callTool({ name: "memory_propose", arguments: { memType: "semantic", title: "flywheel note", body: "tune flywheel exit velocity for foam" } });
    const res = parse(await client.callTool({ name: "memory_search", arguments: { query: "flywheel", kinds: ["memory"] } }));
    assert.ok(res.count >= 1);
    assert.ok(res.hits[0].provenance);
  } finally { cleanup(); }
});
