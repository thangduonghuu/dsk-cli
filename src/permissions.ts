/**
 * Permission gate for mutating tools (write_file, edit_file, bash).
 *
 * Matches Claude Code's permission modes:
 * - default: every mutating call prompts (y/n/a/d) unless auto-approve is on.
 * - acceptEdits: file edits are auto-approved; bash still prompts.
 * - plan: mutations are denied without prompting (read-only exploration).
 * - bypassPermissions: everything is approved without asking.
 */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

export interface PermissionGateOptions {
  /** --dangerously-skip-permissions: approve everything without asking. */
  skipAll: boolean;
  /** In-session permission mode (default: "bypassPermissions" — no prompts). */
  mode?: PermissionMode;
  /** Ask the user a question; resolve null on EOF (treated as "no"). */
  ask: (question: string) => Promise<string | null>;
  /** Whether stdin is a TTY. Non-interactive runs deny mutations unless skipAll. */
  isInteractive: boolean;
  /** Optional styling applied to the prompt text (e.g. colorize tool names). */
  colorize?: (question: string) => string;
}

type ToolCategory = "edit" | "bash" | "other";

function categoryOf(description: string): ToolCategory {
  if (description.startsWith("write_file:") || description.startsWith("edit_file:")) return "edit";
  if (description.startsWith("bash:")) return "bash";
  return "other";
}

export class PermissionGate {
  private allowed = new Set<string>();
  private denied = new Set<string>();

  constructor(private opts: PermissionGateOptions) {}

  /** Ask permission for a specific action description (e.g. "bash: npm test"). */
  async ask(description: string): Promise<boolean> {
    if (this.opts.skipAll || this.opts.mode === "bypassPermissions") return true;
    const cat = categoryOf(description);
    if (this.opts.mode === "acceptEdits" && cat === "edit") return true;
    if (this.opts.mode === "plan") return false;
    // The allow/deny sets key on the FULL description so two commands sharing
    // a long prefix are still distinct identities.
    if (this.allowed.has(description)) return true;
    if (this.denied.has(description)) return false;
    if (!this.opts.isInteractive) {
      // Non-interactive (pipe/script): fail closed unless auto-approve is on.
      return false;
    }
    const display =
      description.length > 300 ? `${description.slice(0, 300)} …(truncated)` : description;
    const question = this.opts.colorize
      ? this.opts.colorize(`Allow ${display}?  [y]es / [n]o / [a]lways this session / [d]eny this session: `)
      : `Allow ${display}?  [y]es / [n]o / [a]lways this session / [d]eny this session: `;
    const answer = ((await this.opts.ask(question)) ?? "n").trim().toLowerCase();
    const first = answer[0] ?? "n";
    if (first === "y") return true;
    if (first === "a") {
      this.allowed.add(description);
      return true;
    }
    if (first === "d") {
      this.denied.add(description);
      return false;
    }
    return false;
  }
}
