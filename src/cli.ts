#!/usr/bin/env node
import "./ui/forceColor.js";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import { Command } from "commander";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, loadConfig, resolveSettings, saveConfig } from "./config.js";
import { COLOR_NAMES, THEME_NAMES, getPalette } from "./ui/theme.js";
import { toolCallLine, summarizeTool } from "./ui/render.js";
import { PERMISSION_MODES, type PermissionMode } from "./permissions.js";
import type { EffectiveSettings } from "./config.js";
import type { ChatMessage } from "./agent/deepseekClient.js";
import { runAgentTurn } from "./agent/loop.js";
import { allTools } from "./agent/tools/index.js";
import { PermissionGate } from "./permissions.js";
import { latestSession, loadSession, saveSession } from "./session.js";
import { buildSystemPrompt } from "./memory.js";
import { startRepl } from "./repl.js";
import { createPrompter, askSecret } from "./input.js";
import { checkApiKey } from "./models.js";

const isTTY = Boolean(stdin.isTTY && stdout.isTTY);

const program = new Command();

program
  .name("dsk")
  .description("A Claude-Code-style agentic terminal tool powered by the DeepSeek API")
  .version("0.1.0")
  .option("--model <name>", `model to use (default ${DEFAULT_MODEL})`)
  .option("--api-key <key>", "DeepSeek API key (overrides DEEPSEEK_API_KEY and the config file)")
  .option("--dangerously-skip-permissions", "auto-approve all tool actions — use at your own risk")
  .option("--thinking <enabled|disabled>", "toggle DeepSeek thinking mode")
  .option("--reasoning-effort <low|high|max>", "reasoning effort in thinking mode (default high)")
  .option("--base-url <url>", "override the API base URL (mainly for testing)")
  .option("--theme <name>", `UI theme (${THEME_NAMES.join(" | ")})`)
  .option("--color <name>", `prompt-bar color (${COLOR_NAMES.join(" | ")})`)
  .option("--mode <mode>", `permission mode (${PERMISSION_MODES.join(" | ")})`)
  .option("--permission-mode <mode>", "alias for --mode")
  .option("--allowed-tools <tools>", "comma-separated tool names always allowed without prompting (bash, write_file, edit_file, ...)")
  .option("--context-window <tokens>", "override the model context window in tokens (default auto)")
  .option("--resume <id>", "resume a previous session by id")
  .option("--continue", "resume the most recent session")
  .option("--fullscreen", "run the REPL in the alternate (fullscreen) terminal buffer")
  .argument("[prompt...]", "one-off prompt: run a single agentic turn and exit")
  .action(main);

const CONFIG_KEYS: Record<string, keyof NonNullable<ReturnType<typeof loadConfig>>> = {
  "api-key": "apiKey",
  apikey: "apiKey",
  model: "model",
  thinking: "thinking",
  "reasoning-effort": "reasoningEffort",
  reasoningeffort: "reasoningEffort",
  temperature: "temperature",
  "top-p": "topP",
  topp: "topP",
  "max-tokens": "maxTokens",
  maxtokens: "maxTokens",
  "base-url": "baseUrl",
  baseurl: "baseUrl",
  theme: "theme",
  color: "promptColor",
  "prompt-color": "promptColor",
  promptcolor: "promptColor",
  mode: "mode",
  fullscreen: "fullscreen",
  "allowed-tools": "allowedTools",
  allowedtools: "allowedTools",
  "context-window": "contextWindow",
  contextwindow: "contextWindow",
};

program
  .command("config")
  .description("view or change dsk configuration")
  .argument("<action>", "show | get <key> | set <key> <value>")
  .argument("[key]", "config key (api-key, model, thinking, reasoning-effort, temperature, top-p, max-tokens, base-url)")
  .argument("[value]", "value to set")
  .action(configCmd);

