import { z } from "zod";
import { readFileTool } from "./readFile.js";
import { writeFileTool } from "./writeFile.js";
import { editFileTool } from "./editFile.js";
import { listDirTool } from "./listDir.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { bashTool } from "./bash.js";
import type { DiffHunk } from "../../ui/diff.js";

/** Context handed to every tool execution. */
export interface ToolContext {
  /** Project directory dsk was launched in (also the bash tool's cwd). */
  cwd: string;
  /**
   * Called by mutating tools before executing. Returns true when the user
   * approved (or auto-approve mode is on).
   */
  requestPermission: (description: string) => Promise<boolean>;
}

export interface ToolResult {
  ok: boolean;
  /** Markdown-ish text shown to the model as the tool result. */
  output: string;
  /** Optional unified-diff of a file change, surfaced by the /diff viewer. */
  diff?: { path: string; hunks: DiffHunk[] };
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for arguments, sent to the model as the tool definition. */
  parameters: Record<string, unknown>;
  /** Whether this tool must pass the permission gate before running. */
  needsPermission: boolean;
  /**
   * Execute with validated args. Args validation happens inside via zod; a
   * validation failure is returned as a normal {ok:false} result so the loop
   * can feed the error back to the model instead of crashing.
   */
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** Shared zod validation helper so every tool validates args before running. */
export function validateArgs<T extends z.ZodTypeAny>(schema: T, args: unknown): z.infer<T> {
  return schema.parse(args);
}

/** JSON schema of a zod object schema — used to build the model-facing tool definition. */
export function zodToJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

export { readFileTool, writeFileTool, editFileTool, listDirTool, globTool, grepTool, bashTool };

/** The full tool set exposed to the model (spec §5). */
export const allTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  globTool,
  grepTool,
  bashTool,
];
