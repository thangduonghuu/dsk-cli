import { stdout } from "node:process";
import chalk from "chalk";
import { onKey, type KeyEvent } from "./keys.js";
import { cursor } from "./cursor.js";
import type { Completion } from "./complete.js";

const ESC = "\x1b";
const hideCursor = `${ESC}[?25l`;
const showCursor = `${ESC}[?25h`;
const eraseDown = `${ESC}[J`;
/** Bracketed paste: lets the terminal wrap pastes so pasted \r ≠ Enter. */
const bracketedPasteOn = `${ESC}[?2004h`;
const bracketedPasteOff = `${ESC}[?2004l`;

export interface EditorCallbacks {
  /** Returns the footer/status line (or null). Re-evaluated on every render. */
  footer?: () => string | null;
  /** Async completion used by Tab (e.g. `/` commands and `@` paths). */
  complete?: (text: string, cursor: number) => Promise<Completion | null>;
  /** Shift+Tab: permission-mode cycling. */
  onShiftTab?: () => void;
  /** Ctrl+C on an empty prompt (REPL decides: exit confirm etc.). */
  onCtrlC?: () => void;
  /** Ctrl+D / EOF. */
  onCtrlD?: () => void;
  /** Ctrl+O: open the transcript viewer (REPL suspends the editor for a pager). */
  onCtrlO?: () => void;
  /** Style multiline continuation markers. */
  contStyle?: (s: string) => string;
}

interface SuggState {
  start: number;
  end: number;
  matches: string[];
  /** Index of the match the next Tab will insert. */
  cycle: number;
}

/**
 * A scrollback-friendly line editor for TTY REPLs, modeled on Claude Code's
 * prompt bar: multiline input (`\`+Enter, Ctrl+J), command/path completion,
 * history navigation, and a footer drawn under the prompt.
 */
export class Editor {
  private prompt = "";
  private promptWidth = 0;
  private text = "";
  private pos = 0;
  private multiline = true;
  private useHistory = true;
  private pending: ((v: string | null) => void) | null = null;
  private lastRows = 0;
  private lastCursorRow = 0;
  /** True while the prompt block is drawn at the bottom of the screen. */
  private blockOnScreen = false;
  private toast: string[] = [];
  /** Live completion candidates (shown as a popup above the input). */
  private sugg: SuggState | null = null;
  /** Bump on every keystroke so stale async completions are dropped. */
  private suggToken = 0;
  /** Non-null while a bracketed paste is being received (buffered, not yet
   * inserted), so pasted newlines never submit the prompt. */
  private pasteBuf: string | null = null;
  private histIdx = -1;
  private draft = "";
  private history: string[];
  private offKey: () => void;
  private onResize: () => void;

  constructor(
    private cb: EditorCallbacks,
    history: string[] = [],
    private pinToBottom = true
  ) {
    this.history = history;
    cursor.attach(); // track the cursor row so pin() can scroll a full screen
    this.offKey = onKey(this.keyHandler);
    this.onResize = () => {
      if (this.pending) this.render(); // never redraw mid-turn
    };
    stdout.on("resize", this.onResize);
  }

  /**
   * Prepare the screen for the prompt block pinned to the bottom (Claude Code's
   * input bar). Clears stale content below the transcript, and — when the
   * transcript fills the terminal — scrolls it up so the block never
   * overwrites the tail of the conversation.
   */
  private pin(): void {
    if (!this.pinToBottom) return;
    const footer = this.cb.footer?.() ?? null;
    const { lines } = this.layout(footer);
    const barH = Math.max(1, lines.length);
    const rows = stdout.rows || 24;
    const start = Math.max(1, rows - barH + 1);
    if (this.blockOnScreen) {
      // The block is already drawn at the bottom (e.g. a pager restored the
      // screen); render() redraws it in place, so there is nothing to scroll.
      return;
    }
    // Clear anything stale below the end of the transcript content.
    stdout.write(eraseDown);
    // If the content extends into the region the block will occupy, scroll it
    // up (cursor on the last row + newline = scroll) so the block fits flush
    // at the bottom and the transcript's last lines stay visible above it.
    const cur = cursor.row;
    if (cur > start - 1) {
      const scroll = cur - start + 1;
      stdout.write(`\x1b[${rows};1H`);
      stdout.write("\n".repeat(scroll));
    }
  }

  private keyHandler = (k: KeyEvent): void => {
    void this.handleKey(k);
  };

