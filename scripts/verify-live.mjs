#!/usr/bin/env node
/**
 * Live verification against the real DeepSeek API.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=sk-... node scripts/verify-live.mjs
 *
 * Runs three checks with the built CLI:
 *   1. plain streaming text
 *   2. agentic loop: read README.md, summarize (read-only tools)
 *   3. mutation loop: write_file + edit_file + bash (auto-approved)
 *
 * HOME is redirected into the workspace so config/session files stay local.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const key = process.env.DEEPSEEK_API_KEY;
if (!key) {
  console.error("Set DEEPSEEK_API_KEY first (e.g. DEEPSEEK_API_KEY=sk-... node scripts/verify-live.mjs).");
  process.exit(1);
}
const home = join(ROOT, ".verify-home");
mkdirSync(home, { recursive: true });
const baseUrl = process.env.DSK_VERIFY_BASE_URL; // optional override (testing)

function run(args, env, cwd) {
  return new Promise((r) => {
    const child = spawn(process.execPath, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => r({ code, out, err }));
  });
}

const cli = join(ROOT, "dist/cli.js");
const env = { ...process.env, HOME: home, DEEPSEEK_API_KEY: key };

const cases = [
  {
    name: "1. streaming text",
    args: ["Say hello in one short sentence."],
    cwd: ROOT,
    mustInclude: null,
  },
  {
    name: "2. agentic loop (read + summarize)",
    args: ["Read the README.md file in this directory and tell me its first top-level heading."],
    cwd: ROOT,
    mustInclude: null,
  },
];

const scratch = mkdtempSync(join(ROOT, ".verify-scratch-"));
cases.push({
  name: "3. mutation loop (write + edit + bash)",
  args: [
    "--dangerously-skip-permissions",
    "Create scratch.txt containing the text v1. Then use edit_file to change it to v2. Then run the shell command: cat scratch.txt",
  ],
  cwd: scratch,
  mustInclude: "v2",
});

let failures = 0;
for (const c of cases) {
  const args = baseUrl ? [cli, "--base-url", baseUrl, ...c.args] : [cli, ...c.args];
  const { code, out, err } = await run(args, env, c.cwd);
  const combined = out + err;
  const bad =
    combined.includes("Authentication failed") ||
    combined.includes("API error") ||
    combined.includes("Unexpected error") ||
    combined.includes("Permission denied");
  const ok = code === 0 && !bad && (!c.mustInclude || out.includes(c.mustInclude));
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}${ok ? "" : `\n  code=${code}\n  stdout=${out.slice(0, 400)}\n  stderr=${err.slice(0, 200)}`}`);
  if (!ok) failures += 1;
}

rmSync(scratch, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll live checks passed." : `\n${failures} live check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
