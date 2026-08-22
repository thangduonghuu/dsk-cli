import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  estimateTokens,
  contextInfo,
  compactMessages,
  summarizeConversation,
  contextWindowFor,
} from "../dist/context.js";
import { runAgentTurn } from "../dist/agent/loop.js";
import { allTools } from "../dist/agent/tools/index.js";
import { PermissionGate } from "../dist/permissions.js";

function sse(...chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

const baseSettings = {
  apiKey: "k",
  model: "deepseek-v4-flash",
  baseUrl: "http://127.0.0.1:0",
  thinking: "disabled",
  reasoningEffort: "high",
};

test("estimateTokens scales with message size and overhead", () => {
  const few = [{ role: "user", content: "short" }];
  const many = [{ role: "user", content: "x".repeat(4000) }];
  assert.ok(estimateTokens(many) > estimateTokens(few));
  // ~4 chars/token + small per-message overhead (8 chars → 2 tokens).
  assert.equal(estimateTokens([{ role: "user", content: "x".repeat(400) }]), Math.ceil(408 / 4));
});

test("contextInfo computes percentage against the model window (or override)", () => {
  const msgs = [{ role: "user", content: "x".repeat(400) }];
  const info = contextInfo(msgs, "deepseek-v4-flash");
  assert.equal(info.totalTokens, 128_000);
  assert.equal(info.pct, Math.round((estimateTokens(msgs) / 128_000) * 100));
  const small = contextInfo(msgs, "deepseek-v4-flash", 200);
  assert.equal(small.totalTokens, 200);
  assert.equal(small.pct, Math.round((102 / 200) * 100)); // 102 est. tokens / 200
});

test("contextWindowFor uses the table, override, then the default", () => {
  assert.equal(contextWindowFor("deepseek-v4-flash"), 128_000);
  assert.equal(contextWindowFor("deepseek-v4-pro"), 128_000);
  assert.equal(contextWindowFor("unknown-model"), 128_000);
  assert.equal(contextWindowFor("deepseek-v4-flash", 500), 500);
});

test("compactMessages replaces the middle with a summary, keeping system + last", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2 (current request)" },
  ];
  const dropped = compactMessages(messages, "the summary");
  assert.equal(dropped, 2);
  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, "system");
  assert.equal(messages[1].role, "user");
  assert.ok(messages[1].content.includes("the summary"));
  assert.equal(messages[2].content, "u2 (current request)");
});

test("compactMessages is a no-op for short conversations", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "only" },
  ];
  assert.equal(compactMessages(messages, "s"), 0);
  assert.equal(messages.length, 2);
});

test("summarizeConversation calls the API non-streaming and returns a summary", async () => {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "A summary of the older turns." } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;

  const settings = { ...baseSettings, baseUrl: url };
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "old turn" },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "current request" },
  ];
  const res = await summarizeConversation(settings, messages);
  await new Promise((r) => server.close(r));

  assert.ok(res);
  assert.equal(res.replacedMessages, 2);
  assert.ok(res.summary.includes("A summary of the older turns."));
  // The helper call is non-streaming, thinking disabled, and got the middle only.
  assert.equal(requests.length, 1);
  assert.equal(requests[0].stream, false);
  assert.deepEqual(requests[0].thinking, { type: "disabled" });
  assert.equal(requests[0].messages.length, 2);
  assert.ok(requests[0].messages[1].content.includes("old turn"));
  assert.ok(!requests[0].messages[1].content.includes("current request"));
});

test("summarizeConversation returns null for short conversations and on API errors", async () => {
  // Too short to compact.
  assert.equal(
    await summarizeConversation(
      baseSettings,
      [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ]
    ),
    null
  );

  // API failure → null (caller keeps the full history rather than crash).
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "boom" } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const res = await summarizeConversation(
    { ...baseSettings, baseUrl: url },
    [
      { role: "system", content: "s" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ]
  );
  await new Promise((r) => server.close(r));
  assert.equal(res, null);
});

test("agent loop auto-compacts when the context window overflows", async () => {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      if (parsed.stream === false) {
        // Summarization helper call → JSON response.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ choices: [{ message: { content: "The compacted summary." } }], usage: { total_tokens: 5 } })
        );
        return;
      }
      // Main streaming call after compaction → final answer.
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse({ choices: [{ delta: { content: "final answer" } }] }));
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;

  // Tiny context window + a big first message → the transcript overflows at the
  // very first iteration and must be compacted before the model is called.
  const settings = { ...baseSettings, baseUrl: url, contextWindow: 400 };
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "old turn: " + "y".repeat(1000) },
    { role: "assistant", content: "old answer: " + "z".repeat(1000) },
    { role: "user", content: "current request" },
  ];
  const gate = new PermissionGate({ skipAll: true, ask: async () => "n", isInteractive: false });
  const compactEvents = [];
  const warningEvents = [];
  const texts = [];

  const res = await runAgentTurn({
    settings,
    messages,
    tools: allTools,
    gate,
    callbacks: {
      onText: (t) => texts.push(t),
      onReasoning: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onIterationStart: () => {},
      onCapped: () => {},
      onContextCompact: (info) => compactEvents.push(info),
      onContextWarning: (info) => warningEvents.push(info),
    },
  });
  await new Promise((r) => server.close(r));

  assert.equal(res.compacted, true);
  assert.equal(compactEvents.length, 1);
  assert.equal(compactEvents[0].replacedMessages, 2);
  assert.ok(compactEvents[0].summary.includes("The compacted summary."));
  // Warning fired too (the transcript was already over the warn threshold).
  assert.equal(warningEvents.length, 1);
  assert.ok(warningEvents[0].pct >= 80);

  // Compaction replaced the two old turns with one summary message; the model
  // then answered (so the assistant reply is appended after the current user msg).
  assert.equal(messages.length, 4);
  assert.ok(messages[1].content.includes("The compacted summary."));
  assert.equal(messages[2].content, "current request");
  assert.equal(messages[3].content, "final answer");
  assert.deepEqual(texts, ["final answer"]);

  // First request was the summary helper (non-stream); second was the main call.
  assert.equal(requests.length, 2);
  assert.equal(requests[0].stream, false);
  assert.equal(requests[1].stream, true);
  assert.equal(requests[1].messages.length, 3, "compacted messages sent to the model");
});

test("agent loop does not compact a conversation within the window", async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse({ choices: [{ delta: { content: "fine" } }] }));
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;

  const settings = { ...baseSettings, baseUrl: url }; // default 128k window
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "hello" },
  ];
  const gate = new PermissionGate({ skipAll: true, ask: async () => "n", isInteractive: false });
  const compactEvents = [];

  const res = await runAgentTurn({
    settings,
    messages,
    tools: allTools,
    gate,
    callbacks: {
      onText: () => {},
      onReasoning: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onIterationStart: () => {},
      onCapped: () => {},
      onContextCompact: (info) => compactEvents.push(info),
    },
  });
  await new Promise((r) => server.close(r));

  assert.equal(res.compacted, false);
  assert.equal(compactEvents.length, 0);
  assert.equal(messages.length, 3); // system, user, assistant answer
});
