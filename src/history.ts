import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.js";

/**
 * Persistent prompt history (`~/.dsk/history.json`), so ↑ / ↓ recall commands
 * from previous sessions, like Claude Code.
 */

const MAX_HISTORY = 500;

export function historyPath(): string {
  return join(configDir(), "history.json");
}

/** Load previously submitted prompts, most recent last. Never throws. */
export function loadHistory(): string[] {
  try {
    if (!existsSync(historyPath())) return [];
    const raw = JSON.parse(readFileSync(historyPath(), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is string => typeof x === "string").slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

/** Append a submitted prompt (deduped against the previous entry), capped. */
export function appendHistory(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  const history = loadHistory();
  if (history[history.length - 1] === trimmed) return;
  history.push(trimmed);
  const capped = history.slice(-MAX_HISTORY);
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(historyPath(), JSON.stringify(capped, null, 2) + "\n", { mode: 0o600 });
  } catch {
    /* best-effort — history loss is not worth crashing over */
  }
}
