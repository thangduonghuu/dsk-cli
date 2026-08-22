import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { lineDiffHunks, lineDiffStats } from "../../ui/diff.js";
import type { Tool, ToolContext, ToolResult } from "./index.js";

const editItem = z.object({
  old_string: z.string().describe("Exact text to find. Must appear exactly once unless replace_all is true."),
  new_string: z.string().describe("Replacement text."),
  replace_all: z.boolean().optional().describe("Replace every occurrence of old_string instead of requiring uniqueness."),
});

/**
 * Two shapes, mutually exclusive:
 * - single edit:  { path, old_string, new_string, replace_all? }
 * - multi edit:   { path, edits: [{ old_string, new_string, replace_all? }] }
 */
const schema = z
  .object({
    path: z.string().describe("Path of the file to edit."),
    old_string: z.string().optional().describe("Exact text to find. Must appear exactly once unless replace_all is true."),
    new_string: z.string().optional().describe("Replacement text."),
    replace_all: z.boolean().optional().describe("Replace every occurrence of old_string instead of requiring uniqueness."),
    edits: z
      .array(editItem)
      .min(1)
      .max(25)
      .optional()
      .describe("Batch of independent find-and-replace edits to apply to the same file in one call."),
  })
  .refine(
    (v) => {
      const single = v.old_string !== undefined && v.new_string !== undefined;
      const multi = Array.isArray(v.edits) && v.edits.length > 0;
      return single !== multi;
    },
    { message: "Provide either old_string + new_string, or an edits array — not both." }
  );

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Make targeted find-and-replace edits in an existing file. Either pass old_string + new_string for a single edit, or an edits array for a batch of independent edits (one permission prompt, one diff). Fails loudly if an old_string is not found, or appears multiple times (unless replace_all is true).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the file to edit." },
      old_string: { type: "string", description: "Exact text to find." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "Exact text to find." },
            new_string: { type: "string", description: "Replacement text." },
            replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." },
          },
          required: ["old_string", "new_string"],
        },
        description: "Batch of independent edits applied in order.",
      },
    },
    required: ["path"],
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

    const edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> =
      args.edits && args.edits.length > 0
        ? args.edits
        : [{ old_string: args.old_string!, new_string: args.new_string!, replace_all: args.replace_all }];

    // Validate every edit against the original content up front so a batch
    // never partially applies when one of the old_strings is bad.
    const applied: Array<{ old_string: string; count: number }> = [];
    for (const e of edits) {
      const count = content.split(e.old_string).length - 1;
      if (count === 0) {
        return {
          ok: false,
          output: `old_string was not found in ${args.path}: ${JSON.stringify(e.old_string.slice(0, 80))}. Nothing changed.`,
        };
      }
      if (count > 1 && !e.replace_all) {
        return {
          ok: false,
          output: `old_string appears ${count} times in ${args.path}: ${JSON.stringify(e.old_string.slice(0, 80))}. Make it unique or set replace_all: true. Nothing changed.`,
        };
      }
      applied.push({ old_string: e.old_string, count });
    }

    const allowed = await ctx.requestPermission(`edit_file: ${args.path} (${edits.length} edit${edits.length === 1 ? "" : "s"})`, "edit_file");
    if (!allowed) {
      return { ok: false, output: "Permission denied by the user — file was not edited." };
    }

    try {
      let updated = content;
      for (const e of edits) {
        updated = e.replace_all
          ? updated.split(e.old_string).join(e.new_string)
          : updated.replace(e.old_string, e.new_string);
      }
      writeFileSync(filePath, updated, "utf8");
      const totalReplacements = applied.reduce((sum, a) => sum + a.count, 0);
      const stats = lineDiffStats(content, updated);
      const hunks = lineDiffHunks(content, updated);
      const plural = edits.length > 1 ? ` in ${edits.length} edits` : "";
      return {
        ok: true,
        output: `Edited ${args.path}: ${totalReplacements} replacement(s) applied${plural} (+${stats.added} −${stats.removed} lines).`,
        diff: hunks.length > 0 ? { path: args.path, hunks } : undefined,
      };
    } catch (e) {
      return { ok: false, output: `Could not write ${filePath}: ${(e as Error).message}` };
    }
  },
};
