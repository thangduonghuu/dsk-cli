import * as readline from "node:readline";
import { stdin, stdout } from "node:process";

export interface Prompter {
  /**
   * Ask a question and resolve with the user's line. Resolves null on EOF
   * (e.g. piped stdin closed) or when interrupted via interrupt().
   */
  ask(question: string): Promise<string | null>;
  /** Resolve any in-flight ask() with null (used to break a Ctrl+C deadlock). */
  interrupt(): void;
  close(): void;
  onSigint(handler: () => void): void;
}

/**
 * A readline wrapper built on a manual line queue.
 *
 * Why not readline's question()/async-iterator: with pre-buffered (piped)
 * stdin, question() — promises and callback variants alike — stalls on the
 * second call when the module uses top-level await (a Node quirk). The manual
 * queue calls rl.resume() per ask, which keeps the stream flowing, and it lets
 * us force-resolve a pending ask via interrupt() (needed so Ctrl+C during a
 * permission prompt can't deadlock the agent turn).
 *
 * In TTY mode, stray Enter presses while no ask is pending are dropped,
 * matching question()'s behavior; in non-terminal mode they are buffered,
 * which is exactly what piped pre-buffered input needs.
 */
export function createPrompter(terminal: boolean): Prompter {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal });
  let pending: ((v: string | null) => void) | null = null;
  const buffered: string[] = [];

  rl.on("line", (line: string) => {
    if (pending) {
      const p = pending;
      pending = null;
      p(line);
    } else if (!terminal) {
      buffered.push(line); // piped input may arrive before the first ask
    }
  });
  rl.on("close", () => {
    if (pending) {
      const p = pending;
      pending = null;
      p(null);
    }
  });

  return {
    ask: (question: string): Promise<string | null> =>
      new Promise((resolve) => {
        process.stdout.write(question);
        if (buffered.length > 0) {
          resolve(buffered.shift()!);
          return;
        }
        pending = resolve;
        // Non-terminal readline pauses after each line; resume so queued
        // piped input keeps producing 'line' events.
        rl.resume();
      }),
    interrupt: () => {
      if (pending) {
        const p = pending;
        pending = null;
        p(null);
      }
    },
    close: () => rl.close(),
    onSigint: (handler) => {
      // Only meaningful on a TTY; SIGINT cannot fire on piped input.
      if (terminal) rl.on("SIGINT", handler);
    },
  };
}

/**
 * Ask a single secret question (API key) with the input hidden. TTY-only;
 * the caller must not call this on piped stdin.
 */
export function askSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    // Mute the interface's output so typed characters are not echoed.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    process.stdout.write(prompt);
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}
