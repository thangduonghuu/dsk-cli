import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function sse(...chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

function mockApi(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let parsed = null;
      if (body.trim()) {
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = { __unparseable: body };
        }
      }
      const ctx = { method: req.method, url: req.url, body: parsed };
      requests.push(ctx);
      handler(ctx, res);
    });
  });
  return new Promise((r) =>
    server.listen(0, "127.0.0.1", () =>
      r({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((x) => server.close(x)) })
    )
  );
}

function runCli(args, env, cwd, input) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(ROOT, "dist/cli.js"), ...args], {
      env: { ...process.env, ...env },
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("interactive REPL: slash command, permission prompt, agent turn, save-on-exit", async () => {
  const work = mkdtempSync(join(ROOT, ".test-repl-"));
  const home = join(work, "home");
  mkdirSync(join(home, ".dsk"), { recursive: true });

  const api = await mockApi((ctx, res) => {
    const last = ctx.body.messages[ctx.body.messages.length - 1];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (last?.role === "tool") {
      res.write(sse({ choices: [{ delta: { content: "final answer" } }] }));
    } else {
      res.write(
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "bash", arguments: '{"command": "echo hi"}' } },
                ],
              },
            },
          ],
        })
      );
    }
    res.end();
  });

  // Explicit --mode default keeps the interactive prompt: /help → hello
  // (triggers a bash tool call) → y (approve) → /exit
  const { code, stdout, stderr } = await runCli(
    ["--base-url", api.url, "--mode", "default"],
    { HOME: home, DEEPSEEK_API_KEY: "repl-test-key" },
    work,
    "/help\nhello\ny\n/exit\n"
  );
  await api.close();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.ok(stdout.includes("dsk v0.1.0"), `banner missing: ${stdout}`);
  assert.ok(stdout.includes("/clear                 reset the conversation"), `help missing: ${stdout}`);
  assert.ok(stdout.includes("─ Running echo hi"), `tool line missing: ${stdout}`);
  assert.ok(stdout.includes("Allow bash"), `permission prompt missing: ${stdout}`);
  assert.ok(stdout.includes("final answer"), `agent text missing: ${stdout}`);
  assert.ok(!stdout.includes("repl-test-key"), "API key must never leak");

  const sessions = readdirSync(join(home, ".dsk", "sessions"));
  assert.equal(sessions.length, 1, "a session should be saved");
  const saved = JSON.parse(readFileSync(join(home, ".dsk", "sessions", sessions[0]), "utf8"));
  assert.ok(saved.messages.some((m) => m.role === "assistant"));
  assert.ok(saved.messages.some((m) => m.role === "tool"));

  rmSync(work, { recursive: true, force: true });
});

test("default mode runs tools with no permission prompt (like DeepSeek UI)", async () => {
  const work = mkdtempSync(join(ROOT, ".test-repl-"));
  const home = join(work, "home");
  mkdirSync(join(home, ".dsk"), { recursive: true });

  const api = await mockApi((ctx, res) => {
    const last = ctx.body.messages[ctx.body.messages.length - 1];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (last?.role === "tool") {
      res.write(sse({ choices: [{ delta: { content: "final answer" } }] }));
    } else {
      res.write(
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_2", function: { name: "bash", arguments: '{"command": "echo hi"}' } },
                ],
              },
            },
          ],
        })
      );
    }
    res.end();
  });

  // No --mode flag: the default is bypassPermissions, so the bash tool runs
  // without an "Allow bash?" prompt — "y" is never needed.
  const { code, stdout, stderr } = await runCli(
    ["--base-url", api.url],
    { HOME: home, DEEPSEEK_API_KEY: "repl-test-key" },
    work,
    "/help\nhello\n/exit\n"
  );
  await api.close();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.ok(stdout.includes("─ Running echo hi"), `tool line missing: ${stdout}`);
  assert.ok(stdout.includes("✓ Command finished: echo hi"), `tool result missing: ${stdout}`);
  assert.ok(stdout.includes("final answer"), `agent text missing: ${stdout}`);
  assert.ok(!stdout.includes("Allow bash"), `no permission prompt expected: ${stdout}`);

  rmSync(work, { recursive: true, force: true });
});

