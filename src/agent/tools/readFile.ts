import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./index.js";

const schema = z.object({
  path: z.string().describe("Path to the file to read, relative to the project or absolute."),
  offset: z.number().int().positive().optional().describe("1-based line number to start from."),
  limit: z.number().int().positive().optional().describe("Max number of lines to return."),
});

const DEFAULT_LIMIT = 2000;

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a text file with line numbers. Large files are truncated at 2000 lines by default; use offset/limit to page through. Returns contents plus a truncation note when applicable.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file, relative to the project or absolute." },
      offset: { type: "integer", description: "1-based line number to start from." },
      limit: { type: "integer", description: "Max number of lines to return." },
    },
    required: ["path"],
  },
  needsPermission: false,
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    let args: z.infer<typeof schema>;
    try {
      args = schema.parse(rawArgs);
    } catch (e) {
      return { ok: false, output: `Invalid arguments: ${(e as Error).message}` };
    }
    const filePath = resolve(ctx.cwd, args.path);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (e) {
      return { ok: false, output: `Could not read ${filePath}: ${(e as Error).message}` };
    }
    const lines = content.split("\n");
    const total = lines.length;
    const offset = args.offset ?? 1;
    const limit = args.limit ?? DEFAULT_LIMIT;
    const start = Math.max(1, offset);
    const end = Math.min(total, start + limit - 1);
    const slice = lines.slice(start - 1, end);
    const width = String(end).length;
    const body = slice.map((line, i) => `${String(start + i).padStart(width)} | ${line}`).join("\n");
    let note = "";
    if (end < total) {
      note = `\n\n(File has ${total} lines; showing ${start}-${end}. Use offset=${end + 1} to continue.)`;
    } else if (start > 1) {
      note = `\n\n(End of file, ${total} lines.)`;
    }
    return { ok: true, output: body + note };
  },
};
