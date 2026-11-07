/**
 * read — one call, many files.
 *
 * The list argument is the entire point. N parallel single-file reads cost N
 * assistant turns, N tool results and N cache appends, and every one of those
 * byte spans is re-sent on every subsequent request for the life of the
 * session. One call with a list is strictly fewer bytes forever.
 */

import { relative } from "node:path";
import { confinePath, SafetyError } from "../agent/safety.ts";
import type { ToolContext, ToolDef, ToolOutput } from "../types.ts";

const MAX_LINES = 2000;
/**
 * Ceiling for the whole call, not per file. The per-file cap alone is not a
 * cap: read(paths=[20 files]) returned 40,059 lines — roughly 180k tokens in a
 * single tool result, past the compaction threshold and most of the way through
 * a 1M window, from one call the model thought was cheap. The batch argument
 * exists to save turns, not to move the whole repo into the context.
 */
const MAX_TOTAL_LINES = 4000;

export const readTool: ToolDef = {
  name: "read",
  description:
    "Read files, line-numbered. Pass every file you need in ONE call, not several. " +
    "ranges[i] applies to paths[i], 1-indexed inclusive; omit ranges for whole files. " +
    `Caps at ${MAX_LINES} lines per file. The "N|" prefix is display only — never put it in an edit anchor.`,
  parameters: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        description: "Paths relative to the worktree root.",
        items: { type: "string" },
      },
      ranges: {
        type: "array",
        description: "Optional [start,end] line pairs, positionally aligned with paths.",
        items: { type: "array", items: { type: "number" } },
      },
    },
    required: ["paths"],
  },
  executionMode: "concurrent",
  run: (args, ctx) => readRun(args, ctx),
};

async function readRun(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const paths = asStringArray(args["paths"]);
  if (paths.length === 0) {
    return { content: 'ERROR: read needs a non-empty paths array, e.g. read(paths=["src/a.ts"]).', isError: true };
  }

  const blocks: string[] = [];
  let ok = 0;
  let left = MAX_TOTAL_LINES;

  for (let i = 0; i < paths.length; i++) {
    const p = paths[i]!;
    const range = rangeAt(args["ranges"], i);
    if (left <= 0) {
      // Naming the file and the call that gets it keeps the drop recoverable in
      // one turn; a silent omission would have the model reason about a file it
      // never saw.
      blocks.push(
        `==> ${p} <==\n[not read: this call already returned ${MAX_TOTAL_LINES} lines. ` +
          `Call read(paths=["${p}"]) on its own, or pass a range.]`,
      );
      continue;
    }
    try {
      const r = await readOne(ctx.root, p, range, left);
      blocks.push(r.block);
      left -= r.lines;
      ok++;
    } catch (e) {
      // A SafetyError surfaces as content, never as a throw: the model has to
      // see the refusal and choose another path, not crash the loop.
      blocks.push(`==> ${p} <==\nERROR: ${e instanceof SafetyError || e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { content: blocks.join("\n\n"), isError: ok === 0 };
}

interface ReadBlock {
  block: string;
  /** Body lines actually emitted, charged against the call's shared budget. */
  lines: number;
}

async function readOne(
  root: string,
  p: string,
  range: [number, number] | undefined,
  budget: number,
): Promise<ReadBlock> {
  const abs = confinePath(root, p);
  const rel = relative(root, abs) || p;
  const file = Bun.file(abs);
  if (!(await file.exists())) throw new Error(`no such file: ${rel}`);

  const raw = await file.text();
  if (raw.includes("\u0000")) {
    return { block: `==> ${rel} <==\n[binary file, ${file.size} bytes; not shown]`, lines: 1 };
  }
  if (raw === "") return { block: `==> ${rel} <==\n[empty file]`, lines: 1 };

  // A trailing newline terminates the last line; it is not an extra line.
  const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
  const total = lines.length;

  const start = range ? Math.max(1, range[0]) : 1;
  let end = range ? Math.min(total, range[1]) : total;
  if (start > total) {
    return {
      block: `==> ${rel} <==\nERROR: range starts at line ${start} but the file has ${total} lines.`,
      lines: 1,
    };
  }
  if (end < start) end = start;

  // Per-file cap first, then whatever the rest of the batch has left. The two
  // produce the same note because the model's next move is the same either way.
  let note = "";
  const allow = Math.min(MAX_LINES, Math.max(1, budget));
  if (end - start + 1 > allow) {
    end = start + allow - 1;
    note =
      `\n[capped at ${allow} lines; call read(paths=["${rel}"], ` +
      `ranges=[[${end + 1},${Math.min(total, end + MAX_LINES)}]]) for more]`;
  }

  const width = String(end).length;
  const body: string[] = [];
  for (let n = start; n <= end; n++) body.push(`${String(n).padStart(width)}|${lines[n - 1]!}`);

  return { block: `==> ${rel} [lines ${start}-${end} of ${total}] <==\n${body.join("\n")}${note}`, lines: body.length };
}

function asStringArray(v: unknown): string[] {
  // flash occasionally sends a bare string here; accept it rather than burn a turn bouncing it.
  if (typeof v === "string") return [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

function rangeAt(v: unknown, i: number): [number, number] | undefined {
  if (!Array.isArray(v)) return undefined;
  const r: unknown = v[i];
  if (!Array.isArray(r) || r.length < 2) return undefined;
  const a = Number(r[0]);
  const b = Number(r[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return [Math.floor(a), Math.floor(b)];
}
