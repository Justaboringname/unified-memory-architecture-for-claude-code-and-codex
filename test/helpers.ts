import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openDb, type UMemDB } from "../src/db/db.ts";
import { importClaudeExport } from "../src/ingest/import-claude-export.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = resolve(__dirname, "..", "fixtures", "synthetic-export");

export function tempDb(): { db: UMemDB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "umem-test-"));
  const db = openDb(join(dir, "t.db"));
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

export async function seededDb(): Promise<{ db: UMemDB; cleanup: () => void }> {
  const h = tempDb();
  await importClaudeExport(h.db, FIXTURES);
  return h;
}
