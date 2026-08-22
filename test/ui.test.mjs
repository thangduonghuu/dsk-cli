import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { completeInput } from "../dist/ui/complete.js";
import { lineDiffStats, formatK, formatElapsed } from "../dist/ui/diff.js";
import { createStreamStyler } from "../dist/ui/markdown.js";
import { getPalette } from "../dist/ui/theme.js";
import { costFromUsage, buildFooter } from "../dist/ui/footer.js";
import { renderBanner, renderDiff, summarizeTool, toolCallLine } from "../dist/ui/render.js";
import { PermissionGate, PERMISSION_MODES } from "../dist/permissions.js";
import { Editor } from "../dist/ui/editor.js";

const palette = getPalette();

test("lineDiffStats reports added/removed lines", () => {
  assert.deepEqual(lineDiffStats("a\nb\nc", "a\nb\nc"), { added: 0, removed: 0 });
  assert.deepEqual(lineDiffStats("a\nb\nc", "a\nx\nc"), { added: 1, removed: 1 });
  assert.deepEqual(lineDiffStats("a\nb\nc", "a\nc"), { added: 0, removed: 1 });
  assert.deepEqual(lineDiffStats("a\nb\nc", "a\nb\nc\nd"), { added: 1, removed: 0 });
  assert.deepEqual(lineDiffStats("", "hello"), { added: 1, removed: 0 });
});

test("formatK and formatElapsed", () => {
  assert.equal(formatK(500), "500");
  assert.equal(formatK(1500), "1.5k");
  assert.equal(formatK(2_400_000), "2.4M");
  assert.equal(formatElapsed(900), "900ms");
  assert.equal(formatElapsed(125000), "2:05");
});

test("stream styler: inline markdown styled only when balanced", () => {
  const s = createStreamStyler(true, palette);
  assert.equal(s.push("**bold**")[0], "bold"); // chalk strips color when piped
  assert.equal(s.push("**unbalanced")[0], "**unbalanced"); // left raw
  assert.equal(s.push("`code`")[0], "code");
});

test("stream styler: code fences are framed and buffered until closed", () => {
  const s = createStreamStyler(true, palette);
  const out1 = s.push("Before\n```js\nconsole.log(1)\n");
  const out2 = s.push("more\n```\nAfter");
  const all = [...out1, ...out2].join("\n");
  assert.ok(all.includes("┌─ js"), all);
  assert.ok(all.includes("console.log(1)"), all);
  assert.ok(all.includes("more"), all);
  assert.ok(!all.includes("```"), "fence markers should be consumed");
  assert.ok(all.includes("After"), all);
});

test("costFromUsage returns cents for known models, 0 for unknown", () => {
  assert.equal(costFromUsage("deepseek-v4-flash", 1_000_000, 1_000_000), 60); // $0.60
  assert.equal(costFromUsage("unknown-model", 1000, 1000), 0);
});

test("buildFooter renders tokens, cost, branch, mode and hints", () => {
  const prev = process.stdout.columns;
  process.stdout.columns = 140; // wide enough for the right-aligned hints
  const footer = buildFooter(
    { mode: "acceptEdits", model: "deepseek-v4-flash", tokensIn: 1500, tokensOut: 500, costCents: 3, elapsedMs: 65000, turns: 1, branch: "main", dirty: true },
    palette
  );
  assert.ok(footer.includes("1.5k in"), footer);
  assert.ok(footer.includes("500 out"), footer);
  assert.ok(footer.includes("$0.030"), footer);
  assert.ok(footer.includes("main*"), footer);
  assert.ok(footer.includes("1:05"), footer);
  assert.ok(footer.includes("acceptEdits"), footer);
  assert.ok(footer.includes("esc to interrupt"), footer);
  process.stdout.columns = prev;
});

