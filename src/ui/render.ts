import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolCall } from "../agent/deepseekClient.js";
import type { ToolResult } from "../agent/tools/index.js";
import type { PermissionMode } from "../permissions.js";
import { summarizeHunks, type DiffHunk } from "./diff.js";
import { DEEPSEEK_BLUE, type Palette } from "./theme.js";

let cachedVersion = "0.1.0";
try {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
  if (pkg.version) cachedVersion = pkg.version;
} catch {
  /* keep default */
}
export function cliVersion(): string {
  return cachedVersion;
}

export interface BannerInfo {
  cwd: string;
  branch?: string;
  dirty?: boolean;
  mode: PermissionMode;
}

export interface BannerOptions {
  /** Render the full Claude-Code-style welcome splash (TTY). Default: compact. */
  full?: boolean;
}

/**
 * The welcome card, modeled on Claude Code's startup screen (left-aligned).
 * The title line is built dynamically so "dsk" can be colored.
 */
const WELCOME_BOX = [
  "╭────────────────────────────────╮",
  "│                                │",
  "│ the DeepSeek coding agent      │",
  "│ for your terminal              │",
  "╰────────────────────────────────╯",
];

/** "DSK CLI" in ASCII block letters — the main logo (DeepSeek brand blue). */
const DSK_CLI_WORDMARK = [
  "██████╗ ███████╗██╗  ██╗     ██████╗██╗     ██╗",
  "██╔══██╗██╔════╝██║ ██╔╝    ██╔════╝██║     ██║",
  "██║  ██║███████╗█████╔╝     ██║     ██║     ██║",
  "██║  ██║╚════██║██╔═██╗     ██║     ██║     ██║",
  "██████╔╝███████║██║  ██╗    ╚██████╗███████╗██║",
  "╚═════╝ ╚══════╝╚═╝  ╚═╝     ╚═════╝╚══════╝╚═╝",
];

const TIPS = [
  "Type a message to get started, or use /help to see all commands",
  "Esc interrupts the agent mid-task · Ctrl+C twice at the prompt exits",
  "Shift+Tab cycles permission modes",
];

/**
 * Startup banner. TTY: the full Claude-Code-style welcome screen with the
 * "DSK CLI" logo, left-aligned and DeepSeek-blue. Piped: the compact
 * one-liner used by scripts/tests.
 */
export function renderBanner(info: BannerInfo, palette: Palette, opts: BannerOptions = {}): string {
  const context = [info.cwd];
  if (info.branch) context.push(info.dirty ? `${info.branch}*` : info.branch);
  context.push(`${info.mode} mode`);
  if (!opts.full) {
    return palette.accent("dsk") + palette.dim(` v${cliVersion()} · ${context.join(" · ")}`);
  }

  // Short cwd (basename) in the splash so the version line never wraps.
  const cwd = info.cwd.split(/[\\/]/).filter(Boolean).pop() ?? info.cwd;
  const splashContext = [cwd];
  if (info.branch) splashContext.push(info.dirty ? `${info.branch}*` : info.branch);
  splashContext.push(`${info.mode} mode`);

  const lines: string[] = [];
  // Welcome card — dim chrome, ● in the prompt color, "dsk"/"DeepSeek" in blue.
  lines.push(palette.dim(WELCOME_BOX[0]));
  lines.push(
    palette.dim("│ ") +
      palette.prompt("●") +
      palette.dim(" Welcome to ") +
      DEEPSEEK_BLUE.bold("dsk") +
      palette.dim("               │")
  );
  lines.push(palette.dim(WELCOME_BOX[1]));
  lines.push(palette.dim("│ the ") + DEEPSEEK_BLUE("DeepSeek") + palette.dim(" coding agent      │"));
  lines.push(palette.dim(WELCOME_BOX[3]));
  lines.push(palette.dim(WELCOME_BOX[4]));
  lines.push("");
  // "DSK CLI" logo in DeepSeek brand blue.
  for (const l of DSK_CLI_WORDMARK) lines.push(DEEPSEEK_BLUE(l));
  lines.push(palette.dim("powered by ") + DEEPSEEK_BLUE("DeepSeek"));
  lines.push("");
  // Version · cwd · branch · mode ("dsk" in blue to match the logo).
  const version = DEEPSEEK_BLUE("dsk") + palette.dim(` v${cliVersion()}`) + ` · ${splashContext.join(" · ")}`;
  lines.push(version);
  lines.push("");
  // Getting-started tips (blue bullets, dim text).
  for (const t of TIPS) lines.push(`  ${DEEPSEEK_BLUE("•")} ${palette.dim(t)}`);
  lines.push("");
  return lines.join("\n");
}

/** The submitted user line, re-rendered as a colored transcript turn. */
export function renderUserEcho(line: string, palette: Palette): string {
  const [first, ...rest] = line.split("\n");
  const out = [palette.prompt("❯ ") + first];
  for (const r of rest) out.push(palette.dim("  │ ") + r);
  return out.join("\n");
}

/** Tool invocation header shown before the tool runs, e.g. `─ Running npm test`. */
export function toolCallLine(call: ToolCall, palette: Palette): string {
  const detail = toolDetail(call);
  const verb = VERBS[call.name] ?? call.name;
  const preview = detail.slice(0, 80);
  return `${palette.dim("─")} ${palette.tool(verb)}${preview ? ` ${preview}` : ""}`;
}