  /**
   * Suspend the editor (unsubscribe keys, move to a fresh line) so an external
   * pager like `less` can take over the terminal. Call resume() afterwards.
   */
  pause(): void {
    this.offKey();
    stdout.off("resize", this.onResize);
    stdout.write(bracketedPasteOff);
    stdout.write(showCursor);
    stdout.write("\r\n");
  }

  /** Re-attach keys and redraw the prompt block after a pager/viewer. */
  resume(): void {
    this.offKey = onKey(this.keyHandler);
    stdout.on("resize", this.onResize);
    stdout.write(bracketedPasteOn);
    this.pin();
    this.render();
  }

  close(): void {
    this.pause();
  }

  /** Show a one-shot status toast above the input (e.g. "press again to exit"). */
  showToast(lines: string[]): void {
    this.toast = lines.map((l) => chalk.dim(l));
    this.render();
  }

  /** Resolve any in-flight ask() with null (used to unblock Ctrl+C during turns). */
  interrupt(): void {
    if (this.pending) {
      const r = this.pending;
      this.pending = null;
      r(null);
    }
  }

  /**
   * Ask for input. Resolves with the entered line, or null on EOF/interrupt.
   * `multiline` enables `\`+Enter and Ctrl+J; `history` enables up/down recall.
   */
  ask(prompt: string, opts: { multiline?: boolean; history?: boolean; width?: number } = {}): Promise<string | null> {
    this.prompt = prompt;
    this.promptWidth = opts.width ?? plainWidth(prompt);
    this.multiline = opts.multiline ?? true;
    this.useHistory = opts.history ?? true;
    this.text = "";
    this.pos = 0;
    this.toast = [];
    this.sugg = null;
    this.suggToken += 1; // invalidate any in-flight completion from a previous prompt
    this.histIdx = -1;
    this.draft = "";
    this.pin();
    this.render();
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  // ------------------------------------------------------------------ keys

  private handleKey(k: KeyEvent): void {
    if (!this.pending) return;

    // Bracketed paste: buffer everything until paste-end, then insert it as
    // literal text. Inside a paste the newlines come through as `return` key
    // events, which would otherwise submit the prompt mid-paste.
    if (k.name === "paste-start") {
      this.pasteBuf = "";
      return;
    }
    if (k.name === "paste-end") {
      this.finishPaste();
      return;
    }
    if (this.pasteBuf !== null) {
      this.pasteBuf += k.sequence || "";
      return;
    }

    if (k.ctrl && k.name === "c") {
      if (this.text) {
        this.clearDraft();
      } else {
        this.cb.onCtrlC?.();
      }
      return;
    }
    if (k.ctrl && k.name === "d") {
      this.cb.onCtrlD?.();
      return;
    }
    if (k.ctrl && k.name === "o") {
      this.cb.onCtrlO?.();
      return;
    }
    if (k.name === "escape") {
      if (this.text) this.clearDraft();
      return;
    }
    if (k.name === "return") {
      this.handleEnter();
      return;
    }
    if (k.ctrl && k.name === "j") {
      if (this.multiline) this.insert("\n");
      return;
    }
    if (k.name === "tab") {
      if (k.shift) {
        this.sugg = null;
        this.toast = [];
        this.cb.onShiftTab?.();
        this.render();
      } else {
        void this.handleTab();
      }
      return;
    }

    // Everything else clears the toast (completion state is refreshed on any
    // text mutation, and cursor moves keep the popup visible).
    this.toast = [];

    switch (k.name) {
      case "backspace":
        this.backspace();
        return;
      case "delete":
        this.del();
        return;
      case "left":
        if (this.pos > 0) {
          this.pos -= 1;
          this.render();
        }
        return;
      case "right":
        if (this.pos < this.text.length) {
          this.pos += 1;
          this.render();
        }
        return;
      case "up":
        if (!this.moveLine(-1)) this.historyPrev();
        return;
      case "down":
        if (!this.moveLine(1)) this.historyNext();
        return;
      case "home":
        this.pos = this.lineStart();
        this.render();
        return;
      case "end":
        this.pos = this.lineEnd();
        this.render();
        return;
    }
    if (k.ctrl && k.name === "u") {
      this.pos = this.lineStart();
      this.text = this.text.slice(this.pos);
      void this.refreshSugg();
      this.render();
      return;
    }
    if (k.ctrl && k.name === "k") {
      this.text = this.text.slice(0, this.pos);
      void this.refreshSugg();
      this.render();
      return;
    }
    if (k.ctrl && k.name === "w") {
      const before = this.text.slice(0, this.pos);
      const m = before.match(/(\s*\S*)$/);
      if (m) {
        const cut = this.pos - m[0].length;
        this.text = this.text.slice(0, cut) + this.text.slice(this.pos);
        this.pos = cut;
        void this.refreshSugg();
        this.render();
      }
      return;
    }
    if (k.ctrl && k.name === "a") {
      this.pos = 0;
      this.render();
      return;
    }
    if (k.ctrl && k.name === "e") {
      this.pos = this.text.length;
      this.render();
      return;
    }
    if (k.ctrl && k.name === "l") {
      this.render();
      return;
    }
    // Printable character (raw mode delivers the literal char in `sequence`).
    if (k.sequence.length > 0 && !k.ctrl && !k.meta) {
      this.insert(k.sequence);
    }
  }

  private backspace(): void {
    if (this.pos === 0) return;
    this.text = this.text.slice(0, this.pos - 1) + this.text.slice(this.pos);
    this.pos -= 1;
    this.toast = [];
    void this.refreshSugg();
    this.render();
  }

  private del(): void {
    if (this.pos >= this.text.length) return;
    this.text = this.text.slice(0, this.pos) + this.text.slice(this.pos + 1);
    this.toast = [];
    void this.refreshSugg();
    this.render();
  }

  private clearDraft(): void {
    this.text = "";
    this.pos = 0;
    this.toast = [];
    void this.refreshSugg();
    this.render();
  }

  private insert(s: string): void {
    this.text = this.text.slice(0, this.pos) + s + this.text.slice(this.pos);
    this.pos += s.length;
    this.toast = [];
    void this.refreshSugg();
    this.render();
  }

  /**
   * Insert a completed bracketed paste as literal text at the cursor. Normalizes
   * CR/CRLF (what terminals send for pasted newlines) to LF and drops trailing
   * blank lines, so the user stays at the prompt until they press Enter.
   */
  private finishPaste(): void {
    const buf = this.pasteBuf ?? "";
    this.pasteBuf = null;
    const cleaned = buf.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "");
    if (cleaned) this.insert(cleaned);
  }

