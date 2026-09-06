import { readFileSync } from "node:fs";

/**
 * Current dsk version, read from package.json at runtime so there is a single
 * source of truth. Resolves correctly both in dev (src/) and when published
 * (dist/), since package.json sits one directory above either.
 */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
