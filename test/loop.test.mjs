import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentTurn, SYSTEM_PROMPT } from "../dist/agent/loop.js";
import { allTools } from "../dist/agent/tools/index.js";
import { PermissionGate } from "../dist/permissions.js";

function sse(...chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

test("full agentic loop: model calls read_file, result feeds back, model answers", async () => {
  // Real file in a temp cwd so the read_file tool actually runs.
  const dir = mkdtempSync(join(tmpdir(), "dsk-loop-"));
  writeFileSync(join(dir, "a.txt"), "hello from a.txt\n");
  const prevCwd = process.cwd();
  process.chdir(dir);

  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const last = parsed.messages[parsed.messages.length - 1];
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (last?.role === "tool") {
        // Tool result fed back: now the model answers.
        res.write(sse({ choices: [{ delta: { content: "done reading" } }] }));
      } else {
        // First turn: think, then ask to read a file.
        res.write(
          sse(
            { choices: [{ delta: { reasoning_content: "I should read the file." } }] },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_abc",
                        function: { name: "read_file", arguments: '{"path": "a.txt"}' },
                      },
                    ],
                  },
                },
              ],
            }
          )
        );
      }
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;

  const settings = {
    apiKey: "k",
    model: "deepseek-v4-flash",
    baseUrl: url,
    thinking: "enabled",
    reasoningEffort: "high",
  };
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: "read a.txt" },
  ];
  const gate = new PermissionGate({ skipAll: true, ask: async () => "n", isInteractive: false });
  const toolCallsSeen = [];
  const texts = [];

  const res = await runAgentTurn({
    settings,
    messages,
    tools: allTools,
    gate,
    callbacks: {
      onText: (t) => texts.push(t),
      onReasoning: () => {},
      onToolCall: (call) => toolCallsSeen.push(call),
      onToolResult: () => {},
      onIterationStart: () => {},
      onCapped: () => {},
    },
  });

  await new Promise((r) => server.close(r));
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });

  assert.equal(res.iterations, 2);
  assert.equal(res.capped, false);
  assert.equal(toolCallsSeen.length, 1);
  assert.equal(toolCallsSeen[0].name, "read_file");
  assert.deepEqual(texts, ["done reading"]);

  // The tool result must be in the conversation with the right tool_call_id.
  const toolMsg = messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "tool message should exist");
  assert.equal(toolMsg.tool_call_id, "call_abc");
  assert.ok(toolMsg.content.includes("hello from a.txt"));

  // Assistant message echoes reasoning_content per DeepSeek multi-turn rules
  // and re-serializes tool_calls in the API-required shape.
  const asst = messages.find((m) => m.role === "assistant");
  assert.equal(asst.tool_calls.length, 1);
  assert.equal(asst.tool_calls[0].type, "function");
  assert.equal(asst.tool_calls[0].function.name, "read_file");
  assert.equal(asst.tool_calls[0].function.arguments, '{"path": "a.txt"}');
  assert.equal(asst.reasoning_content, "I should read the file.");

  // Second request must have sent the tool result back.
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1).role, "tool");
});

test("denied mutation tool feeds a denial back to the model, no crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsk-deny-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const last = parsed.messages[parsed.messages.length - 1];
      if (last?.role === "tool") {
        res.write(sse({ choices: [{ delta: { content: "understood" } }] }));
      } else {
        res.write(
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_x",
                      function: { name: "write_file", arguments: '{"path": "n.txt", "content": "x"}' },
                    },
                  ],
                },
              },
            ],
          })
        );
      }
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const settings = {
    apiKey: "k",
    model: "deepseek-v4-flash",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    thinking: "disabled",
    reasoningEffort: "high",
  };
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: "create n.txt" },
  ];
  const gate = new PermissionGate({ skipAll: false, ask: async () => "n", isInteractive: true });

  await runAgentTurn({
    settings,
    messages,
    tools: allTools,
    gate,
    callbacks: { onText: () => {}, onReasoning: () => {}, onToolCall: () => {}, onToolResult: () => {}, onIterationStart: () => {}, onCapped: () => {} },
  });

  await new Promise((r) => server.close(r));
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });

  const toolMsg = messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "tool message should exist");
  assert.ok(toolMsg.content.includes("Permission denied"));
});
