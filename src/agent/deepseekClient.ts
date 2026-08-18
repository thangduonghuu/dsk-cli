import type { EffectiveSettings } from "../config.js";

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments string, as returned by the API. */
  arguments: string;
}

/** Outbound shape the API requires when echoing tool_calls back. */
export interface SerializedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: SerializedToolCall[];
  /** Chain-of-thought from the model; must be echoed back when a tool call happened between user turns. */
  reasoning_content?: string | null;
  name?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamResult {
  content: string;
  reasoningContent: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "done"; result: StreamResult };

/** Error carrying an HTTP status from the API, for actionable 401/429 handling. */
export class DskApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryable: boolean
  ) {
    super(message);
    this.name = "DskApiError";
  }
}

/** Stream failed after tokens were already received — partial output is on screen. */
export class DskStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DskStreamError";
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * POST /chat/completions with stream: true and yield text/reasoning deltas as
 * they arrive, then a `done` event with the fully accumulated result
 * (including tool_calls assembled from fragment deltas).
 *
 * Transient errors (429/5xx, network) are retried with exponential backoff up
 * to 3 attempts, but only when nothing has been streamed yet — once tokens are
 * on screen we never resend, to avoid duplicate output.
 */
export async function* chatStream(
  settings: EffectiveSettings,
  messages: ChatMessage[],
  opts: {
    tools?: ToolDef[];
    toolChoice?: "none" | "auto" | "required";
    signal?: AbortSignal;
  } = {}
): AsyncGenerator<StreamEvent> {
  const { apiKey, baseUrl, model } = settings;

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }
  if (settings.thinking === "enabled") {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = settings.reasoningEffort ?? "high";
  } else {
    body.thinking = { type: "disabled" };
  }
  if (settings.maxTokens !== undefined) body.max_tokens = settings.maxTokens;
  // temperature/top_p are silently ignored by the API in thinking mode; only
  // send them in non-thinking mode so their intent is honest.
  if (settings.thinking === "disabled") {
    if (settings.temperature !== undefined) body.temperature = settings.temperature;
    if (settings.topP !== undefined) body.top_p = settings.topP;
  }

  let attempts = 0;
  let started = false; // true once we've received at least one chunk
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempts += 1;
    try {
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      if (!resp.ok) {
        let detail = "";
        try {
          const err = (await resp.json()) as { error?: { message?: string } } | string;
          detail = typeof err === "string" ? err : (err.error?.message ?? JSON.stringify(err));
        } catch {
          detail = await resp.text().catch(() => "");
        }
        const message = detail ? `${resp.status}: ${detail}` : `HTTP ${resp.status}`;
        throw new DskApiError(resp.status, message, RETRYABLE_STATUS.has(resp.status));
      }

      if (!resp.body) throw new DskApiError(0, "Empty response body", true);

      const decoder = new TextDecoder();
      const reader = resp.body.getReader();
      let buffer = "";
      let sawDone = false;
      let content = "";
      let reasoning = "";
      let finishReason: string | null = null;
      let usage: StreamResult["usage"] = null;
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

      /**
       * Process one `data: <json>` line. Returns any text/reasoning events to
       * yield so the terminal streams token-by-token.
       */
      const processLine = (raw: string): StreamEvent[] => {
        const line = raw.trim();
        if (!line.startsWith("data:")) return [];
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          sawDone = true;
          return [];
        }
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(payload) as StreamChunk;
        } catch {
          return []; // ignore malformed keep-alive lines
        }
        started = true;
        const out: StreamEvent[] = [];
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta) {
          if (typeof delta.content === "string" && delta.content.length > 0) {
            content += delta.content;
            out.push({ type: "text", text: delta.content });
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            reasoning += delta.reasoning_content;
            out.push({ type: "reasoning", text: delta.reasoning_content });
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const acc = toolCalls.get(tc.index) ?? { id: "", name: "", arguments: "" };
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.arguments += tc.function.arguments;
              toolCalls.set(tc.index, acc);
            }
          }
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
          };
        }
        return out;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        // SSE events are separated by a blank line; be tolerant of \r\n.
        while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + (buffer.startsWith("\r\n", idx) ? 4 : 2));
          if (rawEvent.trim().length === 0) continue;
          for (const line of rawEvent.split(/\r?\n/)) {
            for (const ev of processLine(line)) yield ev;
          }
        }
      }
      // Flush any trailing buffered data (stream without trailing blank line),
      // including a split multi-byte character at the very end.
      buffer += decoder.decode();
      if (buffer.trim().length > 0) {
        for (const line of buffer.split(/\r?\n/)) {
          for (const ev of processLine(line)) yield ev;
        }
      }

      // Per the API docs a stream terminates with data: [DONE]. If it ended
      // without that marker or a finish_reason, it was truncated mid-flight.
      if (!sawDone && !finishReason) {
        throw new DskStreamError(
          "The stream ended unexpectedly without a completion marker; the response may be incomplete."
        );
      }

      const finalCalls: ToolCall[] = [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.arguments }))
        .filter((c) => c.name.length > 0);

      yield {
        type: "done",
        result: {
          content,
          reasoningContent: reasoning,
          toolCalls: finalCalls,
          finishReason,
          usage,
        },
      };
      return;
    } catch (err) {
      if (err instanceof DskApiError) {
        if (err.status === 401) {
          throw new DskApiError(
            401,
            "Authentication failed (401). Your DeepSeek API key is invalid. Fix it with `dsk config set api-key <key>` or DEEPSEEK_API_KEY.",
            false
          );
        }
        // 429 is retryable: back off and retry like 5xx; only surface the
        // actionable message once the retries are exhausted.
        if (!err.retryable || attempts >= MAX_ATTEMPTS || started) {
          if (err.status === 429) {
            throw new DskApiError(
              429,
              "Rate limit hit (429). DeepSeek is throttling requests — wait a moment and retry.",
              false
            );
          }
          throw err;
        }
        await sleep(1000 * 2 ** (attempts - 1));
        continue;
      }
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      // Network failure: only retry if nothing was streamed yet.
      if (started || attempts >= MAX_ATTEMPTS) {
        throw new DskStreamError(
          `Stream interrupted after partial output: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      await sleep(1000 * 2 ** (attempts - 1));
    }
  }
}
