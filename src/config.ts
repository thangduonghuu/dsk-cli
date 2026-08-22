import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import type { PermissionMode } from "./permissions.js";

export interface DskConfig {
  apiKey?: string;
  model?: string;
  /** DeepSeek thinking mode. Defaults to enabled (API default). */
  thinking?: "enabled" | "disabled";
  /** "low" | "high" | "max" — default "high" per API docs. */
  reasoningEffort?: "low" | "high" | "max";
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** Base URL override, mainly for testing against a mock server. */
  baseUrl?: string;
  /** Run the REPL in the alternate (fullscreen) terminal buffer. */
  fullscreen?: boolean;
  /** UI theme name ("default" | "ocean" | "mono"). */
  theme?: string;
  /** Prompt-bar color (Claude Code /color list). */
  promptColor?: string;
  /** In-session permission mode. */
  mode?: PermissionMode;
  /** Tool names always allowed without prompting (e.g. ["bash", "write_file"]). */
  allowedTools?: string[];
  /** Model context window in tokens (overrides the built-in table). */
  contextWindow?: number;
}

export const DEFAULT_MODEL = "deepseek-v4-flash";
export const DEFAULT_BASE_URL = "https://api.deepseek.com";

// Computed lazily (not at module load) so tests can redirect HOME.
export function configDir(): string {
  return join(homedir(), ".dsk");
}
export function configPath(): string {
  return join(configDir(), "config.json");
}
export function sessionsDir(): string {
  return join(configDir(), "sessions");
}

/** Read the config file, returning {} if absent or unparseable. */
export function loadConfig(): DskConfig {
  try {
    if (!existsSync(configPath())) return {};
    const raw = readFileSync(configPath(), "utf8");
    return JSON.parse(raw) as DskConfig;
  } catch {
    return {};
  }
}

/**
 * Persist config. The file is written with 0600 permissions and the API key
 * is never echoed to the terminal or logs by callers.
 */
export function saveConfig(patch: DskConfig): DskConfig {
  mkdirSync(configDir(), { recursive: true });
  const merged: DskConfig = { ...loadConfig(), ...patch };
  // Drop keys whose value is undefined so we never write garbage.
  for (const k of Object.keys(merged) as (keyof DskConfig)[]) {
    if (merged[k] === undefined) delete merged[k];
  }
  writeFileSync(configPath(), JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(configPath(), 0o600);
  } catch {
    /* best-effort on platforms that don't support it */
  }
  return merged;
}

/** Key resolution priority: --api-key flag > DEEPSEEK_API_KEY env > config file. */
export function resolveApiKey(flag?: string): string | undefined {
  if (flag && flag.trim() !== "") return flag.trim();
  const env = process.env.DEEPSEEK_API_KEY;
  if (env && env.trim() !== "") return env.trim();
  return loadConfig().apiKey;
}

/** Merge config + CLI flags into the effective settings used for a request. */
export interface EffectiveSettings {
  apiKey: string;
  model: string;
  baseUrl: string;
  thinking: "enabled" | "disabled";
  reasoningEffort: "low" | "high" | "max";
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** UI theme name. */
  theme?: string;
  /** Prompt-bar color. */
  promptColor?: string;
  /** Permission mode for the session. */
  mode: PermissionMode;
  /** Tool names always allowed without prompting. */
  allowedTools?: string[];
  /** Model context window in tokens (overrides the built-in table). */
  contextWindow?: number;
}

export function resolveSettings(opts: {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: "low" | "high" | "max";
  theme?: string;
  promptColor?: string;
  mode?: PermissionMode;
  allowedTools?: string[];
  contextWindow?: number;
}): EffectiveSettings {
  const cfg = loadConfig();
  const key = resolveApiKey(opts.apiKey);
  if (!key) {
    throw new Error(
      "No DeepSeek API key found. Set DEEPSEEK_API_KEY, pass --api-key, or run `dsk config set api-key <key>`."
    );
  }
  return {
    apiKey: key,
    model: opts.model ?? cfg.model ?? DEFAULT_MODEL,
    baseUrl: (opts.baseUrl ?? cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    thinking: opts.thinking ?? cfg.thinking ?? "enabled",
    reasoningEffort: opts.reasoningEffort ?? cfg.reasoningEffort ?? "high",
    temperature: cfg.temperature,
    topP: cfg.topP,
    maxTokens: cfg.maxTokens,
    theme: opts.theme ?? cfg.theme,
    promptColor: opts.promptColor ?? cfg.promptColor,
    mode: opts.mode ?? cfg.mode ?? "bypassPermissions",
    allowedTools: opts.allowedTools ?? cfg.allowedTools,
    contextWindow: opts.contextWindow ?? cfg.contextWindow,
  };
}
