/**
 * edit — anchored replacement with a three-rung matching ladder.
 *
 * Why not a unified diff: measured, a diff applied cleanly and edited the
 * WRONG duplicate in 7 of 44 trials. Anchors plus an explicit occurrence count
 * make that failure impossible to reach silently — a duplicate anchor is a
 * refusal, not a coin flip.
 *
 * Why a ladder at all: tool-argument whitespace drifts in ~80% of calls with
 * zero semantic change. Exact substring matching alone would reject four
 * anchors in five. The ladder normalizes exactly the two things that drift
 * (trailing whitespace, leading indent) and nothing else. There is deliberately
 * no similarity fuzzing: a fuzzy match that lands one line off is worse than a
 * clean failure, because the model cannot see that it happened.
 */

import { relative } from "node:path";
import { confinePath, SafetyError } from "../agent/safety.ts";
import type { ToolContext, ToolDef, ToolOutput } from "../types.ts";

type Rung = "exact" | "trailing" | "indent";

interface LadderStats {
  exact: number;
  trailing: number;
  indent: number;
  /** Anchors no rung could place. Each one costs the model a re-read and a retry. */
  failed: number;
  total: number;
}

const stats = { exact: 0, trailing: 0, indent: 0, failed: 0 };

/**
 * Ladder telemetry for the loop's end-of-run log. Counted per anchor at the
 * moment it resolves, so `exact` against the rest is a direct read on how much
 * whitespace drift the ladder is absorbing — expect exact to lose roughly 4:1,
 * which is the entire justification for rungs 2 and 3 existing.
 */
export function editLadderStats(): Readonly<LadderStats> {
  return { ...stats, total: stats.exact + stats.trailing + stats.indent + stats.failed };
}

export const editTool: ToolDef = {
  name: "edit",
  description:
    "Replace anchored text in one file. Every edit in the batch applies or none do. " +
    "`old` must be unique: if it matches more times than `count` (default 1) the edit is refused, " +
    "so include enough surrounding lines to disambiguate. Leading indent and trailing whitespace are " +
    "matched loosely; everything else must match. Never include read's \"N|\" line-number prefix.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to edit, relative to the worktree root." },
      edits: {
        type: "array",
        description: "Applied in order to one file, atomically.",
        items: {
          type: "object",
          properties: {
            old: { type: "string", description: "Exact text to find." },
            new: { type: "string", description: "Replacement. Empty string deletes." },
            count: { type: "number", description: "Expected occurrences. Default 1." },
          },
          required: ["old", "new"],
        },
      },
    },
    required: ["path", "edits"],
  },
  executionMode: "sequential",
  run: (args, ctx) => editRun(args, ctx),
};

interface EditSpec {
  old: string;
  new: string;
  count: number;
}

async function editRun(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const path = typeof args["path"] === "string" ? args["path"] : "";
  if (!path) return { content: "ERROR: edit needs a path.", isError: true };

  const specs = parseEdits(args["edits"]);
  if (typeof specs === "string") return { content: specs, isError: true };

  let abs: string;
  let rel: string;
  try {
    abs = confinePath(ctx.root, path);
    rel = relative(ctx.root, abs) || path;
  } catch (e) {
    return { content: `ERROR: ${e instanceof SafetyError ? e.message : String(e)}`, isError: true };
  }

  const file = Bun.file(abs);
  if (!(await file.exists())) {
    return { content: `ERROR: no such file: ${rel}. Use write to create it.`, isError: true };
  }

  let content = await file.text();
  const failures: string[] = [];
  const rungsUsed: Rung[] = [];

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const res = applyOne(content, spec, rel);
    if (typeof res === "string") {
      failures.push(specs.length === 1 ? res : `edits[${i}]: ${res}`);
      continue;
    }
    content = res.content;
    rungsUsed.push(res.rung);
  }

  // Atomic: one bad anchor and nothing lands. Partial application leaves the
  // file in a state neither side has read, which is how a retry compounds.
  if (failures.length > 0) {
    const head =
      specs.length === 1
        ? ""
        : `ERROR: no edits applied to ${rel} — ${failures.length} of ${specs.length} anchors failed and edit is atomic.\n`;
    return { content: head + failures.join("\n"), isError: true };
  }

  await Bun.write(abs, content);
  const tally = rungsUsed.reduce<Record<string, number>>((a, r) => ({ ...a, [r]: (a[r] ?? 0) + 1 }), {});
  const detail = Object.entries(tally)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return {
    content: `applied ${specs.length} edit${specs.length === 1 ? "" : "s"} to ${rel} (${detail}), 0 failures.`,
    changedPaths: [rel],
  };
}

