import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nowIso } from "../util/time.ts";
import { log } from "../util/log.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "schema.sql");
export const SCHEMA_VERSION = "1";

export interface AuditEntry {
  actor: string;
  action: string;
  entityType?: string;
  entityId?: string | number;
  sensitivity?: string;
  detail?: unknown;
}

export class UMemDB {
  readonly db: DB;

  constructor(dbPath: string, opts: { readonly?: boolean } = {}) {
    if (!opts.readonly) mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { readonly: opts.readonly ?? false });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    if (!opts.readonly) this.init();
  }

  /** Idempotent schema creation + version stamp. */
  init(): void {
    const schema = readFileSync(SCHEMA_PATH, "utf-8");
    this.db.exec(schema);
    this.migrate();
    const cur = this.db
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as { value: string } | undefined;
    if (!cur) {
      this.db
        .prepare("INSERT INTO schema_meta(key, value) VALUES ('version', ?)")
        .run(SCHEMA_VERSION);
      log.info("db.init", { schemaVersion: SCHEMA_VERSION });
    }
  }

  /** Idempotent column migrations for DBs created by an older schema. */
  private migrate(): void {
    const cols = this.db.prepare("PRAGMA table_info(worktree_leases)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "holder_pid")) {
      this.db.exec("ALTER TABLE worktree_leases ADD COLUMN holder_pid INTEGER");
    }
  }

  /** Append an audit row. Callers must pass only redacted/safe detail. */
  audit(e: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO audit_log(ts, actor, action, entity_type, entity_id, sensitivity, detail_json)
         VALUES (@ts, @actor, @action, @entityType, @entityId, @sensitivity, @detail)`,
      )
      .run({
        ts: nowIso(),
        actor: e.actor,
        action: e.action,
        entityType: e.entityType ?? null,
        entityId: e.entityId != null ? String(e.entityId) : null,
        sensitivity: e.sensitivity ?? "normal",
        detail: e.detail != null ? JSON.stringify(e.detail) : null,
      });
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

/** Convenience opener. */
export function openDb(dbPath: string, opts?: { readonly?: boolean }): UMemDB {
  return new UMemDB(dbPath, opts ?? {});
}
