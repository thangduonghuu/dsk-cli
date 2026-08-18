import { stdout } from "node:process";

/**
 * Tracks the terminal cursor's row/column (1-based) by observing stdout writes.
 *
 * The editor needs to know where the last line of transcript content sits so it
 * can pin the prompt block to the bottom of the screen: when content fills the
 * terminal, the block must scroll the transcript up instead of overwriting its
 * tail. Rather than querying the terminal (DSR `\x1b[6n` — async, not supported
 * everywhere), we mirror the cursor position from every write we make.
 *
 * The tracker is deliberately approximate: it only needs to be right at
 * `Editor.pin()` time, and the editor's absolute CUP (`\x1b[<row>;1H`) on every
 * render re-syncs it. Child processes (less, bash) write to fd 1 directly, so
 * they are invisible here — which is fine, since the editor skips the scroll
 * decision around pagers.
 */
class CursorTracker {
  row = 1;
  col = 1;
  rows = stdout.rows || 24;
  cols = stdout.columns || 80;
  private orig: ((chunk: unknown, ...rest: unknown[]) => boolean) | null = null;

  /** Wrap process.stdout.write so every byte we emit updates the position. */
  attach(): void {
    if (this.orig) return;
    this.orig = stdout.write.bind(stdout) as (chunk: unknown, ...rest: unknown[]) => boolean;
    const tracker = this;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stdout as any).write = (chunk: unknown, ...rest: unknown[]): boolean => {
      tracker.observe(String(chunk));
      return (tracker.orig as (chunk: unknown, ...rest: unknown[]) => boolean)(chunk, ...rest);
    };
    stdout.on("resize", () => {
      tracker.rows = stdout.rows || 24;
      tracker.cols = stdout.columns || 80;
    });
  }

  /** Force the tracked position (used after external programs / alt screens). */
  set(row: number, col: number): void {
    this.row = Math.max(1, Math.min(this.rows, row));
    this.col = Math.max(1, Math.min(this.cols, col));
  }

  /** Walk a written string, updating the cursor position as a terminal would. */
  private observe(s: string): void {
    if (!s.includes("\x1b") && !s.includes("\n") && !s.includes("\r")) {
      // Plain text on one line: advance, wrapping at the right edge.
      const w = s.length;
      this.col += w;
      while (this.col > this.cols) {
        this.col -= this.cols;
        if (this.row < this.rows) this.row += 1;
        // At the bottom row the terminal scrolls; the cursor stays put.
      }
      return;
    }
    let i = 0;
    const n = s.length;
    while (i < n) {
      const ch = s[i];
      if (ch === "\x1b") {
        if (s[i + 1] === "[") {
          // CSI: collect parameters until a final byte.
          let j = i + 2;
          let params = "";
          while (j < n && /[0-9;?$]/.test(s[j])) {
            params += s[j];
            j += 1;
          }
          const final = s[j];
          if (final) {
            const digits = (p: string): number => {
              const d = p.replace(/\D/g, "");
              return d ? parseInt(d, 10) : 1;
            };
            const ps = params.split(";").map(digits);
            const p1 = ps[0] ?? 1;
            const p2 = ps[1] ?? 1;
            if (final === "H" || final === "f") {
              this.row = Math.max(1, Math.min(this.rows, p1));
              this.col = Math.max(1, Math.min(this.cols, p2));
            } else if (final === "A") {
              this.row = Math.max(1, this.row - p1);
            } else if (final === "B") {
              this.row = Math.min(this.rows, this.row + p1);
            } else if (final === "C") {
              this.col = Math.min(this.cols, this.col + p1);
            } else if (final === "D") {
              this.col = Math.max(1, this.col - p1);
            } else if (final === "G") {
              this.col = Math.max(1, Math.min(this.cols, p1));
            } else if (final === "d") {
              this.row = Math.max(1, Math.min(this.rows, p1));
            } else if (final === "J") {
              const mode = params === "2" || params === "3" ? 2 : 0;
              if (mode === 2) {
                this.row = 1;
                this.col = 1;
              }
            }
            // K (erase line), S (scroll), m (SGR), h/l (modes) don't move the
            // cursor in a way that matters here.
          }
          i = final ? j + 1 : j;
          continue;
        }
        // Other escape: skip two bytes (ESC + one char).
        i += 2;
        continue;
      }
      if (ch === "\n") {
        if (this.row < this.rows) this.row += 1;
        this.col = 1;
        i += 1;
        continue;
      }
      if (ch === "\r") {
        this.col = 1;
        i += 1;
        continue;
      }
      if (ch === "\t") {
        this.col = Math.min(this.cols, this.col + (8 - ((this.col - 1) % 8)));
        i += 1;
        continue;
      }
      if (ch === "\b") {
        this.col = Math.max(1, this.col - 1);
        i += 1;
        continue;
      }
      // Printable char (ANSI control chars other than the above are rare in
      // the content we emit; treat them as width-1).
      this.col += 1;
      if (this.col > this.cols) {
        this.col = 1;
        if (this.row < this.rows) this.row += 1;
      }
      i += 1;
    }
  }
}

/** Singleton used by the editor (and only the editor). */
export const cursor = new CursorTracker();
