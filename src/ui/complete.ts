import { promises as fsp } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface Completion {
  /** Range in the input text to replace. */
  start: number;
  end: number;
  matches: string[];
}

export const COMMANDS = ["help", "clear", "model", "config", "exit", "usage", "diff", "theme", "color", "mode"];

/**
 * Completion for `/` commands and `@` file-path mentions. Returns the range
 * to replace and the candidate list, or null when there is nothing to complete.
 */
export async function completeInput(text: string, cursor: number, cwd: string): Promise<Completion | null> {
  const lineStart = text.lastIndexOf("\n") + 1;
  const before = text.slice(lineStart, cursor);

  // `/prefix` → commands
  if (before.startsWith("/")) {
    const tok = before.slice(1).toLowerCase();
    const matches = COMMANDS.filter((c) => c.startsWith(tok)).map((c) => `/${c}`);
    if (matches.length === 0) return null;
    return { start: lineStart, end: cursor, matches };
  }

  // `@path` → file paths relative to cwd
  const atIdx = before.lastIndexOf("@");
  if (atIdx !== -1) {
    const tok = before.slice(atIdx + 1);
    const hasSlash = tok.includes("/");
    const dir = hasSlash ? dirname(tok) : "";
    const prefix = hasSlash ? basename(tok) : tok;
    const base = dir ? resolve(cwd, dir) : cwd;
    try {
      const entries = await fsp.readdir(base, { withFileTypes: true });
      const matches = entries
        .filter((e) => e.name.startsWith(prefix) && !e.name.startsWith("."))
        .filter((e) => e.name !== "node_modules")
        .map((e) => (dir ? `${dir}/${e.name}` : e.name) + (e.isDirectory() ? "/" : ""))
        .sort();
      if (matches.length === 0) return null;
      return { start: lineStart + atIdx + 1, end: cursor, matches };
    } catch {
      return null;
    }
  }

  return null;
}