function parseEdits(v: unknown): EditSpec[] | string {
  if (!Array.isArray(v) || v.length === 0) {
    return 'ERROR: edit needs a non-empty edits array, e.g. edits=[{"old":"...","new":"..."}].';
  }
  const out: EditSpec[] = [];
  for (let i = 0; i < v.length; i++) {
    const e: unknown = v[i];
    if (!e || typeof e !== "object") return `ERROR: edits[${i}] is not an object.`;
    const o = e as Record<string, unknown>;
    const oldText = o["old"];
    const newText = o["new"];
    if (typeof oldText !== "string" || oldText.length === 0) return `ERROR: edits[${i}].old must be a non-empty string.`;
    if (typeof newText !== "string") return `ERROR: edits[${i}].new must be a string ("" to delete).`;
    const rawCount = Number(o["count"] ?? 1);
    const count = Number.isFinite(rawCount) && rawCount >= 1 ? Math.floor(rawCount) : 1;
    out.push({ old: oldText, new: newText, count });
  }
  return out;
}

interface Applied {
  content: string;
  rung: Rung;
}

interface Span {
  start: number;
  end: number;
  /** Rung 3 only: the indent the file's copy carries and the replacement must inherit. */
  indent?: string;
}

function applyOne(content: string, spec: EditSpec, rel: string): Applied | string {
  const ladder: Array<[Rung, () => Span[]]> = [
    ["exact", () => findExact(content, spec.old)],
    ["trailing", () => findTrailingInsensitive(content, spec.old)],
    ["indent", () => findIndentInsensitive(content, spec.old)],
  ];

  for (const [rung, find] of ladder) {
    const spans = find();
    if (spans.length === 0) continue;

    if (spans.length !== spec.count) {
      // A count refusal costs the model exactly what a miss costs — a re-read
      // and a retry — and the ledger records `failed` as edit_retries. Charging
      // it to the rung instead would inflate the rung's apparent hit rate with
      // anchors that never applied.
      stats.failed++;
      const lines = spans.map((s) => lineOf(content, s.start)).join(", ");
      return (
        `ERROR: anchor matched ${spans.length} time${spans.length === 1 ? "" : "s"} in ${rel} but count=${spec.count}. ` +
        `Matches begin at line${spans.length === 1 ? "" : "s"} ${lines}. ` +
        (spans.length > spec.count
          ? `Extend the anchor with surrounding lines to make it unique, or pass count=${spans.length} to change all of them.`
          : `Re-read the file and fix the anchor or the count.`)
      );
    }
    stats[rung]++;

    // Back to front: replacing forwards invalidates every later offset.
    let out = content;
    for (let i = spans.length - 1; i >= 0; i--) {
      const s = spans[i]!;
      const replacement = s.indent === undefined ? spec.new : reindent(spec.new, s.indent);
      out = out.slice(0, s.start) + replacement + out.slice(s.end);
    }
    return { content: out, rung };
  }

  stats.failed++;
  return notFoundError(content, spec.old, rel);
}

/* ---- rung 1: exact substring ---------------------------------------- */