  private handleEnter(): void {
    // `\` + Enter inserts a newline (Claude Code's "quick escape").
    const cur = this.text.slice(this.lineStart());
    const trimmed = cur.replace(/\s+$/, "");
    if (this.multiline && trimmed.endsWith("\\")) {
      const removeAt = this.pos - (cur.length - trimmed.length + 1);
      this.text = this.text.slice(0, removeAt) + this.text.slice(this.pos);
      this.pos = removeAt;
      this.insert("\n");
      return;
    }
    this.submit();
  }

  /**
   * Tab inserts the currently highlighted suggestion and moves the highlight to
   * the next candidate. If no live popup is up yet (async completion pending or
   * none), fetch candidates directly and apply the first.
   */
  private async handleTab(): Promise<void> {
    if (!this.cb.complete) return;
    if (this.sugg && this.sugg.matches.length > 0) {
      this.applySugg(); // insert the highlighted match
      this.sugg.cycle = (this.sugg.cycle + 1) % this.sugg.matches.length;
      this.render();
      return;
    }
    const c = await this.cb.complete(this.text, this.pos);
    if (!c || c.matches.length === 0) return;
    this.sugg = { start: c.start, end: c.end, matches: c.matches, cycle: 0 };
    this.applySugg();
    this.sugg.cycle = (this.sugg.cycle + 1) % this.sugg.matches.length;
    this.render();
  }

  /** Replace the completion range with the highlighted match. */
  private applySugg(): void {
    const s = this.sugg;
    if (!s) return;
    const m = s.matches[s.cycle];
    this.text = this.text.slice(0, s.start) + m + this.text.slice(s.end);
    this.pos = s.start + m.length;
    // Keep the range in sync so cycling between matches of different lengths
    // replaces the previous match instead of appending to it.
    s.end = s.start + m.length;
  }

  /**
   * Recompute the live suggestion popup for the current text. Async so the
   * `complete` callback can do filesystem work (`@` paths); a token guards
   * against out-of-order resolutions when typing fast.
   */
  private async refreshSugg(): Promise<void> {
    if (!this.cb.complete) {
      this.sugg = null;
      return;
    }
    const token = ++this.suggToken;
    const c = await this.cb.complete(this.text, this.pos);
    if (token !== this.suggToken) return; // a newer keystroke superseded this
    this.sugg = c && c.matches.length > 0 ? { start: c.start, end: c.end, matches: c.matches, cycle: 0 } : null;
    if (this.pending) this.render();
  }

