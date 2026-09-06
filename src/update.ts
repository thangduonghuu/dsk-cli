import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { configDir } from "./config.js";

const PKG = "dsk";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

interface UpdateCache {
  lastCheck: number;
  latest: string;
}

function cachePath(): string {
  return join(configDir(), "update-check.json");
}

function readCache(): UpdateCache | null {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf8")) as UpdateCache;
  } catch {
    return null;
  }
}

/** True if `latest` is a higher release than `current`. Pre-release tags are ignored. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** Fetch the `latest` dist-tag version from the npm registry, or null on any failure. */
export async function fetchLatestVersion(registryUrl: string = DEFAULT_REGISTRY): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${registryUrl.replace(/\/+$/, "")}/${PKG}/latest`, {
      signal: ctl.signal,
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Print a one-line suggestion when a newer published version exists. Hits the
 * registry at most once per 24h (cached in ~/.dsk/update-check.json); every
 * failure is silent. Skipped when stdout is not a TTY, or CI / NO_UPDATE_NOTIFIER
 * / DSK_NO_UPDATE_NOTIFIER is set.
 */
export async function notifyOnUpdate(
  current: string,
  registryUrl: string = DEFAULT_REGISTRY
): Promise<void> {
  if (!process.stdout.isTTY) return;
  if (process.env.CI || process.env.NO_UPDATE_NOTIFIER || process.env.DSK_NO_UPDATE_NOTIFIER) return;

  let cache = readCache();
  if (!cache || Date.now() - cache.lastCheck > CHECK_INTERVAL_MS) {
    const latest = await fetchLatestVersion(registryUrl);
    // Record the attempt either way so a failed/offline check backs off for 24h.
    cache = { lastCheck: Date.now(), latest: latest ?? cache?.latest ?? current };
    try {
      writeFileSync(cachePath(), JSON.stringify(cache) + "\n");
    } catch {
      /* best-effort */
    }
  }

  if (isNewer(cache.latest, current)) {
    console.log(
      chalk.yellow(`\nUpdate available: ${current} → ${cache.latest}`) +
        chalk.dim(`\nRun  npm i -g ${PKG}  to update.\n`)
    );
  }
}