function findExact(hay: string, needle: string): Span[] {
  const out: Span[] = [];
  if (needle.length === 0) return out;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push({ start: i, end: i + needle.length });
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

/* ---- rung 2: per-line trailing whitespace stripped on both sides ------ */

/**
 * Search in a copy of the file with trailing whitespace deleted, then map the
 * hit back. Because the transform only ever DELETES characters, a contiguous
 * span in the stripped text maps to a contiguous span in the original, and the
 * deleted characters inside it come along for free.
 */
function findTrailingInsensitive(hay: string, needle: string): Span[] {
  const h = stripTrailing(hay);
  const n = stripTrailing(needle).text;
  if (n.length === 0) return [];
  const out: Span[] = [];
  let i = h.text.indexOf(n);
  while (i !== -1) {
    const start = h.origIdx[i]!;
    let end = h.origIdx[i + n.length - 1]! + 1;
    // Absorb whitespace that was stripped off the end of the last matched line,
    // otherwise the replacement leaves it stranded.
    while (end < hay.length && h.deleted[end]) end++;
    out.push({ start, end });
    i = h.text.indexOf(n, i + n.length);
  }
  return out;
}

interface Stripped {
  text: string;
  /** origIdx[k] = index in the source of the k-th surviving character. */
  origIdx: number[];
  deleted: boolean[];
}

function stripTrailing(src: string): Stripped {
  const deleted = new Array<boolean>(src.length).fill(false);
  let i = 0;
  while (i <= src.length) {
    const nl = src.indexOf("\n", i);
    const lineEnd = nl === -1 ? src.length : nl;
    let j = lineEnd;
    while (j > i && (src[j - 1] === " " || src[j - 1] === "\t")) j--;
    for (let k = j; k < lineEnd; k++) deleted[k] = true;
    if (nl === -1) break;
    i = nl + 1;
  }
  let text = "";
  const origIdx: number[] = [];
  for (let k = 0; k < src.length; k++) {
    if (deleted[k]) continue;
    text += src[k]!;
    origIdx.push(k);
  }
  return { text, origIdx, deleted };
}

/* ---- rung 3: common leading indent removed on both sides -------------- */

/**
 * Line-window match. Indent is a per-block property, so this rung cannot be a
 * substring search: each candidate window is dedented by its OWN common indent
 * and compared to the anchor dedented by its own. The window's indent is then
 * carried onto the replacement, which is why the model can hand back a block
 * pasted at column zero and still get correctly indented output.
 */
function findIndentInsensitive(hay: string, needle: string): Span[] {
  const endsNl = needle.endsWith("\n");
  const aLines = normalizeBlock((endsNl ? needle.slice(0, -1) : needle).split("\n"));
  if (aLines.length === 0) return [];

  const fLines = hay.split("\n");
  if (aLines.length > fLines.length) return [];

  const lineStart: number[] = [];
  {
    let p = 0;
    for (const l of fLines) {
      lineStart.push(p);
      p += l.length + 1;
    }
    lineStart.push(p); // phantom position one past the final (possibly absent) newline
  }

  const out: Span[] = [];
  for (let s = 0; s + aLines.length <= fLines.length; ) {
    const win = fLines.slice(s, s + aLines.length);
    if (eq(normalizeBlock(win), aLines)) {
      const start = lineStart[s]!;
      const rawEnd = endsNl ? lineStart[s + aLines.length]! : lineStart[s + aLines.length]! - 1;
      out.push({ start, end: Math.min(rawEnd, hay.length), indent: commonIndent(win) });
      s += aLines.length;
    } else {
      s++;
    }
  }
  return out;
}

function normalizeBlock(lines: string[]): string[] {
  const ind = commonIndent(lines);
  return lines.map((l) => (l.startsWith(ind) ? l.slice(ind.length) : l.replace(/^[ \t]+/, "")).replace(/[ \t]+$/, ""));
}

function commonIndent(lines: string[]): string {
  let ind: string | null = null;
  for (const l of lines) {
    if (l.trim() === "") continue; // blank lines carry no information about the block's indent
    const m = /^[ \t]*/.exec(l);
    const lead = m ? m[0] : "";
    if (ind === null) {
      ind = lead;
      continue;
    }
    let k = 0;
    while (k < ind.length && k < lead.length && ind[k] === lead[k]) k++;
    ind = ind.slice(0, k);
  }
  return ind ?? "";
}

function reindent(text: string, indent: string): string {
  if (text === "") return "";
  const lines = text.split("\n");
  const own = commonIndent(lines);
  return lines
    .map((l) => {
      if (l.trim() === "") return "";
      return indent + (l.startsWith(own) ? l.slice(own.length) : l.replace(/^[ \t]+/, ""));
    })
    .join("\n");
}

function eq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ---- failure reporting ------------------------------------------------ */

function lineOf(content: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < content.length; i++) if (content[i] === "\n") n++;
  return n;
}

/**
 * A bare "not found" costs a wasted turn: the model re-reads the whole file and
 * guesses again. Naming the nearest candidates and spelling out the exact next
 * call turns the failure into one cheap, targeted read.
 */
function notFoundError(content: string, anchor: string, rel: string): string {
  const fLines = content.split("\n");
  const aLines = (anchor.endsWith("\n") ? anchor.slice(0, -1) : anchor).split("\n");
  const cands = nearestCandidates(fLines, aLines, 3);

  if (cands.length === 0) {
    return `ERROR: anchor not found in ${rel} and nothing there resembles it. Call read(paths=["${rel}"]) then retry edit.`;
  }

  const list = cands.map(([a, b]) => `${a}-${b}`).join(", ");
  const best = cands[0]!;
  const lo = Math.max(1, best[0] - 6);
  const hi = Math.min(fLines.length, best[1] + 6);
  return (
    `ERROR: anchor not found in ${rel}. Nearest candidates at lines ${list}. ` +
    `Call read(paths=["${rel}"], ranges=[[${lo},${hi}]]) then retry edit.`
  );
}

function nearestCandidates(fLines: string[], aLines: string[], k: number): Array<[number, number]> {
  const n = Math.min(aLines.length, fLines.length);
  if (n === 0) return [];
  const a = aLines.slice(0, n).map((l) => l.trim());

  const scored: Array<{ s: number; score: number }> = [];
  for (let s = 0; s + n <= fLines.length; s++) {
    let score = 0;
    for (let i = 0; i < n; i++) score += lineSim(fLines[s + i]!.trim(), a[i]!);
    scored.push({ s, score: score / n });
  }
  // Stable: score desc, then earliest line, so the same file always names the
  // same candidates and a retry loop cannot oscillate.
  scored.sort((x, y) => y.score - x.score || x.s - y.s);

  const picked: Array<[number, number]> = [];
  const taken: Array<[number, number]> = [];
  for (const { s, score } of scored) {
    if (score < 0.2 || picked.length >= k) break;
    if (taken.some(([lo, hi]) => s < hi && s + n > lo)) continue;
    taken.push([s, s + n]);
    picked.push([s + 1, s + n]);
  }
  return picked;
}

function lineSim(a: string, b: string): number {
  if (a === b) return a === "" ? 0.2 : 1;
  if (a === "" || b === "") return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.includes(short)) return 0.7;
  let p = 0;
  while (p < short.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < short.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return (0.6 * (p + q)) / long.length;
}
