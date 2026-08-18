import { stdin, stdout } from "node:process";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { EffectiveSettings } from "./config.js";
import { saveConfig } from "./config.js";
import type { ChatMessage, ToolCall } from "./agent/deepseekClient.js";
import { DskApiError, DskStreamError } from "./agent/deepseekClient.js";
import { runAgentTurn, SYSTEM_PROMPT } from "./agent/loop.js";
import { allTools } from "./agent/tools/index.js";
import { bashTool } from "./agent/tools/bash.js";
import { PermissionGate, PERMISSION_MODES, type PermissionMode } from "./permissions.js";
import { saveSession } from "./session.js";
import { createPrompter } from "./input.js";
import { fetchModels, KNOWN_MODELS } from "./models.js";
import { initKeyInput, onKey, restoreRawMode } from "./ui/keys.js";
import { Editor } from "./ui/editor.js";
import { COLOR_NAMES, THEME_NAMES, getPalette, type Palette } from "./ui/theme.js";
import { buildFooter, costFromUsage, type FooterState } from "./ui/footer.js";
import { renderBanner, renderDiff, toolCallLine, summarizeTool } from "./ui/render.js";
import { createStreamStyler } from "./ui/markdown.js";
import { completeInput } from "./ui/complete.js";
import { ThinkingIndicator } from "./ui/thinking.js";
import type { FileDiff } from "./ui/diff.js";

const MAX_ITERATIONS = 25;
const execFileP = promisify(execFile);

async function getGitInfo(): Promise<{ branch?: string; dirty?: boolean }> {
  try {
    const [{ stdout: branch }, { stdout: status }] = await Promise.all([
      execFileP("git", ["rev-parse", "--abbrev-ref", "HEAD"], { timeout: 3000 }),
      execFileP("git", ["status", "--porcelain"], { timeout: 3000 }),
    ]);
    return { branch: branch.trim() || undefined, dirty: status.trim().length > 0 };
  } catch {
    return {};
  }
}

