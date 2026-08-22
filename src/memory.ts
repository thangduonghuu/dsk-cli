import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SYSTEM_PROMPT } from "./agent/loop.js";

/**
 * Project memory file (the DSK.md analogue of Claude Code's CLAUDE.md).
 *
 * If a DSK.md exists in the directory dsk was launched from, its contents are
 * appended to the system prompt so the agent always has the repo's conventions,
 * build commands, and architecture in context. Generated with /init.
 */

export const MEMORY_FILE_NAME = "DSK.md";
const MAX_MEMORY_BYTES = 64 * 1024;

export interface MemoryFile {
  path: string;
  content: string;
}

/** Read the project memory file from `cwd`, or null when absent/unreadable. */
export function loadMemoryFile(cwd: string): MemoryFile | null {
  const path = resolve(cwd, MEMORY_FILE_NAME);
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf8").slice(0, MAX_MEMORY_BYTES);
    if (!content.trim()) return null;
    return { path, content };
  } catch {
    return null;
  }
}

/** The full system prompt: base instructions plus project memory when present. */
export function buildSystemPrompt(cwd: string): string {
  const mem = loadMemoryFile(cwd);
  if (!mem) return SYSTEM_PROMPT;
  return (
    SYSTEM_PROMPT +
    `\n\n# Project memory — ${MEMORY_FILE_NAME}\n\n` +
    mem.content +
    `\n\nThe project memory above describes this repository's conventions and common tasks. Follow it unless the user explicitly says otherwise. If you make material changes to the codebase's structure or conventions, update ${MEMORY_FILE_NAME} with write_file/edit_file so it stays accurate.`
  );
}
