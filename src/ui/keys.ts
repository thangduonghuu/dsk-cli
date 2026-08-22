import { stdin, stdout } from "node:process";
import { emitKeypressEvents } from "node:readline";

export interface KeyEvent {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  sequence: string;
}

/** Enable/disable bracketed paste so pasted newlines (\r) are distinguishable
 * from the real Enter key. Node's readline reports the wrap markers as
 * `paste-start` / `paste-end` key events. */
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";

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
  if (stdin.isTTY) {
    stdin.setRawMode(true);
    stdout.write(BRACKETED_PASTE_ON);
  }
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

/** Turn raw mode and bracketed paste back off (used on shutdown). */
export function restoreRawMode(): void {
  if (stdin.isTTY) {
    stdout.write(BRACKETED_PASTE_OFF);
    stdin.setRawMode(false);
  }
}
