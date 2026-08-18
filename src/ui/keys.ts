import { stdin } from "node:process";
import { emitKeypressEvents } from "node:readline";

export interface KeyEvent {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  sequence: string;
}

let initialized = false;

/**
 * Enable keypress events and raw mode on stdin (TTY only). Call once at REPL
 * startup; call again after a pager (e.g. `less` via Ctrl+O) to re-enter raw
 * mode — emitKeypressEvents is only registered once, but raw mode is
 * re-asserted every call so a pager can't leave the terminal cooked.
 */
export function initKeyInput(): void {
  if (!initialized) {
    initialized = true;
    emitKeypressEvents(stdin);
  }
  if (stdin.isTTY) stdin.setRawMode(true);
}

/** Subscribe to parsed key events. Returns an unsubscribe function. */
export function onKey(handler: (k: KeyEvent) => void): () => void {
  const listener = (
    str: string,
    key: { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; sequence?: string }
  ) => {
    handler({
      name: key?.name ?? "",
      ctrl: Boolean(key?.ctrl),
      shift: Boolean(key?.shift),
      meta: Boolean(key?.meta),
      sequence: str ?? "",
    });
  };
  stdin.on("keypress", listener);
  return () => {
    stdin.removeListener("keypress", listener);
  };
}

/** Turn raw mode back off (used on shutdown). */
export function restoreRawMode(): void {
  if (stdin.isTTY) stdin.setRawMode(false);
}
