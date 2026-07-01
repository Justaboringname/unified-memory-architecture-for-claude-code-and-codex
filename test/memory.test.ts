import { test } from "node:test";
import assert from "node:assert/strict";
import { tempDb } from "./helpers.ts";
import {
  proposeMemory, confirmMemory, updateMemory, forgetMemory, getMemory, listVersions, recentMemory,
  SecretRejectedError, SensitiveBlockedError,
} from "../src/memory/memory.ts";
import { search } from "../src/search/search.ts";

test("propose → confirm → versions", () => {
  const { db, cleanup } = tempDb();
  try {
    const m = proposeMemory(db, { memType: "decision", title: "Use SQLite FTS5 trigram", body: "Chosen for CJK+EN retrieval.", createdBy: "claude" });
    assert.equal(m.status, "proposed");
    const c = confirmMemory(db, m.id, "user");
    assert.equal(c.status, "active");
    const versions = listVersions(db, m.id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].change_type, "propose");
    assert.equal(versions[1].change_type, "confirm");
  } finally { cleanup(); }
});

test("secrets are always rejected from memory", () => {
  const { db, cleanup } = tempDb();
  try {
    assert.throws(
      () => proposeMemory(db, { memType: "semantic", title: "creds", body: "key sk-ant-FAKEFAKEFAKEFAKE1234567890", createdBy: "codex" }),
      SecretRejectedError,
    );
    // and the reject is audited
    const n = (db.db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='memory.reject_secret'").get() as any).c;
    assert.ok(n >= 1);
  } finally { cleanup(); }
});

test("PII-flagged memory blocked unless allowSensitive", () => {
  const { db, cleanup } = tempDb();
  try {
    assert.throws(
      () => proposeMemory(db, { memType: "semantic", title: "contact", body: "reach me at a@b.com", scope: "global", createdBy: "user" }),
      SensitiveBlockedError,
    );
    const m = proposeMemory(db, { memType: "semantic", title: "contact", body: "reach me at a@b.com", scope: "global", createdBy: "user", allowSensitive: true });
    assert.equal(m.sensitivity, "sensitive");
  } finally { cleanup(); }
});

test("forget removes from search but keeps history", () => {
  const { db, cleanup } = tempDb();
  try {
    const m = proposeMemory(db, { memType: "semantic", title: "flywheel note", body: "tune flywheel exit velocity", createdBy: "user", activate: true });
    assert.ok(search(db, "flywheel", { kinds: ["memory"] }, 5).length >= 1);
    forgetMemory(db, m.id, "user", "obsolete");
    assert.equal(search(db, "flywheel", { kinds: ["memory"] }, 5).length, 0);
    assert.equal(getMemory(db, m.id)!.status, "forgotten");
    assert.ok(listVersions(db, m.id).some((v: any) => v.change_type === "forget"));
  } finally { cleanup(); }
});

test("update writes a new version and keeps a tamper-evident chain", () => {
  const { db, cleanup } = tempDb();
  try {
    const m = proposeMemory(db, { memType: "instruction", title: "prefer cli", body: "use cli tools", createdBy: "user", activate: true });
    updateMemory(db, m.id, { body: "use cli tools, not GUI dashboards", author: "user", rationale: "clarify" });
    const versions = listVersions(db, m.id);
    // propose(activate) = v1, update = v2
    assert.equal(getMemory(db, m.id)!.current_version, 2);
    assert.equal(versions.length, 2);
    assert.equal(versions[1].change_type, "update");
  } finally { cleanup(); }
});

test("recentMemory filters by type/status", () => {
  const { db, cleanup } = tempDb();
  try {
    proposeMemory(db, { memType: "decision", title: "d1", body: "x", createdBy: "user", activate: true });
    proposeMemory(db, { memType: "semantic", title: "s1", body: "y", createdBy: "user", activate: true });
    assert.equal(recentMemory(db, { memType: "decision" }).length, 1);
    assert.equal(recentMemory(db, { status: "active" }).length, 2);
  } finally { cleanup(); }
});
