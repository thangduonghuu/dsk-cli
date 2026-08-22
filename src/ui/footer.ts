import { stdout } from "node:process";
import type { PermissionMode } from "../permissions.js";
import { formatElapsed, formatK } from "./diff.js";
import type { Palette } from "./theme.js";

/** Estimated pricing in USD per 1M tokens (editable; unknown models omit cost). */
const PRICING: Record<string, { in: number; out: number }> = {
  "deepseek-v4-flash": { in: 0.2, out: 0.4 },
  "deepseek-v4-pro": { in: 1.0, out: 2.0 },
};

export interface FooterState {
  mode: PermissionMode;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  elapsedMs: number;
  turns: number;
  branch?: string;
  dirty?: boolean;
  /** Estimated context-window usage percent (0-100+), shown when > 0. */
  ctxPct?: number;
}

const MODE_LABEL: Record<PermissionMode, string> = {
  default: "default mode",
  acceptEdits: "acceptEdits",
  plan: "plan mode",
  bypassPermissions: "bypassPermissions",
};

/** Returns the running cost in cents (dollars * 100) for the given token usage. */
export function costFromUsage(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (promptTokens / 1_000_000) * p.in * 100 + (completionTokens / 1_000_000) * p.out * 100;
}

/**
 * Build the status line shown under the prompt: tokens in/out, running cost,
 * git branch, elapsed time, permission mode, and right-aligned keyboard hints.
 */
export function buildFooter(state: FooterState, palette: Palette): string {
  const parts: string[] = [];
  parts.push(`⚡ ${formatK(state.tokensIn)} in · ${formatK(state.tokensOut)} out`);
  if (state.ctxPct !== undefined && state.ctxPct > 0) parts.push(`ctx ${state.ctxPct}%`);
  if (state.costCents > 0.004) parts.push(`$${(state.costCents / 100).toFixed(3)}`);
  if (state.branch) parts.push(state.dirty ? `${state.branch}*` : state.branch);
  if (state.elapsedMs > 0) parts.push(formatElapsed(state.elapsedMs));
  parts.push(MODE_LABEL[state.mode]);

  const left = parts.join(" · ");
  const hints = "esc to interrupt · shift+tab for permissions";
  const cols = stdout.columns || 80;
  // Never let the footer wrap: right-align the hints when there is room,
  // otherwise drop them (and truncate the left side as a last resort).
  let line = left;
  if (cols >= left.length + hints.length + 3) {
    const pad = cols - left.length - hints.length - 1;
    line = left + " ".repeat(Math.max(2, pad)) + hints;
  } else if (cols >= left.length + 2) {
    line = left + " ".repeat(2);
  } else {
    line = left.slice(0, Math.max(10, cols - 1));
  }
  // Full-width separator above the status line (mock layout), dimmed.
  const sep = palette.dim("─".repeat(Math.min(cols, 160)));
  return `${sep}\n${palette.footer(line)}`;
}
