import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { lineDiffHunks } from "../dist/ui/diff.js";
import { editFileTool } from "../dist/agent/tools/editFile.js";
import { writeFileTool } from "../dist/agent/tools/writeFile.js";

const ctx = { cwd: process.cwd(), requestPermission: async () => true };

test("lineDiffHunks returns [] for identical text", () => {
  assert.deepEqual(lineDiffHunks("a\nb\nc\n", "a\nb\nc\n"), []);
});

test("lineDiffHunks produces a hunk with context and correct counts", () => {
  const oldText = "one\ntwo\nthree\nfour\nfive\n";
  const newText = "one\nTWO\nthree\nfour\nfive\n";
  const hunks = lineDiffHunks(oldText, newText);
  assert.equal(hunks.length, 1);
  const h = hunks[0];
  assert.equal(h.oldStart, 1);
  assert.equal(h.oldCount, 5);
  assert.equal(h.newStart, 1);
  assert.equal(h.newCount, 5);
  const kinds = h.lines.map((l) => l.kind);
  assert.ok(kinds.includes("del") && kinds.includes("add") && kinds.includes("ctx"));
  const del = h.lines.find((l) => l.kind === "del");
  const add = h.lines.find((l) => l.kind === "add");
  assert.equal(del.text, "two");
  assert.equal(add.text, "TWO");
});

test("lineDiffHunks merges nearby changes into one hunk", () => {
  const oldText = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
  const newText = ["a", "B", "c", "d", "E", "f", "g", "h"].join("\n"); // changes 2 lines apart < 2*context
  const hunks = lineDiffHunks(oldText, newText);
  assert.equal(hunks.length, 1, "changes within context should merge");
});

test("edit_file attaches a unified diff to its result", async () => {
  const dir = mkdtempSync(join(import.meta.dirname, "..", ".test-diff-"));
  writeFileSync(join(dir, "f.txt"), "alpha\nbeta\ngamma\n");
  try {
    const res = await editFileTool.execute(
      { path: "f.txt", old_string: "beta", new_string: "BETA" },
      { cwd: dir, requestPermission: async () => true }
    );
    assert.equal(res.ok, true);
    assert.ok(res.diff, "edit_file should attach a diff");
    assert.equal(res.diff.path, "f.txt");
    assert.equal(res.diff.hunks.length, 1);
    assert.ok(res.diff.hunks[0].lines.some((l) => l.kind === "del" && l.text === "beta"));
    assert.ok(res.diff.hunks[0].lines.some((l) => l.kind === "add" && l.text === "BETA"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write_file attaches a diff on overwrite", async () => {
  const dir = mkdtempSync(join(import.meta.dirname, "..", ".test-diff-"));
  writeFileSync(join(dir, "w.txt"), "old line\n");
  try {
    const res = await writeFileTool.execute(
      { path: "w.txt", content: "new line\n" },
      { cwd: dir, requestPermission: async () => true }
    );
    assert.equal(res.ok, true);
    assert.ok(res.diff, "write_file overwrite should attach a diff");
    assert.ok(res.diff.hunks[0].lines.some((l) => l.kind === "del" && l.text === "old line"));
    assert.ok(res.diff.hunks[0].lines.some((l) => l.kind === "add" && l.text === "new line"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
