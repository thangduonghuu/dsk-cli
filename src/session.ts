import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sessionsDir } from "./config.js";
import type { ChatMessage } from "./agent/deepseekClient.js";

export interface SessionFile {
  id: string;
  createdAt: string;
  cwd: string;
  model: string;
  messages: ChatMessage[];
}

const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Session ids are used in filesystem paths — reject anything unsafe. */
function assertSafeId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Invalid session id: ${id}`);
  }
}

function sessionPath(id: string): string {
  assertSafeId(id);
  return join(sessionsDir(), `${id}.json`);
}

/** Create (or update) a session transcript under ~/.dsk/sessions/. Returns the id. */
export function saveSession(meta: { id?: string; model: string; messages: ChatMessage[] }): string {
  const id = meta.id ?? new Date().toISOString().replace(/[:.]/g, "-");
  assertSafeId(id);
  mkdirSync(sessionsDir(), { recursive: true });
  const file: SessionFile = {
    id,
    createdAt: new Date().toISOString(),
    cwd: process.cwd(),
    model: meta.model,
    messages: meta.messages,
  };
  writeFileSync(sessionPath(id), JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  return id;
}

export function loadSession(id: string): SessionFile {
  const raw = readFileSync(sessionPath(id), "utf8");
  return JSON.parse(raw) as SessionFile;
}

/** Delete a saved session. Throws on an invalid id; ignores missing files. */
export function deleteSession(id: string): void {
  assertSafeId(id);
  try {
    rmSync(sessionPath(id), { force: true });
  } catch {
    /* already gone or not deletable — treat as done */
  }
}

export function listSessions(): SessionFile[] {
  let files: string[];
  try {
    files = readdirSync(sessionsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      try {
        return loadSession(f.replace(/\.json$/, ""));
      } catch {
        return null;
      }
    })
    .filter((s): s is SessionFile => s !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Most recent session, or null if none exists. */
export function latestSession(): SessionFile | null {
  return listSessions()[0] ?? null;
}