test("buildFooter drops hints on a narrow terminal and never wraps", () => {
  const prev = process.stdout.columns;
  process.stdout.columns = 40;
  const footer = buildFooter(
    { mode: "default", model: "deepseek-v4-flash", tokensIn: 0, tokensOut: 0, costCents: 0, elapsedMs: 0, turns: 0 },
    palette
  );
  process.stdout.columns = prev;
  assert.ok(!footer.includes("shift+tab"), footer);
  const lines = footer.split("\n");
  assert.equal(lines.length, 2, "footer block = separator + status");
  assert.ok(lines[0].length <= 40, `separator must not wrap: ${lines[0]}`);
  assert.ok(lines[1].length <= 40, `status must not wrap: ${lines[1]}`);
});

test("renderBanner shows version, cwd and mode", () => {
  const banner = renderBanner({ cwd: "/tmp/x", branch: "feat", dirty: true, mode: "plan" }, palette);
  assert.ok(banner.includes("dsk v0.1.0"), banner);
  assert.ok(banner.includes("/tmp/x"), banner);
  assert.ok(banner.includes("feat*"), banner);
  assert.ok(banner.includes("plan mode"), banner);
});

test("renderBanner full splash: welcome card, DeepSeek logo, tips", () => {
  const prev = process.stdout.columns;
  process.stdout.columns = 80;
  const splash = renderBanner({ cwd: "/tmp/x", branch: "feat", dirty: true, mode: "plan" }, palette, { full: true });
  process.stdout.columns = prev;
  assert.ok(splash.includes("Welcome to dsk"), splash);
  assert.ok(splash.includes("the DeepSeek coding agent"), splash);
  assert.ok(splash.includes("●"), "welcome dot");
  assert.ok(splash.includes("██████╗ ███████╗██╗  ██╗"), "DSK CLI wordmark");
  assert.ok(splash.includes("powered by DeepSeek"), splash);
  assert.ok(splash.includes("dsk v0.1.0"), splash);
  assert.ok(splash.includes("plan mode"), splash);
  assert.ok(splash.includes("Type a message to get started"), splash);
  assert.ok(splash.includes("/help"), splash);
});

test("toolCallLine and summarizeTool produce readable summaries", () => {
  const call = { id: "c1", name: "bash", arguments: '{"command": "npm test"}' };
  assert.equal(toolCallLine(call, palette), "─ Running npm test");
  const res = summarizeTool("bash", { command: "npm test" }, { ok: true, output: "ok\n[exit code: 0, 4.1s]" }, palette);
  assert.ok(res.includes("✓ Command finished: npm test (exit 0, 4.1s)"), res);
  const denied = summarizeTool("bash", { command: "rm x" }, { ok: false, output: "Permission denied by the user" }, palette);
  assert.ok(denied.includes("⏸ Permission denied: bash: rm x"), denied);
  const miss = summarizeTool("edit_file", { path: "a.ts" }, { ok: false, output: "old_string was not found in a.ts" }, palette);
  assert.ok(miss.includes("⚠ Edit failed: a.ts"), miss);
});

test("completeInput: / command completion and @ path completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsk-comp-"));
  writeFileSync(join(dir, "a.txt"), "1");
  writeFileSync(join(dir, "ab.txt"), "2");
  mkdirSync(join(dir, "sub"));

  const cmds = await completeInput("/mo", 3, dir);
  assert.ok(cmds && cmds.matches.includes("/model") && cmds.matches.includes("/mode"));

  const paths = await completeInput("read @a", 7, dir);
  assert.ok(paths && paths.matches.includes("a.txt") && paths.matches.includes("ab.txt"), JSON.stringify(paths));

  const none = await completeInput("read @zz", 8, dir);
  assert.equal(none, null);

  rmSync(dir, { recursive: true, force: true });
});

test("permission modes: acceptEdits auto-approves edits, prompts bash", async () => {
  const gate = new PermissionGate({
    skipAll: false,
    mode: "acceptEdits",
    ask: async () => "n",
    isInteractive: true,
  });
  assert.equal(await gate.ask("edit_file: src/a.ts"), true);
  assert.equal(await gate.ask("write_file: src/b.ts"), true);
  assert.equal(await gate.ask("bash: npm test"), false); // prompted, answered no
});

