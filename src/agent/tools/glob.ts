import { resolve } from "node:path";
import { glob } from "glob";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./index.js";

const schema = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts" or "**/*.test.js".'),
  path: z.string().optional().describe("Directory to search in; defaults to the project root."),
});

const MAX_RESULTS = 1000;

export const globTool: Tool = {
  name: "glob",
  description: "Find files matching a glob pattern (supports *, **, ?, and brace expansion).",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match." },
      path: { type: "string", description: "Directory to search in; defaults to the project root." },
    },
    required: ["pattern"],
  },
  needsPermission: false,
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    let args: z.infer<typeof schema>;
    try {
      args = schema.parse(rawArgs);
    } catch (e) {
      return { ok: false, output: `Invalid arguments: ${(e as Error).message}` };
    }
    const cwd = resolve(ctx.cwd, args.path ?? ".");
    try {
      const matches = await glob(args.pattern, { cwd, nodir: true, dot: false });
      const sorted = matches.sort();
      if (sorted.length === 0) return { ok: true, output: "No files matched." };
      const shown = sorted.slice(0, MAX_RESULTS);
      let note = "";
      if (sorted.length > MAX_RESULTS) {
        note = `\n(${sorted.length} matches total; showing first ${MAX_RESULTS}.)`;
      }
      return { ok: true, output: shown.join("\n") + note };
    } catch (e) {
      return { ok: false, output: `glob failed: ${(e as Error).message}` };
    }
  },
};