  /**
   * Render the suggestion popup: a vertical list of candidates above the input,
   * with the next-Tab match highlighted. Long lists are windowed so the popup
   * never takes over the terminal.
   */
  private suggestionLines(): string[] {
    const s = this.sugg;
    if (!s || s.matches.length === 0) return [];
    const MAX = 8;
    const total = s.matches.length;
    let start = 0;
    if (total > MAX) {
      start = Math.max(0, Math.min(s.cycle - Math.floor(MAX / 2), total - MAX));
    }
    const out: string[] = [];
    for (let i = start; i < Math.min(start + MAX, total); i++) {
      const m = s.matches[i];
      const selected = i === s.cycle;
      const marker = selected ? chalk.cyan("❯") : " ";
      out.push(selected ? `${marker} ${chalk.inverse(m)}` : `${marker} ${chalk.dim(m)}`);
    }
    return out;
  }

  // ------------------------------------------------------------- navigation

  private lineStart(): number {
    return this.text.lastIndexOf("\n", this.pos - 1) + 1;
  }
  private lineEnd(): number {
    const idx = this.text.indexOf("\n", this.pos);
    return idx === -1 ? this.text.length : idx;
  }

  /** Move the cursor one logical line up/down. Returns true if moved. */
  private moveLine(dir: 1 | -1): boolean {
    const lineStart = this.lineStart();
    const lineEnd = this.lineEnd();
    const col = this.pos - lineStart;
    if (dir === -1) {
      if (lineStart === 0) return false;
      const prevEnd = lineStart - 1;
      const prevStart = this.text.lastIndexOf("\n", prevEnd - 1) + 1;
      this.pos = prevStart + Math.min(col, prevEnd - prevStart);
      this.render();
      return true;
    }
    if (lineEnd === this.text.length) return false;
    const nextStart = lineEnd + 1;
    const nextEnd = this.text.indexOf("\n", nextStart);
    const end = nextEnd === -1 ? this.text.length : nextEnd;
    this.pos = nextStart + Math.min(col, end - nextStart);
    this.render();
    return true;
  }

  private historyPrev(): void {
    if (!this.useHistory || this.history.length === 0) return;
    if (this.histIdx === -1) {
      this.draft = this.text;
      this.histIdx = this.history.length - 1;
    } else if (this.histIdx > 0) {
      this.histIdx -= 1;
    } else {
      return;
    }
    this.setText(this.history[this.histIdx] ?? "");
  }

  private historyNext(): void {
    if (!this.useHistory || this.histIdx === -1) return;
    this.histIdx += 1;
    if (this.histIdx >= this.history.length) {
      this.histIdx = -1;
      this.setText(this.draft);
    } else {
      this.setText(this.history[this.histIdx] ?? "");
    }
  }

  private setText(t: string): void {
    this.text = t;
    this.pos = t.length;
    void this.refreshSugg();
    this.render();
  }

  // ---------------------------------------------------------------- submit

  private submit(): void {
    const line = this.text;
    if (this.useHistory && line.trim() !== "") {
      if (this.history[this.history.length - 1] !== line) {
        this.history.push(line);
        if (this.history.length > 100) this.history.shift();
      }
    }
    this.redrawAsTranscript(line);
    const resolve = this.pending;
    this.pending = null;
    resolve?.(line);
  }

  /** Erase the prompt block and print the submitted line as a transcript turn. */
  private redrawAsTranscript(line: string): void {
    // The block was drawn flush at rows-lastRows+1..rows; erase it absolutely
    // (robust regardless of where the cursor happens to be).
    if (this.lastRows > 0) {
      const rows = stdout.rows || 24;
      const start = Math.max(1, rows - this.lastRows + 1);
      stdout.write(`${ESC}[${start};1H`);
      stdout.write(eraseDown);
    }
    const [first, ...rest] = line.split("\n");
    // Blank line above each submitted turn (Claude Code's transcript rhythm),
    // then echo the full prompt + answer so permission Q&As stay in transcript.
    const echo = ["", `${this.prompt}${first}`];
    for (const r of rest) echo.push(`${this.cb.contStyle ? this.cb.contStyle("  │ ") : "  │ "}${r}`);
    stdout.write(echo.join("\n") + "\n");
    this.lastRows = 0;
    this.lastCursorRow = 0;
    this.blockOnScreen = false;
  }