test("permission modes: plan denies mutations without prompting", async () => {
  const gate = new PermissionGate({
    skipAll: false,
    mode: "plan",
    ask: async () => "y",
    isInteractive: true,
  });
  assert.equal(await gate.ask("edit_file: x"), false);
  assert.equal(await gate.ask("bash: rm -rf /"), false);
});

test("permission modes: bypassPermissions approves everything", async () => {
  const gate = new PermissionGate({
    skipAll: false,
    mode: "bypassPermissions",
    ask: async () => "n",
    isInteractive: true,
  });
  assert.equal(await gate.ask("bash: anything"), true);
  assert.equal(await gate.ask("edit_file: x"), true);
});

test("PERMISSION_MODES cycle order matches the doc", () => {
  assert.deepEqual(PERMISSION_MODES, ["default", "acceptEdits", "plan", "bypassPermissions"]);
});

test("allowedTools auto-approves matching tools without prompting", async () => {
  let asked = 0;
  const gate = new PermissionGate({
    skipAll: false,
    mode: "default",
    allowedTools: ["bash", "edit_file"],
    ask: async () => {
      asked += 1;
      return "n";
    },
    isInteractive: true,
  });
  assert.equal(await gate.ask("bash: npm test", "bash"), true);
  assert.equal(await gate.ask("edit_file: src/a.ts", "edit_file"), true);
  // Tools not on the list still prompt (and here get denied).
  assert.equal(await gate.ask("write_file: src/b.ts", "write_file"), false);
  assert.equal(asked, 1, "only the non-allowlisted tool prompted");
});

test("deniedTools overrides the allowlist and the mode", async () => {
  const gate = new PermissionGate({
    skipAll: false,
    mode: "bypassPermissions",
    allowedTools: ["bash"],
    deniedTools: ["bash"],
    ask: async () => "y",
    isInteractive: true,
  });
  // bypassPermissions normally approves everything, but deniedTools wins.
  assert.equal(await gate.ask("bash: rm -rf /", "bash"), false);
});

test("allowlist matching falls back to prompting when the tool name is unknown", async () => {
  let asked = 0;
  const gate = new PermissionGate({
    skipAll: false,
    mode: "default",
    allowedTools: ["bash"],
    ask: async () => {
      asked += 1;
      return "y";
    },
    isInteractive: true,
  });
  assert.equal(await gate.ask("web_fetch: https://x", "web_fetch"), true);
  assert.equal(asked, 1, "unknown tools still go through the permission prompt");
});

test("renderDiff truncates long diffs with a hint, uncapped renders fully", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const hunks = [
    { oldStart: 1, oldCount: 100, newStart: 1, newCount: 100, lines: lines.map((t) => ({ kind: "add", text: t })) },
  ];

  const capped = renderDiff("big.txt", hunks, palette, { maxLines: 6 });
  const cappedLines = capped.split("\n");
  assert.ok(cappedLines.length <= 7, `capped to maxLines + hint: ${cappedLines.length}`);
  assert.ok(capped.includes("run /diff"), "truncation hint present");
  assert.ok(capped.includes("+ line 0"), "first added line visible");

  const full = renderDiff("big.txt", hunks, palette);
  assert.ok(full.split("\n").length > 100, "uncapped renders all lines");
  assert.ok(!full.includes("run /diff"), "no hint when nothing is truncated");
});

