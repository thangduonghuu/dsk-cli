import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./index.js";

const schema = z.object({
  command: z.string().describe("Shell command to run, e.g. `npm test` or `git status`."),
  timeout: z.number().int().positive().max(300_000).optional().describe("Max runtime in ms (default 30s, max 5min)."),
});

const DEFAULT_TIMEOUT = 30_000;
const MAX_CAPTURE = 30_000;

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the project directory and capture stdout, stderr, and the exit code. Use for builds, tests, git, and anything else the terminal can do.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      timeout: { type: "integer", description: "Max runtime in ms (default 30000, max 300000)." },
    },
    required: ["command"],
  },
  needsPermission: true,
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    let args: z.infer<typeof schema>;
    try {
      args = schema.parse(rawArgs);
    } catch (e) {
      return { ok: false, output: `Invalid arguments: ${(e as Error).message}` };
    }
    // The FULL command is the permission identity (the gate truncates only
    // what is displayed), so "always" can never auto-approve a different
    // command that merely shares a long prefix.
    const allowed = await ctx.requestPermission(`bash: ${args.command}`);
    if (!allowed) {
      return { ok: false, output: "Permission denied by the user — command was not run." };
    }

    return new Promise<ToolResult>((resolveResult) => {
      const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT;
      const child = spawn(args.command, {
        cwd: ctx.cwd,
        shell: true,
        // Own process group so a timeout can kill the whole tree, not just the
        // shell (otherwise grandchildren like `npm test` keep running).
        detached: true,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const startedAt = Date.now();
      let stdout = "";
      let stderr = "";
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, "SIGKILL"); // negative pid = the group
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs);

      const appendCapped = (buf: string, incoming: string, truncated: boolean): { next: string; truncated: boolean } => {
        if (truncated) return { next: buf, truncated };
        const next = buf + incoming;
        if (next.length > MAX_CAPTURE) return { next: next.slice(0, MAX_CAPTURE), truncated: true };
        return { next, truncated };
      };

      child.stdout?.on("data", (d: Buffer) => {
        const r = appendCapped(stdout, d.toString(), stdoutTruncated);
        stdout = r.next;
        stdoutTruncated = r.truncated;
      });
      child.stderr?.on("data", (d: Buffer) => {
        const r = appendCapped(stderr, d.toString(), stderrTruncated);
        stderr = r.next;
        stderrTruncated = r.truncated;
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolveResult({ ok: false, output: `Failed to spawn command: ${err.message}` });
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const durMs = Date.now() - startedAt;
        const dur = durMs < 1000 ? `${durMs}ms` : `${(durMs / 1000).toFixed(1)}s`;
        if (stdoutTruncated) stdout += "\n…(stdout truncated)";
        if (stderrTruncated) stderr += "\n…(stderr truncated)";
        const parts: string[] = [];
        if (stdout.trim()) parts.push(stdout.replace(/\n$/, ""));
        if (stderr.trim()) parts.push(`[stderr]\n${stderr.replace(/\n$/, "")}`);
        if (timedOut) parts.push(`[timed out after ${timeoutMs}ms]`);
        else if (signal) parts.push(`[killed by signal ${signal}]`);
        parts.push(`[exit code: ${code ?? "null"}, ${dur}]`);
        return resolveResult({ ok: code === 0 && !timedOut, output: parts.join("\n") });
      });
    });
  },
};