  // --------------------------------------------------------------- render

  /**
   * Render the prompt block (input + completion toast + footer) pinned flush to
   * the bottom of the screen. Positioning is absolute (`CUP` to the block's
   * first row), so repeated renders never drift and never scroll the screen;
   * the footer's last line is written without a trailing newline so the block
   * ends exactly on the last terminal row.
   */
  private render(): void {
    const footer = this.cb.footer?.() ?? null;
    const { lines, cursorRow, cursorCol, suggCount } = this.layout(footer);
    const barH = lines.length;
    const rows = stdout.rows || 24;
    const start = Math.max(1, rows - barH + 1);

    // Erase the whole region the block may have occupied (old height OR new),
    // so a shrinking block (e.g. a toast clearing) never leaves stale rows.
    const oldStart = this.lastRows > 0 ? Math.max(1, rows - this.lastRows + 1) : start;
    stdout.write(`${ESC}[${Math.min(oldStart, start)};1H`);
    stdout.write(eraseDown);
    stdout.write(`${ESC}[${start};1H`);
    stdout.write(hideCursor);
    for (let i = 0; i < lines.length; i++) {
      stdout.write(lines[i]);
      if (i < lines.length - 1) stdout.write("\n");
    }
    stdout.write(showCursor);
    // Move from the block's last row up to the input cursor's row, then right
    // to the cursor column. Toast + suggestion lines sit above the input, so
    // they offset it.
    const up = barH - 1 - this.toast.length - suggCount - cursorRow;
    if (up > 0) stdout.write(`${ESC}[${up}A`);
    stdout.write(`\r${ESC}[${cursorCol}C`);

    this.lastRows = barH;
    this.lastCursorRow = cursorRow;
    this.blockOnScreen = true;
  }

  private layout(footer: string | null): { lines: string[]; cursorRow: number; cursorCol: number; suggCount: number } {
    const cols = stdout.columns || 80;
    const promptW = this.promptWidth;
    const contW = 4; // "  │ "

    const logical = this.text.split("\n");
    // Locate the cursor's logical line and column.
    let remaining = this.pos;
    let cursorLine = 0;
    for (let i = 0; i < logical.length; i++) {
      if (remaining <= logical[i].length) {
        cursorLine = i;
        break;
      }
      remaining -= logical[i].length + 1;
      cursorLine = i + 1;
    }
    if (cursorLine >= logical.length) cursorLine = Math.max(0, logical.length - 1);
    const cursorColInLine = remaining;

    const lines: string[] = [];
    const visualRows: number[] = [];
    for (let i = 0; i < logical.length; i++) {
      const line = logical[i];
      const isFirst = i === 0;
      const prefixPlain = isFirst ? this.prompt : "  │ ";
      const prefixStyled = isFirst ? prefixPlain : this.cb.contStyle ? this.cb.contStyle(prefixPlain) : prefixPlain;
      const prefixW = isFirst ? this.promptWidth : prefixPlain.length;
      const avail = Math.max(1, cols - prefixW);
      const rows = Math.max(1, Math.ceil(line.length / avail));
      visualRows.push(rows);
      for (let r = 0; r < rows; r++) {
        const seg = line.slice(r * avail, (r + 1) * avail);
        lines.push(r === 0 ? prefixStyled + seg : seg);
      }
    }

    // Cursor visual position.
    let cursorRow = 0;
    for (let i = 0; i < cursorLine; i++) cursorRow += visualRows[i] ?? 1;
    const cLine = logical[cursorLine] ?? "";
    const cPrefixW = cursorLine === 0 ? promptW : contW;
    const cAvail = Math.max(1, cols - cPrefixW);
    const lineRows = visualRows[cursorLine] ?? 1;
    let rowOff = Math.floor(cursorColInLine / cAvail);
    if (rowOff >= lineRows) rowOff = lineRows - 1;
    cursorRow += rowOff;
    const cursorCol = cPrefixW + (cursorColInLine - rowOff * cAvail);

    const sugg = this.suggestionLines();
    const all: string[] = [...this.toast, ...sugg, ...lines];
    if (footer) all.push(...footer.split("\n"));
    return { lines: all, cursorRow, cursorCol, suggCount: sugg.length };
  }
}

/** Width of a possibly-ANSI-styled string in terminal columns. */
function plainWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
