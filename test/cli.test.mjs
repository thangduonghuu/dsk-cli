import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function sse(...chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

const ROOT = resolve(import.meta.dirname, "..");

/** Run the built CLI as a subprocess. Returns {code, stdout, stderr}. */
function runCli(args, env, cwd) {
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
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("one-off mode runs the full loop against a mock API and persists a session", async () => {
  // Work dir inside the workspace so the sandbox allows session writes via HOME.
  const work = mkdtempSync(join(ROOT, ".test-work-"));
  const home = join(work, "home");
  mkdirSync(join(home, ".dsk"), { recursive: true });
  writeFileSync(join(work, "a.txt"), "cli integration content\n");

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
        res.write(sse({ choices: [{ delta: { content: "read ok: " + last.content.slice(0, 24) } }] }));
      } else {
        res.write(
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_cli",
                      function: { name: "read_file", arguments: '{"path": "a.txt"}' },
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
  const url = `http://127.0.0.1:${server.address().port}`;

  const { code, stdout, stderr } = await runCli(
    ["--base-url", url, "--dangerously-skip-permissions", "read a.txt"],
    { HOME: home, DEEPSEEK_API_KEY: "cli-test-key" },
    work
  );
  await new Promise((r) => server.close(r));

  assert.equal(code, 0, `stderr: ${stderr}`);
  assert.ok(stdout.includes("read ok: 1 | cli integration"), `stdout: ${stdout}`);
  assert.ok(!stdout.includes("cli-test-key"), "API key must never be printed");

  // A session transcript must have been persisted under the HOME override.
  const sessions = readdirSync(join(home, ".dsk", "sessions"));
  assert.equal(sessions.length, 1);
  const saved = JSON.parse(readFileSync(join(home, ".dsk", "sessions", sessions[0]), "utf8"));
  assert.equal(saved.messages.at(-1).role, "assistant");
  assert.ok(saved.messages.some((m) => m.role === "tool"));

  rmSync(work, { recursive: true, force: true });
});

test("one-off mode executes mutating tools (write_file + bash) with auto-approve", async () => {
  const work = mkdtempSync(join(ROOT, ".test-work-"));
  const home = join(work, "home");
  mkdirSync(join(home, ".dsk"), { recursive: true });

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const toolCount = parsed.messages.filter((m) => m.role === "tool").length;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (toolCount === 0) {
        // First turn: write a file.
        res.write(
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "c1", function: { name: "write_file", arguments: '{"path": "out.txt", "content": "hi"}' } },
                  ],
                },
              },
            ],
          })
        );
      } else if (toolCount === 1) {
        // Second turn: cat it via bash.
        res.write(
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: "c2", function: { name: "bash", arguments: '{"command": "cat out.txt"}' } }],
                },
              },
            ],
          })
        );
      } else {
        res.write(sse({ choices: [{ delta: { content: "done: hi" } }] }));
      }
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;

  const { code, stdout } = await runCli(
    ["--base-url", url, "--dangerously-skip-permissions", "create a file and cat it"],
    { HOME: home, DEEPSEEK_API_KEY: "cli-test-key" },
    work
  );
  await new Promise((r) => server.close(r));

  assert.equal(code, 0);
  assert.ok(stdout.includes("done: hi"), `stdout: ${stdout}`);
  // The write actually happened on disk in the work dir.
  assert.equal(readFileSync(join(work, "out.txt"), "utf8"), "hi");
  assert.ok(!stdout.includes("cli-test-key"), "API key must never be printed");

  rmSync(work, { recursive: true, force: true });
});

test("DSK.md project memory is injected into the system prompt", async () => {
  const work = mkdtempSync(join(ROOT, ".test-work-"));
  const home = join(work, "home");
  mkdirSync(join(home, ".dsk"), { recursive: true });
  writeFileSync(join(work, "DSK.md"), "# Conventions\n\nAlways run `npm run lint` before committing.\n");

  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse({ choices: [{ delta: { content: "noted" } }] }));
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;

  const { code } = await runCli(
    ["--base-url", url, "what are the conventions?"],
    { HOME: home, DEEPSEEK_API_KEY: "cli-test-key" },
    work
  );
  await new Promise((r) => server.close(r));

  assert.equal(code, 0);
  assert.equal(requests.length, 1);
  const sys = requests[0].messages.find((m) => m.role === "system");
  assert.ok(sys.content.includes("Always run `npm run lint` before committing."), "memory must be in the system prompt");
  assert.ok(sys.content.includes("# Project memory — DSK.md"), sys.content);

  rmSync(work, { recursive: true, force: true });
});