function parseArgs(call: ToolCall): Record<string, unknown> {
  try {
    return JSON.parse(call.arguments) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function maskKey(v: string | undefined): string {
  if (!v) return "(unset)";
  if (v.length <= 8) return "****";
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

export interface ReplOptions {
  settings: EffectiveSettings;
  skipAll: boolean;
  messages?: ChatMessage[];
  sessionId?: string;
  /** Run in the alternate (fullscreen) terminal buffer (TTY only). */
  fullscreen?: boolean;
}

const ALT_SCREEN_IN = "\x1b[?1049h\x1b[2J\x1b[H";
const ALT_SCREEN_OUT = "\x1b[?1049l";

/** Interactive REPL: prompt loop, slash commands, streamed agent turns. */
export async function startRepl(opts: ReplOptions): Promise<void> {
  const { settings } = opts;
  const messages: ChatMessage[] = opts.messages ?? [{ role: "system", content: SYSTEM_PROMPT }];
  let sessionId = opts.sessionId;
  let aborter: AbortController | null = null;
  const tty = Boolean(stdin.isTTY && stdout.isTTY);
  const fullscreen = Boolean(opts.fullscreen) && tty;

  if (fullscreen) stdout.write(ALT_SCREEN_IN);

  let palette: Palette = getPalette(settings.theme, settings.promptColor);
  const state: FooterState = {
    mode: settings.mode,
    model: settings.model,
    tokensIn: 0,
    tokensOut: 0,
    costCents: 0,
    elapsedMs: 0,
    turns: 0,
  };
  const sessionStart = Date.now();
  const git = await getGitInfo();
  state.branch = git.branch;
  state.dirty = git.dirty;

  // Per-turn transcript (user line, tool lines, assistant text) for Ctrl+O,
  // and the most recent file diff for /diff. Held in objects so reads outside
  // the turn closure are never control-flow narrowed to `null`.
  const transcript: Array<{ user: string; tools: string[]; assistant: string }> = [];
  const turnState: { rec: { user: string; tools: string[]; assistant: string } | null } = { rec: null };
  const uiState: { lastDiff: FileDiff | null } = { lastDiff: null };

  // ------------------------------------------------------------- input
  let editor: Editor | null = null;
  let prompter: ReturnType<typeof createPrompter> | null = null;
  let stopTurnKeys: (() => void) | null = null;
  let lastExitKey = 0;

  const ask = (q: string, o: { multiline?: boolean; history?: boolean } = {}) =>
    tty && editor ? editor.ask(q, o) : prompter ? prompter.ask(q) : Promise.resolve<string | null>(null);

  const cycleMode = (): void => {
    const idx = PERMISSION_MODES.indexOf(state.mode);
    const next: PermissionMode = PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length];
    state.mode = next;
    editor?.showToast([`mode: ${next}  (shift+tab cycles again)`]);
  };

  const finish = (): void => {
    editor?.close();
    prompter?.close();
    stopTurnKeys?.();
    if (messages.length > 1) saveSession({ id: sessionId, model: settings.model, messages });
    restoreRawMode();
    if (fullscreen) stdout.write(ALT_SCREEN_OUT);
    process.exit(0);
  };

  /** Pipe text through `less -R`; fall back to printing when less is missing. */
  const runPager = (text: string): Promise<void> =>
    new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const child = spawn("less", ["-R", "-F"], { stdio: ["pipe", "inherit", "inherit"] });
      child.on("error", () => {
        process.stdout.write(text + "\n");
        done();
      });
      child.on("close", done);
      try {
        child.stdin?.write(text);
        child.stdin?.end();
      } catch {
        done();
      }
    });

  /** Ctrl+O: suspend the editor, page through the session transcript, resume. */
  const viewTranscript = async (): Promise<void> => {
    if (!editor || transcript.length === 0) {
      console.log(palette.dim("No transcript yet — run a turn first."));
      return;
    }
    const body = transcript
      .map(
        (t) =>
          [
            palette.prompt("❯ ") + t.user,
            ...t.tools,
            t.assistant.trim() ? t.assistant : "",
            "",
          ].join("\n")
      )
      .join("\n");
    editor.pause();
    restoreRawMode();
    try {
      await runPager(body);
    } finally {
      initKeyInput(); // re-enter raw mode (emitKeypressEvents stays registered)
      editor.resume();
    }
  };

  const handleCtrlC = (): void => {
    if (aborter) return; // during a turn the key monitor handles it
    const now = Date.now();
    if (now - lastExitKey < 2000) {
      finish();
      return;
    }
    lastExitKey = now;
    editor?.showToast(["(press Ctrl+C again to exit)"]);
  };

  if (tty) {
    initKeyInput();
    editor = new Editor(
      {
        footer: () => buildFooter(state, palette),
        complete: (text, cursor) => completeInput(text, cursor, process.cwd()),
        contStyle: (s) => palette.dim(s),
        onShiftTab: () => cycleMode(),
        onCtrlC: () => handleCtrlC(),
        onCtrlD: () => handleCtrlC(),
        onCtrlO: () => void viewTranscript(),
      },
      []
    );
    // While a turn is running: Esc / Ctrl+C aborts it (and unblocks a prompt).
    stopTurnKeys = onKey((k) => {
      if (!aborter) return;
      if (k.name === "escape" || (k.ctrl && k.name === "c")) {
        aborter.abort();
        editor?.interrupt();
        console.log(palette.dim("\n(interrupted — partial work is kept)"));
      }
    });
  } else {
    prompter = createPrompter(false);
  }

  const stylePermission = (q: string): string => {
    const m = q.match(/^Allow (bash|write_file|edit_file):/);
    if (m) return `Allow ${palette.tool(m[1])}:` + q.slice(m[0].length);
    return q;
  };

  const gate = new PermissionGate({
    skipAll: opts.skipAll,
    mode: settings.mode,
    // The REPL is interactive by design; piped stdin still answers prompts line
    // by line through the prompter (one-off mode is where non-TTY fails closed).
    isInteractive: true,
    ask: (q) => ask(stylePermission(q), { multiline: false, history: false }),
    colorize: (q) => stylePermission(q),
  });

  // Welcome splash on a real terminal (compact one-liner when piped).
  console.log(renderBanner({ cwd: process.cwd(), branch: state.branch, dirty: state.dirty, mode: state.mode }, palette, { full: tty }));

  // ---------------------------------------------------------- agent turn
  const runTurn = async (): Promise<void> => {
    while (true) {
      aborter = new AbortController();
      const indicator = new ThinkingIndicator(palette, tty);
      indicator.start();
      let streamed = false;
      let shouldRetry = false;
      let reasoningActive = false;
      const styler = createStreamStyler(tty, palette);
      const stopSpinner = () => indicator.stop();
      // End an inline reasoning block with a newline before the next output
      // (answer text or a tool header), matching Claude Code's thinking block.
      const breakReasoning = () => {
        if (reasoningActive) {
          reasoningActive = false;
          process.stdout.write("\n");
        }
      };
      try {
        await runAgentTurn({
          settings,
          messages,
          tools: allTools,
          gate,
          maxIterations: MAX_ITERATIONS,
          signal: aborter.signal,
          callbacks: {
            onIterationStart: (n) => {
              if (n > 1) {
                stopSpinner();
                console.log(palette.dim(`— tool loop iteration ${n}`));
              }
            },
            onText: (t) => {
              stopSpinner();
              breakReasoning();
              if (turnState.rec) turnState.rec.assistant += t;
              for (const piece of styler.push(t)) process.stdout.write(piece);
              streamed = true;
            },
            onReasoning: (t) => {
              stopSpinner();
              if (turnState.rec) turnState.rec.assistant += t;
              if (!reasoningActive) {
                reasoningActive = true;
                process.stdout.write(palette.dim("█ "));
              }
              process.stdout.write(palette.dim(t));
              streamed = true;
            },
            onToolCall: (call) => {
              stopSpinner();
              breakReasoning();
              const line = toolCallLine(call, palette);
              console.log(line);
              turnState.rec?.tools.push(line);
            },
            onToolResult: (call, result) => {
              const line = summarizeTool(call.name, parseArgs(call), result, palette);
              console.log(line);
              turnState.rec?.tools.push(line);
              if (result.diff) uiState.lastDiff = result.diff;
            },
            onCapped: () => {
              stopSpinner();
              console.log(palette.warn(`⚠ Reached the ${MAX_ITERATIONS}-iteration tool loop cap; ending this turn.`));
            },
            onUsage: (usage) => {
              if (usage) {
                state.tokensIn += usage.promptTokens;
                state.tokensOut += usage.completionTokens;
                state.costCents += costFromUsage(settings.model, usage.promptTokens, usage.completionTokens);
              }
            },
          },
        });
        stopSpinner();
        for (const piece of styler.flush()) process.stdout.write(piece);
        breakReasoning();
        // Blank line between the answer and the next prompt (mock layout).
        if (streamed) console.log("\n");
      } catch (err) {
        stopSpinner();
        if (err instanceof Error && err.name === "AbortError") {
          // Ctrl+C / Esc was already acknowledged by the key handler.
        } else if (err instanceof DskApiError) {
          console.log(palette.error(`API error: ${err.message}`));
        } else if (err instanceof DskStreamError) {
          console.log(palette.warn(`\n${err.message}`));
          const again = ((await ask("Retry this turn? [y]es / [n]o: ", { multiline: false })) ?? "n")
            .trim()
            .toLowerCase();
          if (again.startsWith("y")) {
            shouldRetry = true;
          }
        } else {
          console.log(palette.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`));
        }
      } finally {
        aborter = null;
      }
      if (!shouldRetry) break;
    }
  };

  const runShell = async (cmd: string): Promise<void> => {
    if (!cmd) return;
    console.log(`${palette.tool("⚙")} ${cmd}`);
    turnState.rec = { user: `!${cmd}`, tools: [`${palette.tool("⚙")} ${cmd}`], assistant: "" };
    const res = await bashTool.execute({ command: cmd }, { cwd: process.cwd(), requestPermission: async () => true });
    if (res.output) {
      console.log(res.output);
      turnState.rec.tools.push(palette.dim(res.output.split("\n")[0].slice(0, 120)));
    }
    // Feed the command + output into the conversation so the model can react.
    messages.push({ role: "user", content: `$ ${cmd}\n${res.output}` });
    await runTurn();
    if (turnState.rec) {
      transcript.push(turnState.rec);
      if (transcript.length > 20) transcript.shift();
    }
    turnState.rec = null;
  };

  // ------------------------------------------------------------ main loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = await ask(palette.prompt("❯ "), { multiline: true, history: true });
    if (answer === null) break; // EOF on piped stdin
    const line = answer.trim();
    if (line === "") continue;

    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      switch (cmd) {
        case "help":
          console.log(
            [
              "/help                  show this help",
              "/clear                 reset the conversation",
              "/model [name]          list every model to pick, or switch directly (/model deepseek-v4-pro)",
              "/config                show current configuration",
              "/usage                 show token usage and cost for this session",
              "/diff                  show the last file change as a unified diff",
              "/theme [name]          switch UI theme (default | ocean | mono)",
              "/color [name]          set the prompt-bar color",
              "/mode [mode]           show or set permission mode (shift+tab cycles)",
              "/exit                  quit (Ctrl+C twice also works)",
              "",
              "Anything else you type is sent to the agent, which can read/write",
              "files, search the codebase, and run shell commands. `!cmd` runs a",
              "shell command and adds its output to the conversation.",
            ].join("\n")
          );
          break;
        case "clear":
          messages.length = 0;
          messages.push({ role: "system", content: SYSTEM_PROMPT });
          console.log(palette.dim("Conversation cleared."));
          break;
        case "model": {
          const name = rest.join(" ").trim();
          if (!name) {
            const models = await fetchModels(settings.baseUrl, settings.apiKey);
            console.log("Available models:");
            for (const [i, m] of models.entries()) {
              const known = KNOWN_MODELS.find((k) => k.id === m.id);
              const current = m.id === settings.model ? palette.success("  (current)") : "";
              console.log(
                `  ${palette.tool(String(i + 1))}. ${m.id}${known?.description ? palette.dim(` — ${known.description}`) : ""}${current}`
              );
            }
            const answer = await ask(
              palette.dim(`Pick a number or type a model name (Enter keeps ${settings.model}): `),
              { multiline: false }
            );
            if (!answer) break;
            const pickedRaw = answer.trim();
            if (!pickedRaw) break;
            const n = Number(pickedRaw);
            let picked: string | undefined;
            if (Number.isInteger(n) && n >= 1 && n <= models.length) {
              picked = models[n - 1].id;
            } else {
              picked = pickedRaw;
            }
            if (!picked) break;
            saveConfig({ model: picked });
            settings.model = picked;
            state.model = picked;
            console.log(palette.dim(`Model switched to ${picked} (saved to config).`));
            break;
          }
          saveConfig({ model: name });
          settings.model = name;
          state.model = name;
          console.log(palette.dim(`Model switched to ${name} (saved to config).`));
          break;
        }
        case "config":
          console.log(
            [
              `model:            ${settings.model}`,
              `thinking:         ${settings.thinking}`,
              `reasoning_effort: ${settings.reasoningEffort}`,
              `base_url:         ${settings.baseUrl}`,
              `api_key:          ${maskKey(settings.apiKey)}`,
              `max_tokens:       ${settings.maxTokens ?? "(default)"}`,
              `theme:            ${settings.theme ?? "default"}`,
              `prompt_color:     ${settings.promptColor ?? "default"}`,
              `mode:             ${state.mode}`,
              `tokens:           ${state.tokensIn} in · ${state.tokensOut} out · $${(state.costCents / 100).toFixed(4)}`,
            ].join("\n")
          );
          break;
        case "usage":
          console.log(
            `tokens: ${state.tokensIn} in · ${state.tokensOut} out · $${(state.costCents / 100).toFixed(4)} · ${state.turns} turn(s) · ${Math.round((Date.now() - sessionStart) / 1000)}s`
          );
          break;
        case "diff":
          const d = uiState.lastDiff;
          if (!d) {
            console.log(palette.dim("No recent file change with a diff — run an edit_file or write_file first."));
            break;
          }
          console.log(renderDiff(d.path, d.hunks, palette));
          break;
        case "theme": {
          const name = rest.join(" ").trim();
          const pick = async (): Promise<string | null> => {
            console.log("Themes:");
            for (const [i, t] of THEME_NAMES.entries()) {
              console.log(`  ${palette.tool(String(i + 1))}. ${t}`);
            }
            const answer = await ask(palette.dim("Pick a number or name (Enter keeps current): "), { multiline: false });
            if (!answer) return null;
            const n = Number(answer.trim());
            if (Number.isInteger(n) && n >= 1 && n <= THEME_NAMES.length) return THEME_NAMES[n - 1];
            return answer.trim() || null;
          };
          const theme = name || (await pick());
          if (!theme) break;
          if (!THEME_NAMES.includes(theme as (typeof THEME_NAMES)[number])) {
            console.log(palette.warn(`Unknown theme "${theme}". Valid: ${THEME_NAMES.join(", ")}`));
            break;
          }
          saveConfig({ theme });
          settings.theme = theme;
          palette = getPalette(settings.theme, settings.promptColor);
          console.log(palette.dim(`Theme set to ${theme}.`));
          break;
        }
        case "color": {
          const name = rest.join(" ").trim();
          const pick = async (): Promise<string | null> => {
            console.log("Prompt bar colors:");
            for (const [i, c] of COLOR_NAMES.entries()) {
              console.log(`  ${palette.tool(String(i + 1))}. ${c}`);
            }
            const answer = await ask(palette.dim("Pick a number or name (Enter keeps current): "), { multiline: false });
            if (!answer) return null;
            const n = Number(answer.trim());
            if (Number.isInteger(n) && n >= 1 && n <= COLOR_NAMES.length) return COLOR_NAMES[n - 1];
            return answer.trim() || null;
          };
          const color = name || (await pick());
          if (!color) break;
          if (!COLOR_NAMES.includes(color as (typeof COLOR_NAMES)[number])) {
            console.log(palette.warn(`Unknown color "${color}". Valid: ${COLOR_NAMES.join(", ")}`));
            break;
          }
          saveConfig({ promptColor: color === "default" ? undefined : color });
          settings.promptColor = color === "default" ? undefined : color;
          palette = getPalette(settings.theme, settings.promptColor);
          console.log(palette.dim(`Prompt bar color set to ${color}.`));
          break;
        }
        case "mode": {
          const name = rest.join(" ").trim();
          if (!name) {
            console.log(
              `mode: ${state.mode}  (shift+tab cycles: ${PERMISSION_MODES.join(" → ")})`
            );
            break;
          }
          if (!PERMISSION_MODES.includes(name as PermissionMode)) {
            console.log(palette.warn(`Unknown mode "${name}". Valid: ${PERMISSION_MODES.join(", ")}`));
            break;
          }
          state.mode = name as PermissionMode;
          saveConfig({ mode: state.mode });
          console.log(palette.dim(`Permission mode set to ${state.mode}.`));
          break;
        }
        case "exit":
          finish();
          break;
        default:
          console.log(palette.dim(`Unknown command: /${cmd} — try /help`));
      }
      continue;
    }

    if (line.startsWith("!")) {
      await runShell(line.slice(1).trim());
      continue;
    }

    messages.push({ role: "user", content: line });
    turnState.rec = { user: line, tools: [], assistant: "" };
    await runTurn();
    state.turns += 1;
    state.elapsedMs = Date.now() - sessionStart;
    if (turnState.rec) {
      transcript.push(turnState.rec);
      if (transcript.length > 20) transcript.shift();
    }
    turnState.rec = null;
    sessionId = saveSession({ id: sessionId, model: settings.model, messages });
  }
  // EOF (piped stdin) or Ctrl+D.
  editor?.close();
  prompter?.close();
  stopTurnKeys?.();
  if (messages.length > 1) saveSession({ id: sessionId, model: settings.model, messages });
  restoreRawMode();
  if (fullscreen) stdout.write(ALT_SCREEN_OUT);
}
