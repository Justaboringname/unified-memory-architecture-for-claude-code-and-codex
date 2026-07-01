import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..");

export interface AgentConfig {
  adapter: string; // 'claude-cli' | 'codex-cli' | 'mock'
  model?: string;
  enabled: boolean;
}

export interface Config {
  dbPath: string;
  claudeExportDir?: string;
  claudeHome: string;
  /** project slugs under ~/.claude/projects to ingest; empty = all */
  claudeProjects: string[];
  agents: { claude: AgentConfig; codex: AgentConfig };
  redaction: { enabled: boolean };
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

const DEFAULTS: Config = {
  dbPath: "./data/unified-memory.db",
  claudeHome: "~/.claude",
  claudeProjects: [],
  agents: {
    claude: { adapter: "mock", model: "claude-opus-4-8", enabled: true },
    codex: { adapter: "mock", model: "gpt-5-codex", enabled: true },
  },
  redaction: { enabled: true },
};

/**
 * Load config. Precedence: config.json (gitignored, real paths) >
 * config.example.json > built-in defaults. UMEM_DB env var overrides dbPath.
 */
export function loadConfig(explicitPath?: string): Config {
  let fileCfg: Partial<Config> = {};
  const candidates = [
    explicitPath,
    process.env.UMEM_CONFIG,
    join(REPO_ROOT, "config.json"),
    join(REPO_ROOT, "config.example.json"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(c)) {
      fileCfg = JSON.parse(readFileSync(c, "utf-8"));
      break;
    }
  }
  const cfg: Config = {
    ...DEFAULTS,
    ...fileCfg,
    agents: { ...DEFAULTS.agents, ...(fileCfg.agents ?? {}) },
    redaction: { ...DEFAULTS.redaction, ...(fileCfg.redaction ?? {}) },
  };
  if (process.env.UMEM_DB) cfg.dbPath = process.env.UMEM_DB;
  // Resolve paths.
  cfg.dbPath = resolve(REPO_ROOT, expandHome(cfg.dbPath));
  cfg.claudeHome = expandHome(cfg.claudeHome);
  if (cfg.claudeExportDir) cfg.claudeExportDir = expandHome(cfg.claudeExportDir);
  return cfg;
}
