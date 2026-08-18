import type { EffectiveSettings } from "../config.js";
import { chatStream, DskApiError, DskStreamError } from "./deepseekClient.js";
import type { ChatMessage, StreamResult, ToolCall, ToolDef } from "./deepseekClient.js";
import type { PermissionGate } from "../permissions.js";
import type { Tool, ToolResult } from "./tools/index.js";

/** System prompt: how the agent should behave in the user's project. */
export const SYSTEM_PROMPT = `You are dsk, a coding agent running inside a terminal in the user's project directory.

Your job: help with real code work. Use your tools instead of guessing:
- read_file / list_dir / glob / grep to inspect the codebase before answering.
- write_file / edit_file to make changes; prefer targeted edit_file over rewriting whole files.
- bash to run builds, tests, git, and other commands.

Rules:
- Never invent file contents or command output — read or run first.
- When you edit code, run the relevant tests or build afterwards to verify.
- If a command fails, read the error and retry with a fix; don't give up after one attempt.
- Keep prose concise. No fluff, no excessive markdown in the terminal.
- If asked something unrelated to the project, answer directly.

You have access to these tools:
- read_file(path, offset?, limit?) — read a file with line numbers.
- write_file(path, content) — create or overwrite a file (needs approval).
- edit_file(path, old_string, new_string, replace_all?) — targeted edit (needs approval).
- list_dir(path?) — directory listing.
- glob(pattern, path?) — find files by glob pattern.
- grep(pattern, path?, case_insensitive?) — regex search of file contents.
- bash(command, timeout?) — run a shell command (needs approval).`;

export interface AgentCallbacks {
  onText(text: string): void;
  onReasoning(text: string): void;
  onToolCall(call: ToolCall, tool: Tool): void;
  onToolResult(call: ToolCall, result: ToolResult): void;
  onIterationStart(n: number): void;
  onCapped(): void;
  /** Called after each streamed model response with token usage, if provided. */
  onUsage?(usage: StreamResult["usage"]): void;
}

export interface AgentTurnResult {
  iterations: number;
  capped: boolean;
  endedWithToolCalls: boolean;
}

function parseToolArgs(call: ToolCall): unknown {
  try {
    return JSON.parse(call.arguments);
  } catch {
    return { __raw_arguments: call.arguments };
  }
}

/**
 * The agentic loop (spec §4): send history → stream → if tool_calls, execute
 * each locally, append results as role:"tool" messages, and loop back without
 * waiting for the user. Ends when the model returns no tool calls, or after
 * maxIterations with a warning.
 */
export async function runAgentTurn(opts: {
  settings: EffectiveSettings;
  messages: ChatMessage[]; // mutated in place
  tools: Tool[];
  gate: PermissionGate;
  callbacks: AgentCallbacks;
  maxIterations?: number;
  signal?: AbortSignal;
}): Promise<AgentTurnResult> {
  const { settings, messages, tools, gate, callbacks, maxIterations = 25, signal } = opts;
  const toolDefs: ToolDef[] = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  let iterations = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    iterations += 1;
    callbacks.onIterationStart(iterations);

    let result: StreamResult | undefined;
    for await (const ev of chatStream(settings, messages, {
      tools: toolDefs,
      toolChoice: "auto",
      signal,
    })) {
      if (ev.type === "text") callbacks.onText(ev.text);
      else if (ev.type === "reasoning") callbacks.onReasoning(ev.text);
      else result = ev.result;
    }
    if (!result) {
      throw new DskStreamError("The stream ended without a response.");
    }
    callbacks.onUsage?.(result.usage);

    // Persist the assistant message. Per the DeepSeek docs, reasoning_content
    // must be echoed back in later turns when a tool call happened between
    // user turns (the live API enforces this); tool_calls are re-serialized
    // in the API's required shape (type: "function", nested function object).
    messages.push({
      role: "assistant",
      content: result.content.length > 0 ? result.content : null,
      reasoning_content:
        result.toolCalls.length > 0 ? result.reasoningContent : null,
      tool_calls:
        result.toolCalls.length > 0
          ? result.toolCalls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: c.arguments },
            }))
          : undefined,
    });

    if (result.toolCalls.length === 0) {
      return { iterations, capped: false, endedWithToolCalls: false };
    }

    for (const call of result.toolCalls) {
      const tool = tools.find((t) => t.name === call.name);
      let toolResult: ToolResult;
      if (!tool) {
        toolResult = { ok: false, output: `Unknown tool: ${call.name}` };
      } else {
        callbacks.onToolCall(call, tool);
        toolResult = await tool.execute(parseToolArgs(call), {
          cwd: process.cwd(),
          requestPermission: (desc) => gate.ask(desc),
        });
      }
      callbacks.onToolResult(call, toolResult);
      messages.push({ role: "tool", tool_call_id: call.id, content: toolResult.output });
    }

    if (iterations >= maxIterations) {
      callbacks.onCapped();
      return { iterations, capped: true, endedWithToolCalls: true };
    }
  }
}

export { DskApiError, DskStreamError };
