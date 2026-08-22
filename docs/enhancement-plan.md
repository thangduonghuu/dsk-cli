# DSK CLI — Behavior Review & Enhancement Plan

> A Claude-Code-style agentic terminal tool powered by the DeepSeek API.
> This document reviews the current behavior, compares it against Claude Code,
> and lays out a prioritized roadmap for enhancement.

- [1. Current behavior](#1-current-behavior)
- [2. Gap analysis vs Claude Code](#2-gap-analysis-vs-claude-code)
- [3. Enhancement plan](#3-enhancement-plan)
  - [Phase 1 — Reliability & context](#phase-1--reliability--context)
  - [Phase 2 — Agent capability](#phase-2--agent-capability)
  - [Phase 3 — Headless / scripting](#phase-3--headless--scripting)
  - [Phase 4 — UX parity](#phase-4--ux-parity)
  - [Phase 5 — Ecosystem](#phase-5--ecosystem)
- [4. Quick wins](#4-quick-wins)

---

## 1. Current behavior

**Status:** `npm run typecheck` clean, 48/48 tests green (mock-server based).

### Architecture

The codebase is clean and well-factored across three layers:

| Layer | Files | Notes |
| --- | --- | --- |
| Agent | `src/agent/loop.ts`, `deepseekClient.ts`, `tools/*` | Streaming loop, SSE client, 7 tools |
| UI | `src/ui/editor.ts`, `render.ts`, `keys.ts`, `footer.ts`, `diff.ts`, … | Prompt bar, transcript, diffs |
| Shell | `src/cli.ts`, `src/repl.ts`, `config.ts`, `session.ts`, `permissions.ts`, `input.ts` | CLI, REPL, config, sessions, gates |

### What's already solid

- **Agentic tool loop** (`loop.ts`): streams → executes tool calls → feeds results
  back as `role:"tool"` → loops, capped at 25 iterations. Correctly re-serializes
  `tool_calls` and echoes `reasoning_content` (a DeepSeek multi-turn requirement).
  Tool arguments are validated via zod before execution.
- **SSE client** (`deepseekClient.ts`): robust — fragment-assembled tool calls,
  exponential backoff on 429/5xx, no resend after partial output, truncated-stream
  detection.
- **7 tools** with a clean `Tool` interface: `read_file`, `write_file`, `edit_file`,
  `list_dir`, `glob`, `grep` (ripgrep with a JS fallback), `bash` (process-group
  kill on timeout, 30 KB capture cap).
- **Permission gate** mirrors Claude Code's modes
  (`default → acceptEdits → plan → bypassPermissions`); allow/deny keys on the
  *full* command identity, not the truncated display (covered by a security test).
- **UI**: prompt-bar editor with live `/` and `@` suggestions, bracketed paste,
  history, inline diffs, footer (tokens / cost / git / elapsed), session
  persistence with path-traversal-safe ids, first-run key setup with 0600 perms.

---

## 2. Gap analysis vs Claude Code

| Area | Claude Code | dsk today |
| --- | --- | --- |
| Memory / context | `CLAUDE.md` auto-injected; auto-compaction near context limit | Static system prompt only; no context-window tracking (footer shows tokens but no "80% full" warning) |
| Git integration | git status/diff context, auto-branch, `/init`, checkpoints | Only branch + dirty in footer |
| Parallelism | Parallel sub-agents (`Task`), parallel tool calls | Tool calls run sequentially |
| Edit UX | Multi-hunk search/replace in one call; draft mode | Single `old_string` per call |
| Ecosystem | MCP servers, plugins, hooks (`PreToolUse`, …) | None (README declares non-goal) |
| More tools | `WebFetch` / `WebSearch`, `NotebookEdit`, background bash tasks | No web, no background tasks |
| Scripting | `-p` headless print mode, `-o` JSON output, exit codes | `dsk "prompt"` only; no structured output; piped stdin drops into the REPL |
| Operator UX | `/cost`, `/status`, `/doctor`, `/review`, `/init`, `/vim`, Ctrl+R | Basic `/usage`, `/config`, `/diff` |
| History | Persisted across sessions | In-memory only |

---

## 3. Enhancement plan

### Phase 1 — Reliability & context (highest value, low risk)

1. **Context-window tracking + auto-compaction** — estimate tokens per message,
   warn at ~80% of the model's window, and when exceeded summarize older turns
   into a "previous conversation" note and continue (like Claude Code).
2. **Persistent prompt history** — store in `~/.dsk/history.json`; ↑ recalls across
   sessions; Ctrl+R reverse search.
3. **Session list/cleanup** — `/sessions` command (list/delete), prune broken
   files, `dsk --list-sessions`.

### Phase 2 — Agent capability

4. **Project memory file** — `DSK.md` (analog of `CLAUDE.md`): auto-loaded into
   the system prompt; `/init` to generate it; `/forget` command. Rule documented
   to the model: update it when repo layout/conventions change.
5. **Parallel tool execution** — execute multiple `tool_calls` from one response
   concurrently (they're independent by construction of a single model response).
6. **New tools**:
   - `web_fetch` — cached, size-capped URL fetch.
   - `task` / `subagent` — spawn a focused one-shot exploration with its own
     mini-context.
   - `search` — codebase index / token-level search (like Claude Code 2.x).
   - `bash` gains `description` + per-call `cwd` params.
7. **Multi-hunk edit** — `edit_file` accepts an array of
   `{old_string, new_string, replace_all}` and applies all with one permission
   prompt + one diff.

### Phase 3 — Headless / scripting

8. **`-p` print mode + `-o json`** — `dsk -p "fix the test"` streams plain text
   and exits with a meaningful code (0 ok, 2 tool failure, 1 error); JSON mode
   emits `{result, tool_calls, usage}` for CI.
9. **`--allowedTools` / per-tool allow/deny rules** persisted in config (Claude
   Code's permission rules), replacing the coarse 4-mode-only gate with rule
   precedence.

### Phase 4 — UX parity

10. **Checkpoints / undo** — snapshot touched files (or a git-free diff registry)
    before each mutation; `/undo` restores the last change; `/diff` shows the
    cumulative turn diff.
11. **`/cost` + live pricing** — configurable `pricePerMIn` / `pricePerMOut`;
    accurate cost for unknown models.
12. **`/doctor`** — self-check: API key validity, ripgrep presence, config
    permissions, session dir writability.
13. **Vim keybindings** in the editor (opt-in `--vim`), Ctrl+R history search.

### Phase 5 — Ecosystem (biggest lift; revisit the v1 non-goal)

14. **MCP client** — optional `--mcp` pointing at a config of servers; dynamic
    tools registered at startup, permission-gated like native tools. Start with
    stdio transport only.
15. **Hooks** — `PreToolUse` / `PostToolUse` / `Stop` shell hooks read from
    `.dsk/hooks.json` (declarative, no SDK).

---

## 4. Quick wins

These can land in one sitting:

1. Persistent history (#2)
2. Context-window warning — tracking only (#1a)
3. `/sessions` list/delete (#3)
4. Multi-hunk edit (#7)
5. `--allowedTools` (#9)

**Recommended starting point:** Phase 1 — the context-window estimator and
warning is the highest-impact safety feature, and it follows the existing
mock-server test pattern.
