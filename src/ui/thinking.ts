import type { Palette } from "./theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Minimal "thinking…" indicator rendered in place with simple line-erase
 * ANSI (`\r` + clear line). Deliberately avoids full-screen cursor machinery:
 * the turn owns stdout until the first token, so the indicator is always the
 * last line and can be erased with a single CR + EL sequence.
 */
export class ThinkingIndicator {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private active = false;
  private tty: boolean;

  constructor(private palette: Palette, tty: boolean) {
    this.tty = tty;
  }

  start(): void {
    if (this.active || !this.tty) return;
    this.active = true;
    this.frame = 0;
    process.stdout.write(this.render());
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      process.stdout.write(`\r${this.render()}`);
    }, 80);
  }

  /** Erase the indicator (call when the first token arrives or the turn ends). */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.stdout.write("\r\x1b[K");
  }

  private render(): string {
    return this.palette.dim(` ${FRAMES[this.frame]} thinking…`);
  }
}