test("editor: live suggestion popup while typing / commands, Tab inserts and cycles", async () => {
  const prevRows = process.stdout.rows;
  const prevCols = process.stdout.columns;
  process.stdout.rows = 12;
  process.stdout.columns = 64;

  const realWrite = process.stdout.write.bind(process.stdout);
  const out = [];
  process.stdout.write = (chunk, ...rest) => {
    out.push(String(chunk));
    return realWrite(chunk, ...rest);
  };

  const COMMANDS = ["help", "clear", "model", "config", "exit", "usage", "diff", "theme", "color", "mode"];
  const tick = () => new Promise((r) => setTimeout(r, 15));
  try {
    const editor = new Editor(
      {
        footer: () => "────\nSTATUS",
        complete: async (text, cursor) => {
          const tok = text.slice(0, cursor).replace(/^.*\n/, "").slice(1).toLowerCase();
          const matches = COMMANDS.filter((c) => c.startsWith(tok)).map((c) => `/${c}`);
          return matches.length ? { start: 0, end: cursor, matches } : null;
        },
      },
      []
    );
    const p = editor.ask("❯ ");
    const all = () => out.join("");
    // Content of the most recent render only (accumulated output holds stale
    // frames from earlier keystrokes).
    const lastRender = () => all().split("\x1b[?25l").pop() ?? "";

    // Typing "/" pops up the full command list above the input.
    process.stdin.emit("keypress", "/", { name: "/", ctrl: false, shift: false, meta: false, sequence: "/" });
    await tick();
    assert.ok(all().includes("❯ /"), "slash typed");
    assert.ok(all().includes("/help"), "suggestion list shown");
    assert.ok(all().includes("/theme"), "windowed list covers most commands");

    // Narrowing to "/mo" filters the popup to model + mode.
    process.stdin.emit("keypress", "m", { name: "m", ctrl: false, shift: false, meta: false, sequence: "m" });
    process.stdin.emit("keypress", "o", { name: "o", ctrl: false, shift: false, meta: false, sequence: "o" });
    await tick();
    assert.ok(lastRender().includes("/model") && lastRender().includes("/mode"), "popup filtered to /model /mode");
    assert.ok(!lastRender().includes("/help"), "non-matching commands hidden");

    // The popup grows the block upward (still pinned to the bottom): input row
    // sits above the 2-line footer, with 2 suggestion rows above it.
    assert.ok(lastRender().includes("❯ /mo\n────\nSTATUS"), "input + footer flush at the bottom");

    // Tab inserts the highlighted match and cycles to the next candidate.
    process.stdin.emit("keypress", "\t", { name: "tab", ctrl: false, shift: false, meta: false, sequence: "\t" });
    await tick();
    assert.ok(lastRender().includes("❯ /model"), "Tab inserts first match");
    process.stdin.emit("keypress", "\t", { name: "tab", ctrl: false, shift: false, meta: false, sequence: "\t" });
    await tick();
    assert.ok(lastRender().includes("❯ /mode"), "second Tab cycles to the next match");

    // Typing past the prefix dismisses the popup (nothing matches "modex").
    process.stdin.emit("keypress", "x", { name: "x", ctrl: false, shift: false, meta: false, sequence: "x" });
    await tick();
    assert.ok(lastRender().includes("❯ /modex"), "typing keeps working after cycling");
    assert.ok(!lastRender().includes("❯ /model"), "popup dismissed when nothing matches");

    editor.interrupt();
    await p;
    editor.close();
  } finally {
    process.stdout.write = realWrite;
    process.stdout.rows = prevRows;
    process.stdout.columns = prevCols;
  }
});

test("editor: bracketed paste buffers text (newlines don't submit) until Enter", async () => {
  const prevRows = process.stdout.rows;
  const prevCols = process.stdout.columns;
  process.stdout.rows = 12;
  process.stdout.columns = 64;

  const realWrite = process.stdout.write.bind(process.stdout);
  const out = [];
  process.stdout.write = (chunk, ...rest) => {
    out.push(String(chunk));
    return realWrite(chunk, ...rest);
  };

  const emit = (str, name, sequence = str) =>
    process.stdin.emit("keypress", str, { name, ctrl: false, shift: false, meta: false, sequence });

  try {
    const editor = new Editor({ footer: () => "────\nSTATUS" }, []);
    const resolved = [];
    const p = editor.ask("❯ ");
    p.then((v) => resolved.push(v));
    const all = () => out.join("");

    // Simulate a bracketed paste with CR newlines (what terminals actually
    // send) plus a trailing blank line: `paste-start` … `paste-end`.
    emit("\x1b[200~", "paste-start");
    for (const ch of "line1\rline2\r\n") emit(ch, ch === "\r" || ch === "\n" ? "return" : ch);
    emit("\x1b[201~", "paste-end");

    // The prompt must NOT have submitted: nothing resolved yet.
    assert.equal(resolved.length, 0, "paste must not submit the prompt");
    assert.ok(all().includes("❯ line1\n  │ line2"), "pasted lines become a multiline buffer");

    // A real Enter now submits the whole pasted block (trailing newline trimmed).
    emit("\r", "return");
    const value = await p;
    assert.equal(value, "line1\nline2", "submitted value is the full pasted block");
    assert.equal(resolved.length, 1, "promise resolved exactly once");

    editor.close();
  } finally {
    process.stdout.write = realWrite;
    process.stdout.rows = prevRows;
    process.stdout.columns = prevCols;
  }
});

