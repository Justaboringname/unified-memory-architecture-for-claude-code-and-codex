// ============================================================================
// Redaction & sensitivity detection.
//
// SCOPE (see ADR-0003): this is applied to DERIVED artifacts, logs, test
// fixtures, and memory candidates — NOT to the raw archive (messages.text is
// stored as-is; scrubbing it would destroy the evidence layer).
//
// Two jobs:
//   1. detectSecrets() — hard block: credentials must NEVER enter memory_items
//      or logs. If found in a memory candidate, the propose is rejected.
//   2. classifySensitivity() — soft flag: PII/financial/identity markers set a
//      `sensitive` flag so the UI can hide the body by default.
//   3. redact() — mask secrets + PII for anything we print (logs, reports).
// ============================================================================

export type Sensitivity = "normal" | "sensitive" | "secret";

interface Pattern {
  name: string;
  re: RegExp;
  kind: "secret" | "pii";
}

// High-confidence credential patterns. A hit here means "secret".
const SECRET_PATTERNS: Pattern[] = [
  { name: "anthropic_key", kind: "secret", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai_key", kind: "secret", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: "aws_access_key", kind: "secret", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "aws_secret", kind: "secret", re: /\baws_secret_access_key\s*[=:]\s*\S+/gi },
  { name: "github_token", kind: "secret", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: "google_key", kind: "secret", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "slack_token", kind: "secret", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "private_key_block", kind: "secret", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: "jwt", kind: "secret", re: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "bearer", kind: "secret", re: /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}/g },
  { name: "generic_secret_assign", kind: "secret", re: /\b(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[=:]\s*["']?[A-Za-z0-9/+_.-]{12,}["']?/gi },
];

// PII / identity / financial markers. A hit here means "sensitive" (soft).
const PII_PATTERNS: Pattern[] = [
  { name: "email", kind: "pii", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: "ssn", kind: "pii", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "credit_card", kind: "pii", re: /\b(?:\d[ -]?){13,16}\b/g },
  { name: "phone", kind: "pii", re: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  { name: "passport", kind: "pii", re: /\bpassport\s*(?:no\.?|number|#)?\s*[:#]?\s*[A-Z0-9]{6,9}\b/gi },
];

// Keyword markers for identity/immigration/financial context (soft sensitivity).
const SENSITIVE_KEYWORDS =
  /\b(visa|immigration|green\s?card|i-?20|i-?94|ssn|social security|passport|salary|net worth|bank account|routing number|home address|date of birth|dob)\b/i;

export interface ScanResult {
  hasSecret: boolean;
  secretKinds: string[];
  hasPII: boolean;
  piiKinds: string[];
  sensitivity: Sensitivity;
}

export function scan(text: string): ScanResult {
  const secretKinds: string[] = [];
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    if (p.re.test(text)) secretKinds.push(p.name);
  }
  const piiKinds: string[] = [];
  for (const p of PII_PATTERNS) {
    p.re.lastIndex = 0;
    if (p.re.test(text)) piiKinds.push(p.name);
  }
  const kwSensitive = SENSITIVE_KEYWORDS.test(text);
  const hasSecret = secretKinds.length > 0;
  const hasPII = piiKinds.length > 0 || kwSensitive;
  const sensitivity: Sensitivity = hasSecret ? "secret" : hasPII ? "sensitive" : "normal";
  return { hasSecret, secretKinds, hasPII, piiKinds, sensitivity };
}

/** Classify without the full breakdown. */
export function classifySensitivity(text: string): Sensitivity {
  return scan(text).sensitivity;
}

/** True if text contains a credential that must never be stored/logged. */
export function containsSecret(text: string): boolean {
  return scan(text).hasSecret;
}

/**
 * Mask ONLY credential patterns (not PII) out of text. Used by the bulk import
 * paths that copy file content (CLAUDE.md, auto-memory, project/account docs)
 * into the DERIVED memory layer: agent-driven propose/update *reject* secrets,
 * but a bulk file import should keep the non-secret content searchable while
 * ensuring the credential never lands in `memory_items` (ADR-0003). Returns the
 * cleaned text and how many secrets were stripped.
 */
export function stripSecrets(text: string): { text: string; stripped: number } {
  let out = text;
  let stripped = 0;
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    out = out.replace(p.re, () => {
      stripped++;
      return `⟪${p.name}:removed⟫`;
    });
  }
  return { text: out, stripped };
}

/**
 * Mask secrets and PII for safe display in logs / reports. Raw content is never
 * passed through this for storage — only for output surfaces.
 */
export function redact(text: string): string {
  let out = text;
  for (const p of [...SECRET_PATTERNS, ...PII_PATTERNS]) {
    p.re.lastIndex = 0;
    out = out.replace(p.re, (m) => `⟪${p.name}:redacted:${m.length}⟫`);
  }
  return out;
}

/** A short, redacted preview safe for logs (first N chars, secrets masked). */
export function safePreview(text: string, n = 80): string {
  const r = redact(text.replace(/\s+/g, " ").trim());
  return r.length > n ? r.slice(0, n) + "…" : r;
}
