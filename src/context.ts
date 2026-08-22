import type { EffectiveSettings } from "./config.js";
import type { ChatMessage } from "./agent/deepseekClient.js";
import { completeNonStreaming } from "./agent/deepseekClient.js";

/**
 * Context-window tracking and conversation compaction.
 *
 * dsk keeps the whole transcript in the request, so long sessions can outgrow
 * the model's context window. These helpers estimate the token footprint of the
 * message list, surface how full the window is, and — when the conversation
 * gets close to the limit — summarize the older turns so the agent can keep
 * working without losing the thread (Claude Code's auto-compaction).
 */

/** Fallback window when the model isn't in the table below. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Known context windows (tokens). Extend as new models ship. */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "deepseek-v4-flash": 128_000,
  "deepseek-v4-pro": 128_000,
};

export function contextWindowFor(model: string, override?: number): number {
  if (override && override > 0) return override;
  return MODEL_CONTEXT_WINDOWS[model] ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Rough token estimate (~4 chars/token for mixed code + prose, plus a per
 * message/tool-call overhead). Good enough for threshold decisions; the API's
 * real usage numbers are still shown in the footer.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (m.content) chars += m.content.length;
    if (m.reasoning_content) chars += m.reasoning_content.length;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += tc.function.name.length + tc.function.arguments.length + 12;
      }
    }
    chars += 8; // role + per-message overhead
  }
  return Math.ceil(chars / 4);
}

export interface ContextInfo {
  usedTokens: number;
  totalTokens: number;
  /** 0..100+, how full the window is. */
  pct: number;
}

export function contextInfo(messages: ChatMessage[], model: string, override?: number): ContextInfo {
  const usedTokens = estimateTokens(messages);
  const totalTokens = contextWindowFor(model, override);
  return { usedTokens, totalTokens, pct: Math.round((usedTokens / totalTokens) * 100) };
}

/**
 * Summarize the older part of a conversation (everything except the system
 * prompt and the last message) with a cheap non-streaming completion. Returns
 * null when there is nothing worth compacting or the API call fails, so callers
 * can degrade gracefully (keep the full history rather than crash).
 */
export async function summarizeConversation(
  settings: EffectiveSettings,
  messages: ChatMessage[]
): Promise<{ summary: string; replacedMessages: number } | null> {
  // Keep the system prompt (index 0) and the newest message (the one that just
  // arrived); everything in between is summarizable history.
  if (messages.length < 3) return null;
  const middle = messages.slice(1, -1);
  if (middle.length === 0) return null;

  const transcript = middle
    .map((m) => {
      const role = m.role;
      const body = m.content ?? (m.tool_calls ? m.tool_calls.map((t) => `${t.function.name}(${t.function.arguments})`).join(", ") : "");
      return `[${role}] ${body}`;
    })
    .join("\n");

  const prompt: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a conversation summarizer for a coding agent. Produce a concise, information-dense summary of the conversation below: what the user asked, what was discovered about the codebase, which files were read/written/edited, what commands ran and their outcomes, and what decisions or open questions remain. Preserve exact file paths, command names, and any constraints. Use plain text, 150-300 words, no preamble.",
    },
    { role: "user", content: transcript },
  ];

  try {
    const res = await completeNonStreaming(settings, prompt, { maxTokens: 1024 });
    const summary = res.content.trim();
    if (!summary) return null;
    return { summary, replacedMessages: middle.length };
  } catch {
    return null;
  }
}

/**
 * Replace the summarized middle of the conversation with a single synthetic
 * user message carrying the summary. Mutates `messages` in place; returns the
 * number of messages dropped.
 */
export function compactMessages(messages: ChatMessage[], summary: string): number {
  if (messages.length < 3) return 0;
  const first = messages[0];
  const last = messages[messages.length - 1];
  const dropped = messages.length - 2;
  messages.length = 0;
  messages.push(first);
  messages.push({
    role: "user",
    content:
      "Here is a summary of the conversation so far (the older messages were compacted to stay within the model's context window). Treat it as the history of this session:\n\n" +
      summary,
  });
  messages.push(last);
  return dropped;
}