test("editor: plain Enter still submits immediately (no paste)", async () => {
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => realWrite(chunk, ...rest);
  try {
    const editor = new Editor({ footer: () => "────\nSTATUS" }, []);
    const p = editor.ask("❯ ");
    process.stdin.emit("keypress", "h", { name: "h", ctrl: false, shift: false, meta: false, sequence: "h" });
    process.stdin.emit("keypress", "i", { name: "i", ctrl: false, shift: false, meta: false, sequence: "i" });
    process.stdin.emit("keypress", "\r", { name: "return", ctrl: false, shift: false, meta: false, sequence: "\r" });
    assert.equal(await p, "hi");
    editor.close();
  } finally {
    process.stdout.write = realWrite;
  }
});

test("editor: prompt block pinned flush to the bottom with absolute positioning", async () => {
  const prevRows = process.stdout.rows;
  const prevCols = process.stdout.columns;
  process.stdout.rows = 12;
  process.stdout.columns = 64;

  const realWrite = process.stdout.write.bind(process.stdout);
  const out = [];
  // Wrap first so the editor's cursor tracker stacks on top; record every write.
  process.stdout.write = (chunk, ...rest) => {
    out.push(String(chunk));
    return realWrite(chunk, ...rest);
  };
  try {
    const editor = new Editor({ footer: () => "────\nSTATUS" }, []);
    const p = editor.ask("❯ ");
    const all = () => out.join("");

    // 12-row terminal, 3-row block (input + 2-line footer) -> starts at row 10,
    // and the footer's last line is written WITHOUT a trailing newline so the
    // block ends exactly on the last row (no scroll, no blank row below).
    assert.ok(all().includes("\x1b[10;1H"), "block pinned to row 10");
    assert.ok(
      all().includes("❯ \n────\nSTATUS\x1b[?25h\x1b[2A"),
      "input+footer flush at the bottom, no trailing newline after the footer"
    );

    // Typing re-renders in place: same absolute row, no drift, no artifacts.
    process.stdin.emit("keypress", "a", { name: "a", ctrl: false, shift: false, meta: false, sequence: "a" });
    assert.ok(all().includes("\x1b[10;1H\x1b[J\x1b[10;1H"), "keystroke erases and redraws the block at row 10");
    assert.ok(all().includes("❯ a\n"), "typed char appears on the input line");

    // A toast line grows the block upward: input + toast + footer at rows 9-12.
    editor.showToast(["mode: x"]);
    assert.ok(all().includes("\x1b[9;1H"), "toast grows the block to start at row 9");
    assert.ok(all().includes("mode: x\n❯ a\n────\nSTATUS"), "toast sits above the input, still flush at the bottom");

    // Clearing the toast shrinks the block: the erase must cover the OLD start
    // (row 9) so no stale toast/input rows survive above the new block.
    const before = out.length;
    process.stdin.emit("keypress", "b", { name: "b", ctrl: false, shift: false, meta: false, sequence: "b" });
    const delta = out.slice(before).join("");
    assert.ok(delta.includes("\x1b[9;1H\x1b[J"), "shrink erase covers the old block start");
    assert.ok(delta.includes("\x1b[10;1H"), "new block redrawn at row 10");
    assert.ok(!delta.includes("mode: x"), "stale toast row erased");

    editor.interrupt();
    await p;
    editor.close();
  } finally {
    process.stdout.write = realWrite;
    process.stdout.rows = prevRows;
    process.stdout.columns = prevCols;
  }
});
