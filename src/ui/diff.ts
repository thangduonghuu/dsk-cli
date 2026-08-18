import diff from "fast-diff";

export interface DiffStats {
  added: number;
  removed: number;
}

/** Count how many newline-terminated lines a text chunk spans. */
function linesIn(s: string): number {
  if (s === "") return 0;
  const nl = s.split("\n").length - 1;
  return s.endsWith("\n") ? nl : nl + 1;
}

/** Maximum LCS table cells before falling back to a cheap approximation. */
const LCS_CELL_CAP = 1_000_000;

/**
 * Line-level add/remove stats via an LCS diff over the line arrays. Falls back
 * to a char-diff approximation for very large files.
 */
export function lineDiffStats(oldText: string, newText: string): DiffStats {
  // "" split on \n yields [""], a phantom line — treat empty input as zero lines.
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const n = a.length;
  const m = b.length;

  if (n * m > LCS_CELL_CAP) {
    const parts = diff(oldText, newText);
    let added = 0;
    let removed = 0;
    for (const [op, text] of parts) {
      if (op === -1) removed += Math.max(1, linesIn(text));
      else if (op === 1) added += Math.max(1, linesIn(text));
    }
    return { added, removed };
  }

  // DP LCS (bottom-up), rows of width m+1.
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      i++;
      removed++;
    } else {
      j++;
      added++;
    }
  }
  removed += n - i;
  added += m - j;
  return { added, removed };
}

/** "1234" -> "1.2k" style formatting for token counts. */
export function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 123456 -> "2:03"; 42 -> "42s". */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Unified-diff hunks (used by the /diff viewer)
// ---------------------------------------------------------------------------

export type DiffLineKind = "ctx" | "add" | "del";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffHunk {
  /** 1-based old-file start line and old-side line count. */
  oldStart: number;
  oldCount: number;
  /** 1-based new-file start line and new-side line count. */
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
}

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_HUNK_LINES = 200;

/**
 * Line-level unified diff. Returns [] when the texts are identical. The
 * fallback for very large files (LCS table too big) is a single whole-file
 * replace hunk.
 */
export function lineDiffHunks(
  oldText: string,
  newText: string,
  context = DEFAULT_CONTEXT,
  maxHunkLines = DEFAULT_MAX_HUNK_LINES
): DiffHunk[] {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  const n = a.length;
  const m = b.length;

  if (n * m > LCS_CELL_CAP) {
    const same = n === m && a.every((x, i) => x === b[i]);
    if (same) return [];
    const lines: DiffLine[] = [
      ...a.map((text) => ({ kind: "del" as const, text })),
      ...b.map((text) => ({ kind: "add" as const, text })),
    ];
    return [{ oldStart: 1, oldCount: n, newStart: 1, newCount: m, lines }];
  }

  // Bottom-up LCS table (same DP as lineDiffStats).
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }

  // Walk the table into a flat op list.
  type Op = { kind: "keep" | "del" | "add"; text: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "keep", text: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ kind: "del", text: a[i] });
      i++;
    } else {
      ops.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", text: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ kind: "add", text: b[j] });
    j++;
  }

  // Change regions = maximal runs containing at least one del/add.
  const regions: Array<{ start: number; end: number }> = [];
  let rs = -1;
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].kind !== "keep") {
      if (rs === -1) rs = k;
    } else if (rs !== -1) {
      regions.push({ start: rs, end: k });
      rs = -1;
    }
  }
  if (rs !== -1) regions.push({ start: rs, end: ops.length });
  if (regions.length === 0) return [];

  // Expand regions with context and merge overlapping ones.
  const ranges: Array<{ start: number; end: number }> = [];
  for (const reg of regions) {
    const s = Math.max(0, reg.start - context);
    const e = Math.min(ops.length, reg.end + context);
    const last = ranges[ranges.length - 1];
    if (last && s <= last.end) last.end = e;
    else ranges.push({ start: s, end: e });
  }

  const buildHunk = (s: number, e: number): DiffHunk => {
    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < s; k++) {
      if (ops[k].kind !== "add") oldLine++;
      if (ops[k].kind !== "del") newLine++;
    }
    const lines: DiffLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let k = s; k < e; k++) {
      const op = ops[k];
      if (op.kind === "keep") {
        lines.push({ kind: "ctx", text: op.text });
        oldCount++;
        newCount++;
      } else if (op.kind === "del") {
        lines.push({ kind: "del", text: op.text });
        oldCount++;
      } else {
        lines.push({ kind: "add", text: op.text });
        newCount++;
      }
    }
    return { oldStart: oldLine, oldCount, newStart: newLine, newCount, lines };
  };

  const hunks: DiffHunk[] = [];
  let total = 0;
  for (const r of ranges) {
    hunks.push(buildHunk(r.start, r.end));
    total += r.end - r.start;
    if (total >= maxHunkLines) break;
  }
  return hunks;
}

/** Human summary like "+3 −2" for a hunk list (used in tool result lines). */
export function summarizeHunks(hunks: DiffHunk[]): string {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === "add") added++;
      else if (l.kind === "del") removed++;
    }
  }
  return `+${added} −${removed}`;
}
