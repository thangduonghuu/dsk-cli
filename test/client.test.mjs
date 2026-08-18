import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  chatStream,
  DskApiError,
  DskStreamError,
} from "../dist/agent/deepseekClient.js";

const settings = {
  apiKey: "test-key",
  model: "deepseek-v4-flash",
  baseUrl: "http://127.0.0.1:0",
  thinking: "enabled",
  reasoningEffort: "high",
};

function sse(...chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

/** Start a mock server; returns {url, close, requests}. */
async function mockServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      handler(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

test("accumulates content, reasoning, and fragmented tool_call arguments", async () => {
  const srv = await mockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      sse(
        { choices: [{ delta: { reasoning_content: "Let me think" } }] },
        { choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: " world" } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"src/a.ts"}' } }],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { total_tokens: 42 } }
      )
    );
    res.end();
  });

  const events = [];
  for await (const ev of chatStream({ ...settings, baseUrl: srv.url }, [{ role: "user", content: "hi" }])) {
    events.push(ev);
  }
  await srv.close();

  assert.equal(events.filter((e) => e.type === "reasoning")[0].text, "Let me think");
  assert.equal(
    events.filter((e) => e.type === "text").map((e) => e.text).join(""),
    "Hello world"
  );
  const done = events.find((e) => e.type === "done");
  assert.equal(done.result.reasoningContent, "Let me think");
  assert.equal(done.result.content, "Hello world");
  assert.equal(done.result.toolCalls.length, 1);
  assert.equal(done.result.toolCalls[0].id, "call_1");
  assert.equal(done.result.toolCalls[0].name, "read_file");
  assert.equal(done.result.toolCalls[0].arguments, '{"path":"src/a.ts"}');
  assert.equal(done.result.usage.totalTokens, 42);

  // Request shape: thinking + reasoning_effort sent, no temperature in thinking mode.
  const req = srv.requests[0];
  assert.equal(req.auth, "Bearer test-key");
  assert.deepEqual(req.body.thinking, { type: "enabled" });
  assert.equal(req.body.reasoning_effort, "high");
  assert.equal(req.body.temperature, undefined);
  assert.equal(req.body.stream, true);
});

test("maps 401 to an actionable DskApiError", async () => {
  const srv = await mockServer((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
  });
  await assert.rejects(
    async () => {
      for await (const _ of chatStream({ ...settings, baseUrl: srv.url }, [{ role: "user", content: "hi" }])) {
        /* consume */
      }
    },
    (err) => err instanceof DskApiError && err.status === 401 && err.message.includes("Authentication failed")
  );
  await srv.close();
});

test("retries a 500 with backoff, then succeeds", async () => {
  let calls = 0;
  const srv = await mockServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "boom" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: { content: "ok" } }] }));
    res.end();
  });
  const texts = [];
  for await (const ev of chatStream({ ...settings, baseUrl: srv.url }, [{ role: "user", content: "hi" }])) {
    if (ev.type === "text") texts.push(ev.text);
  }
  await srv.close();
  assert.equal(calls, 2);
  assert.deepEqual(texts, ["ok"]);
});

test("retries a 429 with backoff, then succeeds", async () => {
  let calls = 0;
  const srv = await mockServer((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "throttled" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: { content: "ok after 429" } }] }));
    res.end();
  });
  const texts = [];
  for await (const ev of chatStream({ ...settings, baseUrl: srv.url }, [{ role: "user", content: "hi" }])) {
    if (ev.type === "text") texts.push(ev.text);
  }
  await srv.close();
  assert.equal(calls, 2);
  assert.deepEqual(texts, ["ok after 429"]);
});

test("raises DskStreamError when the stream ends without [DONE]", async () => {
  const srv = await mockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
    res.end(); // no [DONE], no finish_reason
  });
  await assert.rejects(
    async () => {
      for await (const _ of chatStream({ ...settings, baseUrl: srv.url }, [{ role: "user", content: "hi" }])) {
        /* consume */
      }
    },
    (err) => err instanceof DskStreamError && err.message.includes("without a completion marker")
  );
  await srv.close();
});
