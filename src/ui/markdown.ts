import type { Palette } from "./theme.js";

const FENCE = "```";

/**
 * Lightweight inline markdown styling for streamed text. Only applies a
 * style when the delimiters are balanced within the chunk, so a fence split
 * across two stream chunks degrades to raw text instead of stray `**`.
 */
export function styleInline(s: string, palette: Palette): string {
  if (s === "") return s;
  // Delimiter-balance guards: if any construct is unbalanced in this chunk,
  // leave the whole chunk untouched (it will complete in a later chunk).
  const ticks = s.split("`").length - 1;
  if (ticks % 2 !== 0) return s;
  const doubles = s.split("**").length - 1;
  if (doubles % 2 !== 0) return s;
  const singles = s.split("*").length - 1;
  if (singles % 2 !== 0) return s;

  return s
    .replace(/`([^`\n]+)`/g, (_m, c: string) => palette.tool(c))
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, b: string) => palette.accent(b))
    .replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, pre: string, i: string) => pre + palette.dim(i));
}

/** Style a complete single line (headings, lists, quotes). */
function styleLine(line: string, palette: Palette): string {
  const heading = line.match(/^#{1,6}\s+(.*)$/);
  if (heading) return palette.accent(heading[1]);
  const list = line.match(/^(\s*(?:[-*]|\d+\.))\s+(.*)$/);
  if (list) return palette.accent(list[1]) + " " + list[2];
  const quote = line.match(/^(\s*>)\s?(.*)$/);
  if (quote) return palette.dim(quote[1] + " " + quote[2]);
  const hr = line.match(/^\s*([-*_])\1{2,}\s*$/);
  if (hr) return palette.dim(line);
  return styleInline(line, palette);
}

export interface StreamStyler {
  push(chunk: string): string[];
  /** Called when the turn ends, to flush a still-open code fence. */
  flush(): string[];
}

/**
 * Streaming-aware renderer. Text outside code fences is styled inline
 * (balanced delimiters only). Inside a code fence the content is buffered and
 * emitted as a framed, dimmed block once the fence closes.
 */
export function createStreamStyler(enabled: boolean, palette: Palette): StreamStyler {
  if (!enabled) {
    return { push: (chunk) => [chunk], flush: () => [] };
  }
  let inFence = false;
  let fenceLang = "";
  let fenceBuf = "";
  const out: string[] = [];

  // The opener is printed when the fence opens; this only emits the body and
  // the closing frame (an unterminated fence is closed by flush()).
  const flushFence = (res: string[]): void => {
    const body = fenceBuf.replace(/^\n+/, "").replace(/\n+$/, "");
    if (body.trim().length > 0) {
      for (const line of body.split("\n")) res.push(palette.dim("│ ") + line);
    }
    res.push(palette.dim(`└${"─".repeat(36)}`));
  };

  return {
    push(chunk: string): string[] {
      const res: string[] = [];
      let rest = chunk;
      while (rest.length > 0) {
        if (inFence) {
          const idx = rest.indexOf(FENCE);
          if (idx === -1) {
            fenceBuf += rest;
            rest = "";
          } else {
            fenceBuf += rest.slice(0, idx);
            flushFence(res);
            inFence = false;
            rest = rest.slice(idx + FENCE.length);
          }
        } else {
          const idx = rest.indexOf(FENCE);
          if (idx === -1) {
            // Style complete lines, keep the last (partial) line inline-only.
            const nl = rest.lastIndexOf("\n");
            if (nl === -1) {
              res.push(styleInline(rest, palette));
            } else {
              const complete = rest.slice(0, nl);
              for (const line of complete.split("\n")) res.push(styleLine(line, palette) + "\n");
              res.push(styleInline(rest.slice(nl + 1), palette));
            }
            rest = "";
          } else {
            const before = rest.slice(0, idx);
            const nl = before.lastIndexOf("\n");
            if (nl === -1) {
              res.push(styleInline(before, palette));
            } else {
              for (const line of before.slice(0, nl).split("\n")) res.push(styleLine(line, palette) + "\n");
              res.push(styleInline(before.slice(nl + 1), palette));
            }
            rest = rest.slice(idx + FENCE.length);
            const eol = rest.indexOf("\n");
            fenceLang = eol === -1 ? rest.trim() : rest.slice(0, eol).trim();
            fenceBuf = "";
            inFence = true;
            // Print the opening frame immediately so the user sees it.
            res.push(palette.dim(`┌─ ${fenceLang || "code"} ${"─".repeat(Math.max(6, 34 - (fenceLang || "code").length))}`));
            rest = eol === -1 ? "" : rest.slice(eol + 1);
          }
        }
      }
      return res;
    },
    flush(): string[] {
      const res: string[] = [];
      if (inFence) {
        flushFence(res);
        inFence = false;
        fenceBuf = "";
      }
      return res;
    },
  };
}
