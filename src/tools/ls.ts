/**
 * ls — a gitignore-aware listing.
 *
 * Listing node_modules into the context window is the single cheapest way to
 * waste five figures of tokens, so the primary implementation is `git ls-files`
 * (which already knows every exclude rule the repo has) and the plain walk is
 * only the fallback for a directory that is not in a repo.
 */

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { confinePath, SafetyError } from "../agent/safety.ts";
import type { ToolContext, ToolDef, ToolOutput } from "../types.ts";

const DEFAULT_DEPTH = 2;
const MAX_ENTRIES = 400;
const ALWAYS_SKIP = new Set([".git", "node_modules"]);

export const lsTool: ToolDef = {
  name: "ls",
  description:
    "List files under a directory, honouring .gitignore. " +
    `Default depth ${DEFAULT_DEPTH}; deeper directories collapse to "dir/ (N files)". Caps at ${MAX_ENTRIES} entries.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory relative to the worktree root. Default root." },
      depth: { type: "number", description: `Path segments to descend. Default ${DEFAULT_DEPTH}.` },
    },
  },
  executionMode: "concurrent",
  run: (args, ctx) => lsRun(args, ctx),
};

async function lsRun(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const asked = Number(args["depth"] ?? DEFAULT_DEPTH);
  const depth = Number.isFinite(asked) && asked >= 1 ? Math.min(8, Math.floor(asked)) : DEFAULT_DEPTH;

  let dir: string;
  try {
    dir = confinePath(ctx.root, typeof args["path"] === "string" && args["path"] ? args["path"] : ".");
  } catch (e) {
    return { content: `ERROR: ${e instanceof SafetyError ? e.message : String(e)}`, isError: true };
  }
  const rel = relative(ctx.root, dir) || ".";

  const tracked = await gitFiles(dir);
  const files = tracked ?? (await walk(dir, depth));
  if (files === null) return { content: `ERROR: cannot list ${rel}: not a directory or not readable.`, isError: true };
  if (files.length === 0) return { content: `${rel}: empty (or everything in it is gitignored)` };

  // Collapse anything past the depth limit into its ancestor directory, with a
  // count, so the model can decide whether descending is worth a second call.
  const entries = new Map<string, number>();
  for (const f of files) {
    const seg = f.split("/");
    if (seg.length <= depth) {
      entries.set(f, 0);
    } else {
      const d = seg.slice(0, depth).join("/") + "/";
      entries.set(d, (entries.get(d) ?? 0) + 1);
    }
  }

  const names = [...entries.keys()].sort();
  const shown = names.slice(0, MAX_ENTRIES);
  const body = shown.map((n) => {
    const n2 = entries.get(n) ?? 0;
    return n2 > 0 ? `${n} (${n2} files)` : n;
  });

  const head = `${rel} — ${files.length} files, depth ${depth}${tracked ? "" : ", no git repo (plain walk)"}`;
  const tail = names.length > MAX_ENTRIES ? `\n[${names.length - MAX_ENTRIES} more entries; pass a narrower path]` : "";
  return { content: `${head}\n${body.join("\n")}${tail}` };
}

/** Paths relative to `dir`, or null when `dir` is not inside a git repo. */
async function gitFiles(dir: string): Promise<string[] | null> {
  try {
    const proc = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return out.split("\n").filter((l) => l.length > 0);
  } catch {
    return null;
  }
}

/**
 * Fallback walk. It descends two levels past the display depth so the collapsed
 * "(N files)" counts mean something, and stops hard well before it could turn a
 * stray large directory into a token bill.
 */
async function walk(dir: string, depth: number): Promise<string[] | null> {
  const out: string[] = [];
  let ok = false;

  const visit = async (abs: string, prefix: string, left: number): Promise<void> => {
    if (out.length > MAX_ENTRIES * 4) return;
    const items = await readdir(abs, { withFileTypes: true }).catch(() => null);
    if (items === null) return;
    ok = true;
    for (const it of items) {
      if (ALWAYS_SKIP.has(it.name)) continue;
      const p = prefix ? `${prefix}/${it.name}` : it.name;
      // Symlinked directories report false here, so loops are impossible.
      if (it.isDirectory()) {
        if (left > 0) await visit(join(abs, it.name), p, left - 1);
      } else {
        out.push(p);
      }
    }
  };

  await visit(dir, "", depth + 2);
  return ok ? out : null;
}
