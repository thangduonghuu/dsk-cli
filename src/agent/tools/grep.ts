import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "./index.js";

const execFileP = promisify(execFile);

const schema = z.object({
  pattern: z.string().describe("Regular expression to search for."),
  path: z.string().optional().describe("File or directory to search in; defaults to the project root."),
  case_insensitive: z.boolean().optional().describe("Case-insensitive search (default false)."),
});

const MAX_MATCHES = 300;
const MAX_OUTPUT = 50_000;

let rgAvailable: boolean | null = null;

async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  try {
    await execFileP("rg", ["--version"], { timeout: 5000 });
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

/** Fallback JS regex walk when ripgrep isn't installed. */
async function walkGrep(
  dir: string,
  re: RegExp,
  caseInsensitive: boolean,
  out: string[]
): Promise<void> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_MATCHES) return;
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkGrep(full, re, caseInsensitive, out);
    } else if (e.isFile()) {
      let text: string;
      try {
        text = await fsp.readFile(full, "utf8");
      } catch {
        continue; // binary or unreadable
      }
      for (const [i, line] of text.split("\n").entries()) {
        if (re.test(line)) {
          out.push(`${relative(process.cwd(), full)}:${i + 1}:${line.slice(0, 500)}`);
          if (out.length >= MAX_MATCHES) return;
        }
      }
    }
  }
}

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents for a regular expression. Uses ripgrep when available (fast, gitignore-aware) with a JS fallback. Returns file:line matches.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "File or directory to search in; defaults to the project root." },
      case_insensitive: { type: "boolean", description: "Case-insensitive search (default false)." },
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
    const target = resolve(ctx.cwd, args.path ?? ".");

    // ripgrep is tried first (it handles its own regex dialect); the JS
    // fallback below builds the RegExp, so rg-only syntax like (?i) doesn't
    // error when rg is installed.
    if (await hasRipgrep()) {
      const rgArgs = ["-n", "--no-heading", "--hidden", "-S", "--glob", "!.git"];
      if (args.case_insensitive) rgArgs.push("-i");
      rgArgs.push("--", args.pattern, target);
      try {
        const { stdout } = await execFileP("rg", rgArgs, { maxBuffer: MAX_OUTPUT, timeout: 30_000 });
        const lines = stdout.replace(/\n$/, "").split("\n").filter(Boolean);
        if (lines.length === 0) return { ok: true, output: "No matches." };
        const shown = lines.slice(0, MAX_MATCHES);
        let note = "";
        if (lines.length > MAX_MATCHES) note = `\n(${lines.length} matches total; showing first ${MAX_MATCHES}.)`;
        return { ok: true, output: shown.join("\n") + note };
      } catch (e) {
        const code = (e as { code?: number | string }).code;
        if (code === 1) return { ok: true, output: "No matches." };
        // Exit 2 = error (bad path etc.); fall back to JS walk below.
        if (code !== 2) return { ok: false, output: `rg failed: ${(e as Error).message}` };
      }
    }

    // JS fallback walk.
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, args.case_insensitive ? "i" : "");
    } catch (e) {
      return { ok: false, output: `Invalid regular expression: ${(e as Error).message}` };
    }
    const out: string[] = [];
    try {
      const stat = await fsp.stat(target);
      if (stat.isFile()) {
        const text = await fsp.readFile(target, "utf8");
        for (const [i, line] of text.split("\n").entries()) {
          if (re.test(line)) {
            out.push(`${args.path ?? target}:${i + 1}:${line.slice(0, 500)}`);
            if (out.length >= MAX_MATCHES) break;
          }
        }
      } else {
        await walkGrep(target, re, args.case_insensitive ?? false, out);
      }
    } catch (e) {
      return { ok: false, output: `grep failed: ${(e as Error).message}` };
    }
    if (out.length === 0) return { ok: true, output: "No matches." };
    return { ok: true, output: out.join("\n") };
  },
};
