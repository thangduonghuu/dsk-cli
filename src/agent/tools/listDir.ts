import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./index.js";

const schema = z.object({
  path: z.string().optional().describe("Directory to list; defaults to the project root."),
});

const MAX_ENTRIES = 500;

export const listDirTool: Tool = {
  name: "list_dir",
  description: "List the contents of a directory, directories first, with file sizes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list; defaults to the project root." },
    },
  },
  needsPermission: false,
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    let args: z.infer<typeof schema>;
    try {
      args = schema.parse(rawArgs);
    } catch (e) {
      return { ok: false, output: `Invalid arguments: ${(e as Error).message}` };
    }
    const dir = resolve(ctx.cwd, args.path ?? ".");
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return { ok: false, output: `Could not list ${dir}: ${(e as Error).message}` };
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const shown = entries.slice(0, MAX_ENTRIES);
    const lines = shown.map((e) => {
      if (e.isDirectory()) return `${e.name}/`;
      try {
        const size = statSync(resolve(dir, e.name)).size;
        return `${e.name}  (${size} bytes)`;
      } catch {
        return e.name;
      }
    });
    let note = "";
    if (entries.length > MAX_ENTRIES) {
      note = `\n(${entries.length} entries total; showing first ${MAX_ENTRIES}.)`;
    }
    return { ok: true, output: lines.join("\n") + note };
  },
};
