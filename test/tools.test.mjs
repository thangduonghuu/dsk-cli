import { test } from "node:test";
import assert from "node:assert/strict";
import { bashTool } from "../dist/agent/tools/bash.js";

const ctx = { cwd: process.cwd(), requestPermission: async () => true };

test("bash captures stdout, stderr and exit code", async () => {
  const res = await bashTool.execute({ command: "echo hello; echo oops >&2; exit 3" }, ctx);
  assert.equal(res.ok, false); // exit code 3
  assert.ok(res.output.includes("hello"), res.output);
  assert.ok(res.output.includes("oops"), res.output);
  assert.ok(res.output.includes("[exit code: 3"), res.output);
});

test("bash timeout kills the whole process tree and reports it", async () => {
  const t0 = Date.now();
  const res = await bashTool.execute({ command: "sleep 30", timeout: 700 }, ctx);
  const elapsed = Date.now() - t0;
  assert.equal(res.ok, false);
  assert.ok(res.output.includes("timed out"), res.output);
  assert.ok(elapsed < 10_000, `took ${elapsed}ms — process tree may not have been killed`);
});

test("bash denies without permission", async () => {
  const denied = { cwd: process.cwd(), requestPermission: async () => false };
  const res = await bashTool.execute({ command: "echo nope", timeout: 5000 }, denied);
  assert.equal(res.ok, false);
  assert.ok(res.output.includes("Permission denied"), res.output);
});