function maskKey(v: string | undefined): string {
  if (!v) return "(unset)";
  if (v.length <= 8) return "****";
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

/**
 * Interactive first-run setup: ask for the API key (hidden input), verify it
 * against GET /models, and persist it to ~/.dsk/config.json (0600).
 * Returns the key, or null if the user gives up.
 */
async function firstRunSetup(baseUrl: string): Promise<string | null> {
  console.log(chalk.bold("\nWelcome to dsk — DeepSeek agentic CLI!"));
  console.log(chalk.dim("This looks like your first run — let's set up your DeepSeek API key."));
  console.log(
    chalk.dim(
      "Get one at https://platform.deepseek.com/api_keys . It will be stored in ~/.dsk/config.json with 0600 permissions and never printed."
    )
  );
  const prompter = createPrompter(true);
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const key = await askSecret(chalk.bold("Paste your DeepSeek API key (sk-...): "));
      if (!key) {
        console.log(chalk.yellow("No key entered — aborting setup. Run `dsk config set api-key <key>` later."));
        return null;
      }
      const status = await checkApiKey(baseUrl, key);
      if (status === "ok") {
        saveConfig({ apiKey: key });
        console.log(chalk.green("✓ Key verified and saved to ~/.dsk/config.json."));
        return key;
      }
      if (status === "invalid") {
        console.log(chalk.red("✗ That key was rejected by DeepSeek (401). Check it and try again."));
        const again = await prompter.ask(chalk.dim("Retry? [y]es / [s]kip / [q]uit: "));
        const first = ((again ?? "q").trim().toLowerCase())[0] ?? "q";
        if (first === "s") return null;
        if (first !== "y") return null;
        continue;
      }
      // unverified (network problem): don't block setup on it.
      console.log(
        chalk.yellow(
          "⚠ Couldn't reach DeepSeek to verify the key (network issue?). Saving it anyway — you can change it later with `dsk config set api-key`."
        )
      );
      saveConfig({ apiKey: key });
      return key;
    }
  } finally {
    prompter.close();
  }
}

