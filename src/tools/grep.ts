/**
 * grep — ripgrep, not a reimplementation.
 *
 * A hand-rolled JS walker would have to re-learn .gitignore, binary sniffing
 * and encoding detection, and would be slower at all three. The only thing this
 * file owns is flag translation and a result cap, because an uncapped search
 * result is a four-figure token spend that the model reads twice.
 *
 * Three engines, in order: rg, then `git grep`, then POSIX grep. The middle rung
 * is not redundant — px always works inside a git worktree, and git grep is the
 * only fallback that honours .gitignore, which this tool's description promises.
 * Dropping straight to `grep -r` on a real project fills the cap with
 * node_modules hits and buries the one line the model asked for.
 */

import { relative } from "node:path";
import { confinePath, SafetyError } from "../agent/safety.ts";
import type { ToolContext, ToolDef, ToolOutput } from "../types.ts";

const DEFAULT_MAX = 100;

export const grepTool: ToolDef = {
  name: "grep",
  description:
    "Search file contents with a regex. Returns path:line:text. Respects .gitignore. " +
    `Default ${DEFAULT_MAX} results — narrow the pattern rather than raising it.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex." },
      path: { type: "string", description: "File or directory to search. Default the worktree root." },
      glob: { type: "string", description: 'Filename filter, e.g. "*.ts".' },
      context: { type: "number", description: "Lines of context each side. Default 0." },
      max_results: { type: "number", description: `Cap on result lines. Default ${DEFAULT_MAX}.` },
    },
    required: ["pattern"],
  },
  executionMode: "concurrent",
  run: (args, ctx) => grepRun(args, ctx),
};

async function grepRun(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const pattern = typeof args["pattern"] === "string" ? args["pattern"] : "";
  if (!pattern) return { content: "ERROR: grep needs a pattern.", isError: true };

  const glob = typeof args["glob"] === "string" && args["glob"] ? args["glob"] : undefined;
  const ctxLines = clampInt(args["context"], 0, 0, 20);
  const max = clampInt(args["max_results"], DEFAULT_MAX, 1, 2000);

  let target: string;
  try {
    target = confinePath(ctx.root, typeof args["path"] === "string" && args["path"] ? args["path"] : ".");
  } catch (e) {
    return { content: `ERROR: ${e instanceof SafetyError ? e.message : String(e)}`, isError: true };
  }
  // Search relative to the root so result paths come back short: every result
  // line is re-sent on every later request.
  const rel = relative(ctx.root, target) || ".";

  const rg = ["rg", "--line-number", "--no-heading", "--color", "never"];
  if (ctxLines > 0) rg.push("-C", String(ctxLines));
  if (glob) rg.push("-g", glob);
  // rg gets the pattern verbatim: its dialect is the one the description
  // advertises, and translating would only narrow it (\w there is Unicode-aware).
  rg.push("--", pattern, rel);

  let res = await run(rg, ctx.root);
  let gitignored = true;

  if (res === null) {
    // No ripgrep on this host. git grep is next because it is the only other
    // engine that knows the repo's exclude rules.
    const posix = toPosixEre(pattern);
    const gg = ["git", "grep", "--line-number", "--no-color", "-I", "--untracked", "--exclude-standard", "-E"];
    if (ctxLines > 0) gg.push(`-C${ctxLines}`);
    gg.push("-e", posix);
    // The glob folds into the pathspec. git's pathspec wildcards cross "/" by
    // default, so "src/*.ts" reaches nested files the same way rg's -g does.
    gg.push("--", glob ? (rel === "." ? glob : `${rel}/${glob}`) : rel);

    const g1 = await run(gg, ctx.root);
    // 128 with this message means "not a repo", which is a missing engine, not
    // a failed search. Any other 128 is a real error and must reach the model.
    const notRepo = g1 !== null && g1.code === 128 && /not a git repository/i.test(g1.err);
    res = g1 !== null && !notRepo ? g1 : null;

    if (res === null) {
      // Bare machine, or a directory outside any repo. Plain grep honours no
      // ignore rules at all, so the two directories that would otherwise drown
      // the cap are excluded by hand.
      const g = ["grep", "-rn", "--color=never", "-E", "--exclude-dir=.git", "--exclude-dir=node_modules"];
      if (ctxLines > 0) g.push(`-C${ctxLines}`);
      if (glob) g.push(`--include=${glob}`);
      g.push("-e", posix, rel);
      res = await run(g, ctx.root);
      if (res === null) {
        return {
          content: "ERROR: neither rg nor grep is installed. Use bash with whatever search tool exists.",
          isError: true,
        };
      }
      gitignored = false;
    }
  }

  // Exit 1 is "no matches" for every engine here; only 2+ is a real failure.
  if (res.code >= 2) {
    const why = res.err.trim() || `search exited ${res.code}`;
    return { content: `ERROR: ${why}`, isError: true };
  }

  const lines = res.out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => (l.startsWith("./") ? l.slice(2) : l));

  if (lines.length === 0) {
    return { content: `no matches for /${pattern}/ in ${rel}${glob ? ` (glob ${glob})` : ""}` };
  }

  const shown = lines.slice(0, max);
  const tail = lines.length > max ? `\n[${lines.length - max} more results dropped; narrow the pattern or the glob]` : "";
  // Say so when the engine could not honour .gitignore, rather than let the
  // model read build output as source.
  const note = gitignored ? "" : "\n[searched with plain grep: no .gitignore, only .git and node_modules skipped]";
  return { content: shown.join("\n") + tail + note };
}

/**
 * Perl shorthands to POSIX classes, for the two engines that lack them.
 *
 * Measured on this host: `git grep -E '\s'` matches nothing and exits 1 — a
 * silent false "no matches", which is the worst result a search tool can
 * return, because the model reads it as proof the symbol does not exist and
 * builds on that. BSD grep happens to accept \s as a GNU extension; git grep
 * does not, and a strict POSIX grep does not either. Translating costs nothing
 * where the extension exists (the two spellings mean the same set) and turns a
 * lie into a match where it does not.
 *
 * Escapes and bracket expressions are tracked so that a literal "\\s" and a
 * "[\d]" written by hand are both left alone.
 */
export function toPosixEre(pattern: string): string {
  const CLASS: Record<string, string> = {
    s: "[[:space:]]",
    S: "[^[:space:]]",
    d: "[[:digit:]]",
    D: "[^[:digit:]]",
    w: "[[:alnum:]_]",
    W: "[^[:alnum:]_]",
  };
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const next = pattern[i + 1];
      const rep = next !== undefined && !inClass ? CLASS[next] : undefined;
      if (rep !== undefined) {
        out += rep;
        i++;
        continue;
      }
      out += c + (next ?? "");
      i++;
      continue;
    }
    if (inClass && c === "[" && pattern[i + 1] === ":") {
      // A nested [:alpha:] name; its closing ] is not the class's closing ].
      const close = pattern.indexOf(":]", i + 2);
      if (close !== -1) {
        out += pattern.slice(i, close + 2);
        i = close + 1;
        continue;
      }
    }
    if (!inClass && c === "[") inClass = true;
    // "[]]" and "[^]]" put a literal ] first; it does not close the class.
    else if (inClass && c === "]" && !/\[\^?$/.test(out)) inClass = false;
    out += c;
  }
  return out;
}

interface RunResult {
  code: number;
  out: string;
  err: string;
}

/** null means the binary is not installed; anything else is a real result. */
async function run(argv: string[], cwd: string): Promise<RunResult | null> {
  try {
    const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  } catch {
    return null;
  }
}

function clampInt(v: unknown, dflt: number, lo: number, hi: number): number {
  const n = Number(v ?? dflt);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}
