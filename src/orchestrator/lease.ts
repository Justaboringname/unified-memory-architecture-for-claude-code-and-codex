import type { UMemDB } from "../db/db.ts";
import { nowIso } from "../util/time.ts";

export class LeaseHeldError extends Error {
  constructor(workspacePath: string) {
    super(`write lease already held for workspace: ${workspacePath}`);
    this.name = "LeaseHeldError";
  }
}

export interface Lease {
  id: number;
  workspacePath: string;
  holderAgent: string;
}

/** True if a process with this pid is alive on this machine. */
function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid) return false; // unknown pid → treat as not-alive so it can be reclaimed
  try {
    process.kill(pid, 0); // signal 0 = liveness probe
    return true;
  } catch (e: any) {
    return e?.code === "EPERM"; // exists but not ours → still alive
  }
}

/**
 * Reclaim held leases whose holder process is provably dead (crash recovery).
 * Safe: only reclaims leases whose recorded pid is no longer alive on THIS
 * machine, so a live long-running holder is never stolen. (PID reuse could keep
 * a stale lease held slightly longer — a safe failure, never data loss.)
 * Returns the number reclaimed. Scope to one workspace, or all when omitted.
 */
export function reclaimStaleLeases(db: UMemDB, workspacePath?: string): number {
  const rows = db.db
    .prepare(
      `SELECT id, workspace_path, holder_agent, holder_pid FROM worktree_leases
       WHERE status='held'${workspacePath ? " AND workspace_path=?" : ""}`,
    )
    .all(...(workspacePath ? [workspacePath] : [])) as Array<{ id: number; workspace_path: string; holder_agent: string; holder_pid: number | null }>;
  let n = 0;
  for (const r of rows) {
    if (!isProcessAlive(r.holder_pid)) {
      db.db.prepare("UPDATE worktree_leases SET status='reclaimed', released_at=? WHERE id=?").run(nowIso(), r.id);
      db.audit({ actor: "system", action: "lease.reclaim", entityType: "workspace", entityId: r.workspace_path, detail: { deadPid: r.holder_pid, was: r.holder_agent } });
      n++;
    }
  }
  return n;
}

/**
 * Acquire an EXCLUSIVE write lease on a workspace. Enforced structurally by the
 * partial unique index `idx_lease_one_writer` (UNIQUE(workspace_path) WHERE
 * status='held'): a second acquire on a held workspace throws at the DB layer.
 * This is what guarantees "never two agents writing one worktree" — not policy.
 */
export function acquireLease(db: UMemDB, taskId: number, workspacePath: string, holderAgent: string, runId?: number): Lease {
  // Crash recovery: reclaim any held lease whose holder process is dead first,
  // so a previous crash doesn't permanently block this workspace.
  reclaimStaleLeases(db, workspacePath);
  try {
    const info = db.db
      .prepare(
        `INSERT INTO worktree_leases(task_id, workspace_path, holder_agent, holder_run_id, holder_pid, status, acquired_at)
         VALUES (?,?,?,?,?, 'held', ?)`,
      )
      .run(taskId, workspacePath, holderAgent, runId ?? null, process.pid, nowIso());
    db.audit({ actor: holderAgent, action: "lease.acquire", entityType: "workspace", entityId: workspacePath, detail: { taskId } });
    return { id: Number(info.lastInsertRowid), workspacePath, holderAgent };
  } catch (e: any) {
    if (String(e?.code).includes("CONSTRAINT") || /UNIQUE/i.test(String(e?.message))) {
      const holder = db.db
        .prepare("SELECT holder_agent FROM worktree_leases WHERE workspace_path=? AND status='held'")
        .get(workspacePath) as { holder_agent: string } | undefined;
      db.audit({ actor: holderAgent, action: "lease.denied", entityType: "workspace", entityId: workspacePath, detail: { heldBy: holder?.holder_agent } });
      throw new LeaseHeldError(workspacePath);
    }
    throw e;
  }
}

export function releaseLease(db: UMemDB, lease: Lease): void {
  db.db.prepare("UPDATE worktree_leases SET status='released', released_at=? WHERE id=?").run(nowIso(), lease.id);
  db.audit({ actor: lease.holderAgent, action: "lease.release", entityType: "workspace", entityId: lease.workspacePath });
}

/** Run `fn` while holding the write lease; always released, even on throw. */
export async function withWriteLease<T>(
  db: UMemDB,
  taskId: number,
  workspacePath: string,
  holderAgent: string,
  fn: (lease: Lease) => Promise<T> | T,
  runId?: number,
): Promise<T> {
  const lease = acquireLease(db, taskId, workspacePath, holderAgent, runId);
  try {
    return await fn(lease);
  } finally {
    releaseLease(db, lease);
  }
}

/** Currently-held lease for a workspace, if any. */
export function currentHolder(db: UMemDB, workspacePath: string): string | null {
  const row = db.db
    .prepare("SELECT holder_agent FROM worktree_leases WHERE workspace_path=? AND status='held'")
    .get(workspacePath) as { holder_agent: string } | undefined;
  return row?.holder_agent ?? null;
}
