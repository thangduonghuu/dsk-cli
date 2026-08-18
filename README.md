# dsk — DeepSeek agentic CLI

A Claude-Code-style agentic terminal tool powered by the [DeepSeek API](https://api-docs.deepseek.com).
Launch `dsk` in a project directory, type natural-language requests, and the agent
reads/writes files, searches the codebase, and runs shell commands — while
streaming DeepSeek's response token-by-token to your terminal.

## Features

- **Claude-Code-style terminal UI** — colored `❯` prompt bar, dimmed
  thinking block, collapsed one-line tool results (`✓ bash: npm test (exit 0, 4.1s)`),
  and a live footer/status line (tokens in/out · running cost · git branch ·
  elapsed time · permission mode).
- **DeepSeek welcome splash** — on startup you get a Claude-Code-style welcome
  card with a big **`DSK CLI` ASCII wordmark in DeepSeek brand blue** (instead
  of the Claude starburst), a "powered by DeepSeek" tagline, the
  version/context line, and getting-started tips.
- **Streaming replies** — tokens render as they arrive, with the model's
  chain-of-thought shown dimmed under a thinking header when thinking mode is on.
- **Agentic tool loop** — the model can read files, edit code, run tests, and
  keep going in one turn (capped at 25 iterations).
- **7 core tools** — `read_file`, `write_file`, `edit_file`, `list_dir`,
  `glob`, `grep` (ripgrep when available), `bash`.
- **No permission prompts by default** — dsk runs tools (bash, file edits)
  automatically, like DeepSeek's own chat UI: no "Allow …? [y]es/[n]o" questions.
  The setting defaults to the `bypassPermissions` mode. Permission modes still
  exist if you want them — cycle `default → acceptEdits → plan →
  bypassPermissions` with **Shift+Tab** (shown in the banner and footer), or set
  one with `/mode` / `--mode`. Note the mode *named* `default` is not the
  default setting: `default` prompts on every mutating tool, `acceptEdits`
  auto-approves file edits (bash still prompts), `plan` blocks all mutations.
- **Rich prompt editing** — multiline input (`\` + Enter or Ctrl+J), command
  history (↑/↓), `/` command completion and `@` file-path completion (Tab),
  `!cmd` shell mode, Ctrl+A/E/U/K/W editing, Esc to interrupt a turn.
- **Session persistence** — transcripts saved to `~/.dsk/sessions/`, resumable
  with `--resume <id>` or `--continue`.
- **Slash commands** — `/help`, `/clear`, `/model`, `/config`, `/usage`,
  `/diff`, `/theme`, `/color`, `/mode`, `/exit`.

## Requirements

- Node.js 18.17+ (native `fetch`)
- A [DeepSeek API key](https://platform.deepseek.com/api_keys)

## Install

```bash
npm i -g .      # from this directory, or:
npm i -g dsk    # once published
```

## Setup

```bash
dsk                              # first run: interactive setup prompts for your API key
# or:
dsk config set api-key sk-...
# or: export DEEPSEEK_API_KEY=sk-...
# or: pass --api-key sk-... per invocation
```

On first launch with no key configured, `dsk` asks for your API key with hidden
input, verifies it against the API, and saves it to `~/.dsk/config.json` with
`0600` permissions. The key is never printed to the terminal. (The interactive
prompt only appears on a real terminal — piped/non-TTY runs fail with an error,
so set the key via `config set`, `DEEPSEEK_API_KEY`, or `--api-key` first.)

## Usage

```bash
dsk                          # interactive REPL in the current directory
dsk "summarize this repo"    # one-off agentic turn, then exit
dsk --model deepseek-v4-pro  # use the stronger (more expensive) model
dsk --continue               # resume the most recent session
dsk --resume 2026-08-18T12-34-56-789Z   # resume a specific session
dsk config show              # view config (api key masked)
```

### REPL slash commands

```
/help                  show help
/clear                 reset the conversation
/model [name]          list every available model to pick, or switch directly
                       (e.g. /model deepseek-v4-pro). The list is fetched live
                       from GET /models; type a number or a model name.
/config                show current configuration
/usage                 show token usage and cost for this session
/diff                  show the last file change as a unified diff
/theme [name]          switch UI theme (default | ocean | mono)
/color [name]          set the prompt-bar color (e.g. /color pink)
/mode [mode]           show or set permission mode (shift+tab cycles)
/exit                  quit (Ctrl+C twice also works)
```

Other input modes:

- `!cmd` — run a shell command and add its output to the conversation.
- `\` + Enter / Ctrl+J — multiline prompt input.
- `/` + Tab — command completion; `@` + Tab — file-path completion.
- **Esc** — interrupt the agent mid-turn (partial work is kept).
- **Ctrl+C** — at a prompt: press twice to exit.
- **Ctrl+O** — page through the session transcript (via `less`, plain fallback).
- **Shift+Tab** — cycle permission modes.

### Options

| Flag | Description |
| --- | --- |
| `--model <name>` | Model to use (default `deepseek-v4-flash`) |
| `--api-key <key>` | API key (overrides env and config) |
| `--dangerously-skip-permissions` | Auto-approve all tool actions without prompting (redundant today — the default `bypassPermissions` mode already does this) |
| `--mode <mode>` | Permission mode (default `bypassPermissions` — no prompts): `default` \| `acceptEdits` \| `plan` \| `bypassPermissions` |
| `--permission-mode <mode>` | Alias for `--mode` |
| `--thinking <enabled\|disabled>` | Toggle DeepSeek thinking mode |
| `--reasoning-effort <low\|high\|max>` | Reasoning effort (default `high`) |
| `--theme <name>` | UI theme: `default` \| `ocean` \| `mono` |
| `--color <name>` | Prompt-bar color: `default` \| `red` \| `blue` \| `green` \| `yellow` \| `purple` \| `orange` \| `pink` \| `cyan` |
| `--base-url <url>` | Override the API base URL (testing) |
| `--fullscreen` | Run the REPL in the alternate (fullscreen) terminal buffer (also `dsk config set fullscreen true`) |
| `--resume <id>` / `--continue` | Resume a saved session |

Colors are forced on whenever stdout is a TTY, so the themed UI renders even if
your shell profile leaks `NO_COLOR=1`, `TERM=dumb`, or `FORCE_COLOR=0`.

## Development

```bash
npm install
npm run build     # tsc -> dist/
npm run dev       # run from source via tsx
npm test          # SSE parser + agentic loop tests (mock server)
```

## Configuration

`~/.dsk/config.json` supports: `apiKey`, `model`, `thinking`, `reasoningEffort`,
`temperature`, `topP`, `maxTokens`, `baseUrl`, `fullscreen`, plus the UI keys
`theme`, `promptColor`, and the permission `mode`. Set them with
`dsk config set <key> <value>` (kebab-case aliases like `api-key`, `top-p`,
`max-tokens`, `base-url`, and `prompt-color` also work).

## Example session

```
dsk v0.1.0 · ~/projects/myapp · (main) · bypassPermissions mode

❯ Why is the test failing?
  █ Let me look at the test and the implementation.
  ⚙ read_file: test/x.test.ts
  ✓ read_file: Read file: test/x.test.ts
  ⚙ read_file: src/x.ts
  ✓ read_file: Read file: src/x.ts
  The failure is in `handle()`: it returns early on empty input.
  ⚙ edit_file: src/x.ts
  ✓ edit_file: Edit applied: src/x.ts (+1 −1 lines)
  ⚙ bash: npm test
  ✓ bash: npm test (exit 0, 4.1s)
  All tests pass now.
❯ _
⚡ 12.4k in · 3.1k out · $0.004 · (main) · 41s   esc to interrupt · shift+tab for permissions
```

## Notes

- DeepSeek thinking mode silently ignores `temperature`/`top_p` (per the API
  docs), so `dsk` only sends them in non-thinking mode.
- In multi-turn conversations where a tool call happened, the assistant's
  `reasoning_content` is echoed back to the API as the docs require.
- Non-goals for v1: multi-provider support, plugins/MCP, GUI.
