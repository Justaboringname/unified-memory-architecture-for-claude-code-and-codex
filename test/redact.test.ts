import { test } from "node:test";
import assert from "node:assert/strict";
import { scan, containsSecret, classifySensitivity, redact, safePreview } from "../src/ingest/redact.ts";

test("detects credentials as secret", () => {
  assert.ok(containsSecret("token: sk-ant-FAKEFAKEFAKEFAKEFAKE1234567890"));
  assert.ok(containsSecret("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(containsSecret("-----BEGIN PRIVATE KEY-----"));
  assert.equal(classifySensitivity("just a normal sentence about rockets"), "normal");
});

test("flags PII/identity as sensitive (soft)", () => {
  assert.equal(classifySensitivity("my email is a@b.com"), "sensitive");
  assert.equal(classifySensitivity("visa status and green card details"), "sensitive");
  assert.equal(scan("SSN 123-45-6789").sensitivity, "sensitive");
});

test("secret outranks pii", () => {
  assert.equal(classifySensitivity("email a@b.com and key sk-ant-FAKEFAKEFAKEFAKE1234567890"), "secret");
});

test("redact masks secrets and preview is safe", () => {
  const masked = redact("here sk-ant-FAKEFAKEFAKEFAKE1234567890 end");
  assert.ok(!masked.includes("sk-ant-FAKEFAKEFAKEFAKE1234567890"));
  assert.ok(masked.includes("redacted"));
  const p = safePreview("email me at secret@example.com now", 200);
  assert.ok(!p.includes("secret@example.com"));
});
