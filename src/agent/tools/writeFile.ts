import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { lineDiffHunks } from "../../ui/diff.js";
import type { Tool, ToolContext, ToolResult } from "./index.js";

const schema = z.object({
  path: z.string().describe("Path of the file to write, relative to the project or absolute."),
  content: z.string().describe("Full new contents of the file. Overwrites any existing file."),
});

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Create a new file or fully overwrite an existing one. Parent directories are created automatically. Use edit_file for targeted changes to existing files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file to write." },
      content: { type: "string", description: "Full new contents of the file." },
    },
    required: ["path", "content"],
  },
  needsPermission: true,
  async execute(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    let args: z.infer<typeof schema>;
    try {
      args = schema.parse(rawArgs);
    } catch (e) {
      return { ok: false, output: `Invalid arguments: ${(e as Error).message}` };
    }
    const filePath = resolve(ctx.cwd, args.path);
    const allowed = await ctx.requestPermission(`write_file: ${args.path}`, "write_file");
    if (!allowed) {
      return { ok: false, output: "Permission denied by the user — file was not written." };
    }
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      // Best-effort old content so /diff can show what changed on overwrite.
      let oldText = "";
      try {
        if (existsSync(filePath)) oldText = readFileSync(filePath, "utf8");
      } catch {
        /* ignore unreadable previous content */
      }
      writeFileSync(filePath, args.content, "utf8");
      const hunks = lineDiffHunks(oldText, args.content);
      return {
        ok: true,
        output: `Wrote ${args.content.length} bytes to ${args.path}.`,
        diff: hunks.length > 0 ? { path: args.path, hunks } : undefined,
      };
    } catch (e) {
      return { ok: false, output: `Could not write ${filePath}: ${(e as Error).message}` };
    }
  },
};