async function configCmd(action: string, key?: string, value?: string): Promise<void> {
  const cfg = loadConfig();
  if (action === "show") {
    for (const [k, v] of Object.entries(cfg)) {
      console.log(`${k}: ${k === "apiKey" ? maskKey(v as string) : v}`);
    }
    if (Object.keys(cfg).length === 0) console.log("(empty config — set keys with `dsk config set <key> <value>`)");
    return;
  }
  if (action === "get") {
    if (!key) {
      console.error("usage: dsk config get <key>");
      process.exit(1);
    }
    const mapped = CONFIG_KEYS[key.toLowerCase()] ?? (key as keyof typeof cfg);
    const v = cfg[mapped];
    if (key.toLowerCase() === "api-key" || key.toLowerCase() === "apikey") {
      console.log(maskKey(v as string));
    } else {
      console.log(v === undefined ? "(unset)" : String(v));
    }
    return;
  }
  if (action === "set") {
    if (!key || value === undefined) {
      console.error("usage: dsk config set <key> <value>");
      process.exit(1);
    }
    const mapped = CONFIG_KEYS[key.toLowerCase()];
    if (!mapped) {
      console.error(
        `Unknown key "${key}". Valid keys: ${Object.keys(CONFIG_KEYS).filter((k) => k.includes("-")).join(", ")}`
      );
      process.exit(1);
    }
    let parsed: string | number | boolean | string[] = value;
    if (mapped === "temperature" || mapped === "topP" || mapped === "maxTokens" || mapped === "contextWindow") {
      const n = Number(value);
      if (Number.isNaN(n)) {
        console.error(`"${value}" is not a number.`);
        process.exit(1);
      }
      parsed = n;
    }
    if (mapped === "allowedTools") {
      parsed = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (mapped === "thinking" && value !== "enabled" && value !== "disabled") {
      console.error('thinking must be "enabled" or "disabled".');
      process.exit(1);
    }
    if (mapped === "reasoningEffort" && !["low", "high", "max"].includes(value)) {
      console.error('reasoning-effort must be "low", "high", or "max".');
      process.exit(1);
    }
    if (mapped === "theme" && !THEME_NAMES.includes(value as (typeof THEME_NAMES)[number])) {
      console.error(`theme must be one of: ${THEME_NAMES.join(", ")}.`);
      process.exit(1);
    }
    if (mapped === "promptColor" && !COLOR_NAMES.includes(value as (typeof COLOR_NAMES)[number])) {
      console.error(`color must be one of: ${COLOR_NAMES.join(", ")}.`);
      process.exit(1);
    }
    if (mapped === "mode" && !PERMISSION_MODES.includes(value as PermissionMode)) {
      console.error(`mode must be one of: ${PERMISSION_MODES.join(", ")}.`);
      process.exit(1);
    }
    if (mapped === "fullscreen") {
      if (value === "true") parsed = true;
      else if (value === "false") parsed = false;
      else {
        console.error('fullscreen must be "true" or "false".');
        process.exit(1);
      }
    }
    saveConfig({ [mapped]: parsed } as Parameters<typeof saveConfig>[0]);
    if (mapped === "apiKey") {
      console.log(chalk.dim("api-key saved to ~/.dsk/config.json (0600). It is never printed."));
    } else {
      console.log(`${mapped} set to ${value}`);
    }
    return;
  }
  console.error("usage: dsk config show | get <key> | set <key> <value>");
  process.exit(1);
}

function parseArgs(call: { arguments: string }): Record<string, unknown> {
  try {
    return JSON.parse(call.arguments) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function main(promptWords: string[] | undefined, opts: Record<string, unknown>): Promise<void> {
  let settings: EffectiveSettings;
  const palette = getPalette(opts.theme as string | undefined, opts.color as string | undefined);
  const allowedTools = (opts.allowedTools as string | undefined)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const contextWindow = opts.contextWindow !== undefined ? Number(opts.contextWindow) : undefined;
  if (contextWindow !== undefined && Number.isNaN(contextWindow)) {
    console.error(chalk.red("--context-window must be a number (tokens)."));
    process.exit(1);
  }
  try {
    settings = resolveSettings({
      apiKey: opts.apiKey as string | undefined,
      model: opts.model as string | undefined,
      baseUrl: opts.baseUrl as string | undefined,
      thinking: opts.thinking as "enabled" | "disabled" | undefined,
      reasoningEffort: opts.reasoningEffort as "low" | "high" | "max" | undefined,
      theme: opts.theme as string | undefined,
      promptColor: opts.color as string | undefined,
      mode: (opts.mode ?? opts.permissionMode) as PermissionMode | undefined,
      allowedTools,
      contextWindow,
    });
  } catch (e) {
    const missingKey = e instanceof Error && e.message.includes("No DeepSeek API key");
    if (missingKey && isTTY) {
      // First run: offer an interactive setup before giving up.
      const key = await firstRunSetup((opts.baseUrl as string | undefined) ?? DEFAULT_BASE_URL);
      if (!key) {
        console.error(chalk.red((e as Error).message));
        process.exit(1);
      }
      settings = resolveSettings({
        apiKey: key,
        model: opts.model as string | undefined,
        baseUrl: opts.baseUrl as string | undefined,
        thinking: opts.thinking as "enabled" | "disabled" | undefined,
        reasoningEffort: opts.reasoningEffort as "low" | "high" | "max" | undefined,
        theme: opts.theme as string | undefined,
        promptColor: opts.color as string | undefined,
        mode: (opts.mode ?? opts.permissionMode) as PermissionMode | undefined,
        allowedTools,
        contextWindow,
      });
    } else {
      console.error(chalk.red((e as Error).message));
      process.exit(1);
    }
  }

  // Session resume.
  let resumed: ChatMessage[] | undefined;
  let resumedId: string | undefined;
  if (opts.resume) {
    try {
      const s = loadSession(opts.resume as string);
      resumed = s.messages;
      resumedId = s.id;
      console.log(chalk.dim(`Resumed session ${s.id} (model ${s.model}).`));
    } catch {
      console.error(chalk.red(`Session "${opts.resume}" not found. Use --continue or check ~/.dsk/sessions/.`));
      process.exit(1);
    }
  } else if (opts.continue) {
    const s = latestSession();
    if (!s) {
      console.error(chalk.red("No previous session found. Start a new one with `dsk`."));
      process.exit(1);
    }
    resumed = s.messages;
    resumedId = s.id;
    console.log(chalk.dim(`Continuing session ${s.id} (model ${s.model}).`));
  }

  // One-off mode: `dsk "prompt"` — single agentic turn, then exit.
  if (promptWords && promptWords.length > 0) {
    const userMsg: ChatMessage = { role: "user", content: promptWords.join(" ") };
    const systemMsg: ChatMessage = { role: "system", content: buildSystemPrompt(process.cwd()) };
    const messages: ChatMessage[] = resumed
      ? [...resumed, userMsg]
      : [systemMsg, userMsg];
    // Refresh the resumed session's system prompt so current project memory applies.
    if (messages[0]?.role === "system") messages[0] = systemMsg;
    const prompter = isTTY ? createPrompter(true) : null;
    const gate = new PermissionGate({
      skipAll: Boolean(opts.dangerouslySkipPermissions),
      mode: settings.mode,
      allowedTools: settings.allowedTools,
      ask: (q) => (prompter ? prompter.ask(q) : Promise.resolve("n")),
      isInteractive: Boolean(isTTY),
    });
    await runAgentTurn({
      settings,
      messages,
      tools: allTools,
      gate,
      callbacks: {
        onText: (t) => process.stdout.write(t),
        onReasoning: (t) => process.stdout.write(chalk.dim(t)),
        onToolCall: (call) => console.log(toolCallLine(call, palette)),
        onToolResult: (call, result) => console.log(summarizeTool(call.name, parseArgs(call), result, palette)),
        onIterationStart: () => {},
        onCapped: () => console.log(chalk.yellow("⚠ Reached the tool-loop cap; ending this turn.")),
      },
    });
    console.log();
    prompter?.close();
    saveSession({ id: resumedId, model: settings.model, messages });
    process.exit(0);
  }

  // Interactive REPL.
  await startRepl({
    settings,
    skipAll: Boolean(opts.dangerouslySkipPermissions),
    messages: resumed,
    sessionId: resumedId,
    fullscreen: Boolean(opts.fullscreen) || Boolean(loadConfig().fullscreen),
  });
}

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
