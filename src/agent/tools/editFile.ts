import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { lineDiffHunks, lineDiffStats } from "../../ui/diff.js";
import type { Tool, ToolContext, ToolResult } from "./index.js";

const schema = z.object({
  path: z.string().describe("Path of the file to edit."),
  old_string: z.string().describe("Exact text to find. Must appear exactly once unless replace_all is true."),
  new_string: z.string().describe("Replacement text."),
  replace_all: z.boolean().optional().describe("Replace every occurrence of old_string instead of requiring uniqueness."),
});

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Make a targeted find-and-replace edit in an existing file. Fails loudly if old_string is not found, or if it appears multiple times (unless replace_all is true).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file to edit." },
      old_string: { type: "string", description: "Exact text to find." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match." },
    },
    required: ["path", "old_string", "new_string"],
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
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (e) {
      return { ok: false, output: `Could not read ${filePath}: ${(e as Error).message}` };
    }
    const count = content.split(args.old_string).length - 1;
    if (count === 0) {
      return { ok: false, output: `old_string was not found in ${args.path}. Nothing changed.` };
    }
    if (count > 1 && !args.replace_all) {
      return {
        ok: false,
        output: `old_string appears ${count} times in ${args.path}. Make old_string unique or set replace_all: true. Nothing changed.`,
      };
    }
    const allowed = await ctx.requestPermission(`edit_file: ${args.path}`);
    if (!allowed) {
      return { ok: false, output: "Permission denied by the user — file was not edited." };
    }
    try {
      const updated = args.replace_all ? content.split(args.old_string).join(args.new_string) : content.replace(args.old_string, args.new_string);
      writeFileSync(filePath, updated, "utf8");
      const changed = count > 1 && args.replace_all ? count : 1;
      const stats = lineDiffStats(content, updated);
      const hunks = lineDiffHunks(content, updated);
      return {
        ok: true,
        output: `Edited ${args.path}: ${changed} replacement(s) applied (+${stats.added} −${stats.removed} lines).`,
        diff: hunks.length > 0 ? { path: args.path, hunks } : undefined,
      };
    } catch (e) {
      return { ok: false, output: `Could not write ${filePath}: ${(e as Error).message}` };
    }
  },
};
