// ============================================================================
// Collaboration protocol. These structured shapes are what agents exchange.
// The JSON Schemas below are handed to `claude --json-schema` and
// `codex exec --output-schema` so both agents return validated structured data
// instead of free text.
// ============================================================================

export interface MemoryRef {
  memory_id?: number;
  source_id?: number;
  title: string;
  snippet: string;
}

/** What the orchestrator hands an agent to work on. */
export interface TaskPacket {
  taskId: number;
  question: string;
  projectKey?: string | null;
  constraints: string[];
  /** Retrieved unified-memory context (already scoped + redacted for display). */
  memoryRefs: MemoryRef[];
  /** Short digest of relevant repo/workspace state, if any. */
  workspaceState?: string;
  phase: "independent" | "review" | "synthesis";
  /** For the review phase: the peer's result to critique. */
  peerResult?: AgentResult;
  peerName?: string;
}

/** An agent's independent analysis. */
export interface AgentResult {
  answer: string;
  claims: string[];
  evidence: string[];
  assumptions: string[];
  risks: string[];
  plan: string[];
  confidence: number; // 0..1
}

/** One agent's critique of the other's AgentResult. */
export interface PeerReview {
  agreements: string[];
  disagreements: string[];
  missingEvidence: string[];
  suggestedChanges: string[];
  verdict: "endorse" | "endorse-with-changes" | "reject";
  confidence: number;
}

/** The orchestrator's (or a synthesizer agent's) reconciliation. */
export interface Synthesis {
  finalAnswer: string;
  rationale: string;
  executor: "claude" | "codex" | "none";
  verificationPlan: string[];
  stopConditions: string[];
  openQuestions: string[];
  proposedMemories: ProposedMemory[];
}

export interface ProposedMemory {
  memType: "instruction" | "semantic" | "decision" | "episodic" | "procedural" | "working";
  title: string;
  body: string;
  scope: "global" | "project" | "task";
  confidence: number;
  rationale: string;
}

// ---- JSON Schemas (draft-07 subset accepted by both CLIs) ----
export const AGENT_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "claims", "evidence", "assumptions", "risks", "plan", "confidence"],
  properties: {
    answer: { type: "string", description: "Direct answer to the question." },
    claims: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" }, description: "Concrete support: file refs, memory ids, facts." },
    assumptions: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    plan: { type: "array", items: { type: "string" }, description: "Ordered steps if code changes are needed." },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export const PEER_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["agreements", "disagreements", "missingEvidence", "suggestedChanges", "verdict", "confidence"],
  properties: {
    agreements: { type: "array", items: { type: "string" } },
    disagreements: { type: "array", items: { type: "string" } },
    missingEvidence: { type: "array", items: { type: "string" } },
    suggestedChanges: { type: "array", items: { type: "string" } },
    verdict: { type: "string", enum: ["endorse", "endorse-with-changes", "reject"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

export const SYNTHESIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["finalAnswer", "rationale", "executor", "verificationPlan", "stopConditions", "openQuestions", "proposedMemories"],
  properties: {
    finalAnswer: { type: "string" },
    rationale: { type: "string" },
    executor: { type: "string", enum: ["claude", "codex", "none"] },
    verificationPlan: { type: "array", items: { type: "string" } },
    stopConditions: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
    proposedMemories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["memType", "title", "body", "scope", "confidence", "rationale"],
        properties: {
          memType: { type: "string", enum: ["instruction", "semantic", "decision", "episodic", "procedural", "working"] },
          title: { type: "string" },
          body: { type: "string" },
          scope: { type: "string", enum: ["global", "project", "task"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          rationale: { type: "string" },
        },
      },
    },
  },
} as const;