const VERBS: Record<string, string> = {
  read_file: "Reading",
  write_file: "Writing",
  edit_file: "Editing",
  list_dir: "Listing",
  glob: "Globbing",
  grep: "Grepping",
  bash: "Running",
};

const FAIL_VERBS: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  list_dir: "List",
  glob: "Glob",
  grep: "Grep",
  bash: "Command",
};

function toolDetail(call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments) as Record<string, unknown>;
  } catch {
    /* leave empty */
  }
  switch (call.name) {
    case "bash":
      return String(args.command ?? "");
    case "read_file":
    case "write_file":
    case "edit_file":
    case "list_dir":
      return String(args.path ?? "");
    case "glob":
    case "grep":
      return String(args.pattern ?? "");
    default:
      return "";
  }
}

/** Best-effort "1.2 KB, 54 lines" size string for a file path. */
function sizeInfo(path: string): string {
  try {
    const full = resolve(process.cwd(), path);
    const size = statSync(full).size;
    const lines = readFileSync(full, "utf8").split("\n").length;
    const sizeStr = size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
    return ` (${sizeStr}, ${lines} lines)`;
  } catch {
    return "";
  }
}

/**
 * Collapsed one-line tool result in Claude Code's style, e.g.
 * `✓ Read file: src/x.ts (1.4 KB, 38 lines)`,
 * `✓ Edit applied: src/x.ts +3 −2`, `✓ Command finished: npm test (exit 0, 4.1s)`.
 */
export function summarizeTool(name: string, rawArgs: unknown, result: ToolResult, palette: Palette): string {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const path = String(args.path ?? args.pattern ?? args.command ?? "");
  const denied = result.output.includes("Permission denied");
  const miss = result.output.includes("not found") || result.output.includes("appears ") || result.output.includes("Invalid arguments");
  const icon = result.ok
    ? palette.success("✓")
    : denied
      ? palette.warn("⏸")
      : miss
        ? palette.warn("⚠")
        : palette.error("✗");

  const failVerb = FAIL_VERBS[name] ?? name;

  // Permission denials and failures carry the reason.
  if (denied) {
    const identity = name === "bash" ? `bash: ${path}` : `${name}: ${path}`;
    return `${icon} Permission denied: ${palette.tool(identity)}`;
  }
  if (!result.ok) {
    const reason = result.output.split("\n")[0].slice(0, 90);
    return `${icon} ${palette.tool(failVerb)} failed: ${path} — ${palette.dim(reason)}`;
  }

  switch (name) {
    case "bash": {
      const cmd = path.slice(0, 60);
      const timeout = result.output.match(/\[timed out after ([^\]]+)\]/)?.[1];
      const exit = result.output.match(/\[exit code: (\d+)/)?.[1];
      const dur = result.output.match(/(\d+(?:\.\d+)?(?:ms|s))(?=\])/)?.[1];
      const suffix = timeout ? ` (timed out after ${timeout})` : ` (exit ${exit}, ${dur ?? "?"})`;
      return `${icon} Command finished: ${cmd}${suffix}`;
    }
    case "read_file":
      return `${icon} Read file: ${path}${sizeInfo(path)}`;
    case "write_file":
      return `${icon} Wrote file: ${path}${sizeInfo(path)}`;
    case "edit_file": {
      const stats = diffStatsOf(result.diff);
      return `${icon} Edit applied: ${path}${stats ? ` ${stats}` : ""}`;
    }
    case "list_dir":
      return `${icon} Listed: ${path || "."}`;
    case "glob":
      return `${icon} Glob: ${path}`;
    case "grep":
      return `${icon} Grep: ${path}`;
    default:
      return `${icon} ${name}: ${path}`;
  }
}

/** "+3 −2" from a diff, or "" when unavailable. */
function diffStatsOf(diff: { path: string; hunks: DiffHunk[] } | undefined): string {
  if (diff && diff.hunks.length > 0) return summarizeHunks(diff.hunks);
  return "";
}

export interface RenderDiffOptions {
  /** Cap the number of rendered lines (header + hunks); truncates with a note. */
  maxLines?: number;
}

/** Render a unified diff for the /diff viewer (green +, red −, dim context). */
export function renderDiff(path: string, hunks: DiffHunk[], palette: Palette, opts: RenderDiffOptions = {}): string {
  const out: string[] = [palette.tool(`─ diff: ${path}`)];
  const maxLines = opts.maxLines ?? Infinity;
  let truncated = false;
  outer: for (const h of hunks) {
    if (out.length >= maxLines) {
      truncated = true;
      break;
    }
    out.push(palette.dim(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`));
    for (const l of h.lines) {
      if (out.length >= maxLines) {
        truncated = true;
        break outer;
      }
      if (l.kind === "add") out.push(palette.success("+ " + l.text));
      else if (l.kind === "del") out.push(palette.error("- " + l.text));
      else out.push(palette.dim("  " + l.text));
    }
  }
  let text = out.join("\n");
  if (truncated) text += "\n" + palette.dim("… diff truncated — run /diff for the full view");
  return text;
}