test("--continue resumes the most recent session", async () => {
  const work = mkdtempSync(join(ROOT, ".test-repl-"));
  const home = join(work, "home");
  mkdirSync(join(home, ".dsk"), { recursive: true });

  const api = await mockApi((ctx, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: { content: "plain answer" } }] }));
    res.end();
  });

  // Create a session with a one-off turn.
  const first = await runCli(
    ["--base-url", api.url, "hello"],
    { HOME: home, DEEPSEEK_API_KEY: "repl-test-key" },
    work
  );
  assert.equal(first.code, 0);
  assert.ok(first.stdout.includes("plain answer"));

  // Resume it in the REPL.
  const second = await runCli(
    ["--continue", "--base-url", api.url],
    { HOME: home, DEEPSEEK_API_KEY: "repl-test-key" },
    work,
    "/exit\n"
  );
  await api.close();

  assert.equal(second.code, 0, `stderr: ${second.stderr}`);
  assert.ok(second.stdout.includes("Continuing session"), `resume banner missing: ${second.stdout}`);

  rmSync(work, { recursive: true, force: true });
});

test("REPL /model lists every model and switches by number", async () => {
  const work = mkdtempSync(join(ROOT, ".test-repl-"));
  const home = join(work, "home");
  mkdirSync(join(home, ".dsk"), { recursive: true });

  const api = await mockApi((ctx, res) => {
    if (ctx.method === "GET" && ctx.url === "/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(sse({ choices: [{ delta: { content: "hi" } }] }));
    res.end();
  });

  // /model (lists) → pick 2 (deepseek-v4-pro) → /exit
  const { code, stdout, stderr } = await runCli(
    ["--base-url", api.url, "--model", "deepseek-v4-flash"],
    { HOME: home, DEEPSEEK_API_KEY: "repl-test-key" },
    work,
    "/model\n2\n/exit\n"
  );
  await api.close();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.ok(stdout.includes("Available models"), `list header missing: ${stdout}`);
  assert.ok(stdout.includes("deepseek-v4-flash") && stdout.includes("deepseek-v4-pro"), `models missing: ${stdout}`);
  assert.ok(stdout.includes("Model switched to deepseek-v4-pro"), `switch missing: ${stdout}`);

  rmSync(work, { recursive: true, force: true });
});

test("REPL /diff shows the last edit as a unified diff", async () => {
  const work = mkdtempSync(join(ROOT, ".test-repl-"));
  const home = join(work, "home");
  mkdirSync(join(home, ".dsk"), { recursive: true });
  writeFileSync(join(work, "notes.txt"), "one\ntwo\nthree\n");

  const api = await mockApi((ctx, res) => {
    if (ctx.method === "GET" && ctx.url === "/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
      return;
    }
    const last = ctx.body.messages[ctx.body.messages.length - 1];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (last?.role === "tool") {
      res.write(sse({ choices: [{ delta: { content: "done" } }] }));
    } else {
      res.write(
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_d",
                    function: {
                      name: "edit_file",
                      arguments: '{"path": "notes.txt", "old_string": "two", "new_string": "TWO"}',
                    },
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

  // --mode default keeps the edit_file approval flow: hello → edit_file
  // (approved with y) → /diff → /exit
  const { code, stdout, stderr } = await runCli(
    ["--base-url", api.url, "--mode", "default"],
    { HOME: home, DEEPSEEK_API_KEY: "repl-test-key" },
    work,
    "hello\ny\n/diff\n/exit\n"
  );
  await api.close();

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.ok(stdout.includes("─ diff: notes.txt"), `diff header missing: ${stdout}`);
  assert.ok(stdout.includes("@@ -"), `hunk header missing: ${stdout}`);
  assert.ok(stdout.includes("- two") && stdout.includes("+ TWO"), `hunk body missing: ${stdout}`);

  rmSync(work, { recursive: true, force: true });
});
