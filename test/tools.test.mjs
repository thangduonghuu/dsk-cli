import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bashTool } from "../dist/agent/tools/bash.js";
import { editFileTool } from "../dist/agent/tools/editFile.js";

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

test("edit_file applies a batch of edits in one call with one diff", async () => {
  const dir = mkdtempSync(join(import.meta.dirname, ".test-edit-"));
  const file = join(dir, "app.txt");
  writeFileSync(file, "alpha\nbeta\ngamma\nbeta\n");
  const approvals = [];
  const ctx2 = {
    cwd: dir,
    requestPermission: async (desc) => {
      approvals.push(desc);
      return true;
    },
  };
  const res = await editFileTool.execute(
    {
      path: "app.txt",
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "gamma", new_string: "GAMMA" },
        { old_string: "beta", new_string: "BETA", replace_all: true },
      ],
    },
    ctx2
  );
  assert.equal(res.ok, true, res.output);
  assert.ok(res.output.includes("4 replacement(s) applied in 3 edits"), res.output);
  assert.ok(res.output.includes("+4 −4"), res.output); // stats: all 4 lines changed
  assert.equal(readFileSync(file, "utf8"), "ALPHA\nBETA\nGAMMA\nBETA\n");
  // One permission prompt for the whole batch, mentioning the edit count.
  assert.equal(approvals.length, 1);
  assert.ok(approvals[0].includes("(3 edits)"), approvals[0]);
  // Diff covers the changed region(s); adjacent edits may merge into one hunk.
  assert.ok(res.diff && res.diff.hunks.length >= 1, "diff should cover the batched edits");
  const changed = res.diff.hunks.reduce(
    (sum, h) => sum + h.lines.filter((l) => l.kind === "add").length,
    0
  );
  assert.equal(changed, 4, "all four changed lines appear in the diff");
  rmSync(dir, { recursive: true, force: true });
});

test("edit_file batch is atomic: a bad edit fails before anything is written", async () => {
  const dir = mkdtempSync(join(import.meta.dirname, ".test-edit-"));
  const file = join(dir, "app.txt");
  writeFileSync(file, "alpha\nbeta\n");
  const res = await editFileTool.execute(
    {
      path: "app.txt",
      edits: [
        { old_string: "alpha", new_string: "ALPHA" },
        { old_string: "does-not-exist", new_string: "x" },
      ],
    },
    { cwd: dir, requestPermission: async () => true }
  );
  assert.equal(res.ok, false);
  assert.ok(res.output.includes("does-not-exist"), res.output);
  // Nothing was written (validation happens before any mutation).
  assert.equal(readFileSync(file, "utf8"), "alpha\nbeta\n");
  rmSync(dir, { recursive: true, force: true });
});

test("edit_file rejects providing both single and batch forms", async () => {
  const dir = mkdtempSync(join(import.meta.dirname, ".test-edit-"));
  const res = await editFileTool.execute(
    { path: "a.txt", old_string: "x", new_string: "y", edits: [{ old_string: "a", new_string: "b" }] },
    { cwd: dir, requestPermission: async () => true }
  );
  assert.equal(res.ok, false);
  assert.ok(res.output.includes("Invalid arguments"), res.output);
  rmSync(dir, { recursive: true, force: true });
});
