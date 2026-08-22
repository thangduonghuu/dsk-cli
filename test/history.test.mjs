import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendHistory, loadHistory, historyPath } from "../dist/history.js";

const ROOT = import.meta.dirname;

function withHome(fn) {
  const home = mkdtempSync(join(ROOT, ".test-hist-"));
  mkdirSync(join(home, ".dsk"), { recursive: true });
  const prev = process.env.HOME;
  process.env.HOME = home;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.HOME;
      else process.env.HOME = prev;
      rmSync(home, { recursive: true, force: true });
    });
}

test("history round-trips across loads", async () => {
  await withHome(() => {
    assert.deepEqual(loadHistory(), []);
    appendHistory("first prompt");
    appendHistory("second prompt");
    assert.deepEqual(loadHistory(), ["first prompt", "second prompt"]);
    // File is written with the entries, in order, most recent last.
    const raw = JSON.parse(readFileSync(historyPath(), "utf8"));
    assert.deepEqual(raw, ["first prompt", "second prompt"]);
  });
});

test("history dedupes consecutive repeats and ignores blank lines", async () => {
  await withHome(() => {
    appendHistory("same");
    appendHistory("same");
    appendHistory("   ");
    appendHistory("different");
    assert.deepEqual(loadHistory(), ["same", "different"]);
  });
});

test("history caps at 500 entries", async () => {
  await withHome(() => {
    for (let i = 0; i < 550; i++) appendHistory(`prompt-${i}`);
    const h = loadHistory();
    assert.equal(h.length, 500);
    assert.equal(h[0], "prompt-50");
    assert.equal(h[499], "prompt-549");
  });
});

test("history tolerates a corrupt file", async () => {
  await withHome(() => {
    writeFileSync(historyPath(), "not json {");
    assert.deepEqual(loadHistory(), []);
    appendHistory("recovers");
    assert.deepEqual(loadHistory(), ["recovers"]);
    assert.ok(existsSync(historyPath()));
  });
});
