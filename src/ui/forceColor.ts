import { stdout } from "node:process";

/**
 * Chalk decides color support at module-load time from the environment. A
 * parent process (shell profile, editor, CI wrapper, agent harness) may leak
 * `TERM=dumb`, `NO_COLOR=1` or `FORCE_COLOR=0`, which silently disables ALL
 * color — making the Claude-Code-style UI look unchanged even though it's
 * rendering fine (the classic "why does my TUI have no color" bug).
 *
 * On a real TTY we force truecolor on so the hex-based palette always renders;
 * piped/non-TTY output stays plain. Tool subprocesses are separately given
 * FORCE_COLOR=0 by the bash tool so colors never leak into captured output.
 *
 * Must be imported BEFORE chalk anywhere in the module graph (it is the first
 * import in the CLI entrypoint).
 */
if (stdout.isTTY) {
  // chalk v6 warns when NO_COLOR and FORCE_COLOR are both set; on a TTY the
  // theme wins, so drop the conflicting env entirely.
  delete process.env.NO_COLOR;
  process.env.FORCE_COLOR = "3"; // chalk v6: 3 = 24-bit truecolor (matches the hex palette)
}
