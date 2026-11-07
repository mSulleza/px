/**
 * Worktree isolation.
 *
 * px never edits the checkout the user is sitting in. Every task gets its own
 * `git worktree` on a `px/<taskId>` branch, which buys three things at once:
 * the agent's tools need no permission prompt because the blast radius is one
 * directory; a failed run is undone by deleting that directory; and the user
 * can keep working in the parent while px runs.
 *
 * The landing rule is fast-forward only. Never a merge commit, never a rebase:
 * px is not allowed to resolve a conflict on the user's behalf or to rewrite
 * history it did not author. If the parent moved, the answer is "rebase it
 * yourself or run me again", not a clever automatic merge.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface Worktree {
  path: string;
  branch: string;
}

export interface LandResult {
  merged: boolean;
  message: string;
}

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[]): Promise<GitRun> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Ask git for stable, unlocalized output: these strings get parsed and
    // shown to a model, and a translated "not a git repository" is unmatchable.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function gitOk(cwd: string, args: string[], what: string): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) {
    throw new Error(`${what} failed (git ${args.join(" ")} exited ${r.code}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

/** Synchronous because callers need it before any await, at startup. */
export function gitRoot(cwd: string): string {
  const proc = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--show-toplevel"],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "C" },
  });
  const root = new TextDecoder().decode(proc.stdout).trim();
  if (proc.exitCode !== 0 || root === "") {
    throw new Error(
      `${cwd} is not inside a git repository. px works by creating a git worktree per task, so it needs one: run \`git init\` and make a first commit.`,
    );
  }
  return root;
}

/** Branch and directory names px will accept. Keeps a task id out of the path. */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function createWorktree(repoRoot: string, taskId: string, worktreeRoot: string): Promise<Worktree> {
  if (!TASK_ID.test(taskId)) {
    throw new Error(`task id "${taskId}" is not usable as a path or branch name (allowed: [A-Za-z0-9._-], not leading .)`);
  }

  // git worktree add -b needs a commit to branch from. On a fresh `git init`
  // it fails with "invalid reference: HEAD", which reads like a px bug.
  const head = await git(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) {
    throw new Error(
      `${repoRoot} has no commits yet, so there is nothing to branch from. Make an initial commit first, then re-run px.`,
    );
  }

  const path = join(worktreeRoot, taskId);
  if (existsSync(path)) {
    throw new Error(`worktree path ${path} already exists. Remove it (px worktree rm) or pick another task id.`);
  }
  mkdirSync(worktreeRoot, { recursive: true });

  const branch = `px/${taskId}`;
  const exists = await git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (exists.code === 0) {
    throw new Error(`branch ${branch} already exists. Land or delete it before reusing task id "${taskId}".`);
  }

  // HEAD is spelled out: with a detached HEAD the implicit start point is the
  // same, but a reader should not have to know that.
  await gitOk(repoRoot, ["worktree", "add", path, "-b", branch, "HEAD"], `creating worktree ${path}`);
  return { path, branch };
}

/**
 * Force-remove the worktree, then delete its branch only if it carries no
 * commits of its own. `-d` rather than `-D`: git gets the final veto, so work
 * the agent actually committed survives even if this function is wrong.
 */
export async function removeWorktree(repoRoot: string, path: string): Promise<void> {
  // Asked before the removal, and asked of git's admin data rather than of the
  // checkout: the common case for cleanup is a directory the user already
  // deleted, where there is no HEAD left to read.
  const branch = await branchOfWorktree(repoRoot, path);

  const rm = await git(repoRoot, ["worktree", "remove", "--force", path]);
  if (rm.code !== 0) {
    const msg = `${rm.stderr} ${rm.stdout}`;
    const absent = /is not a working tree|No such file or directory|not a valid path/i.test(msg);
    if (!absent) throw new Error(`removing worktree ${path} failed: ${rm.stderr || rm.stdout}`);
  }
  // Leaves .git/worktrees clean when the directory was deleted out from under git.
  await git(repoRoot, ["worktree", "prune"]);

  if (!branch.startsWith("px/")) return; // never touch a branch px did not create
  const ahead = await git(repoRoot, ["rev-list", "--count", `HEAD..${branch}`]);
  if (ahead.code === 0 && ahead.stdout === "0") {
    await git(repoRoot, ["branch", "-d", branch]);
  }
}

/** The branch checked out at `path`, per `git worktree list`. "" if unknown. */
async function branchOfWorktree(repoRoot: string, path: string): Promise<string> {
  const listed = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) return "";
  const wanted = canonical(path);
  let current = "";
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) current = canonical(line.slice("worktree ".length).trim());
    else if (line.startsWith("branch ") && current === wanted) {
      return line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  return "";
}

/**
 * git reports resolved paths; callers pass whatever they joined. On macOS that
 * is the /tmp vs /private/tmp difference, which would silently orphan branches.
 * The parent is resolved separately so a deleted worktree still compares equal.
 */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}

/**
 * Fast-forward the parent checkout onto the task branch.
 *
 * Refuses on a dirty parent rather than merging into it: `git merge --ff-only`
 * would happily move HEAD under a half-finished edit of the user's.
 */
export async function land(repoRoot: string, branch: string): Promise<LandResult> {
  try {
    await assertParentClean(repoRoot);
  } catch (e) {
    return { merged: false, message: e instanceof Error ? e.message : String(e) };
  }

  const exists = await git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (exists.code !== 0) return { merged: false, message: `branch ${branch} does not exist` };

  const before = await git(repoRoot, ["rev-parse", "--short", "HEAD"]);
  const merge = await git(repoRoot, ["merge", "--ff-only", branch]);
  if (merge.code !== 0) {
    return {
      merged: false,
      message:
        `${branch} is not a fast-forward of HEAD, so px will not land it: ${merge.stderr || merge.stdout}. ` +
        `Rebase it yourself (git rebase HEAD ${branch}) or re-run the task on the current HEAD.`,
    };
  }
  const after = await git(repoRoot, ["rev-parse", "--short", "HEAD"]);
  const stat = await git(repoRoot, ["diff", "--shortstat", `${before.stdout}..${after.stdout}`]);
  const summary = stat.stdout || "no file changes";
  return { merged: true, message: `fast-forwarded ${before.stdout} -> ${after.stdout} from ${branch} (${summary})` };
}

export async function diffStat(worktreePath: string): Promise<string> {
  const base = await baseCommit(worktreePath);
  const stat = await gitOk(worktreePath, ["diff", "--stat", base], "diffing worktree");
  return withUntracked(stat, await untracked(worktreePath));
}

export async function diff(worktreePath: string): Promise<string> {
  const base = await baseCommit(worktreePath);
  const body = await gitOk(worktreePath, ["diff", base], "diffing worktree");
  return withUntracked(body, await untracked(worktreePath));
}

/**
 * The commit the task branched from, resolved from inside the worktree alone.
 *
 * Diffing against the worktree's own HEAD would show nothing once the loop
 * commits, so the base is the merge-base with whatever the main checkout has
 * checked out. That covers both shapes: committed work and a dirty worktree.
 */
async function baseCommit(worktreePath: string): Promise<string> {
  const common = await git(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code === 0 && common.stdout) {
    const headFile = join(common.stdout, "HEAD");
    if (existsSync(headFile)) {
      const raw = readFileSync(headFile, "utf8").trim();
      const ref = raw.startsWith("ref:") ? raw.slice(4).trim() : raw;
      const mainHead = await git(worktreePath, ["rev-parse", "--verify", ref]);
      if (mainHead.code === 0) {
        const mb = await git(worktreePath, ["merge-base", "HEAD", mainHead.stdout]);
        if (mb.code === 0 && mb.stdout) return mb.stdout;
      }
    }
  }
  return "HEAD";
}

/**
 * git diff never mentions untracked files, and a new file is most of what px writes.
 *
 * `-z` rather than plain --porcelain: git C-quotes any path with a space or a
 * non-ASCII byte, so `naïve.txt` is reported as `"na\303\257ve.txt"`. The model
 * reads this list as the set of files it created and then tries to open one of
 * those names. NUL-separated output is never quoted.
 */
async function untracked(worktreePath: string): Promise<string[]> {
  const r = await git(worktreePath, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (r.code !== 0) return [];
  // A rename entry emits its old path as a second NUL-separated field with no
  // "XY " prefix, so filtering on "?? " cannot pick one up by accident.
  return r.stdout
    .split("\0")
    .filter((e) => e.startsWith("?? "))
    .map((e) => e.slice(3));
}

function withUntracked(body: string, paths: string[]): string {
  if (paths.length === 0) return body;
  const list = paths.map((p) => ` ${p}`).join("\n");
  return `${body ? body + "\n" : ""}untracked (not in the diff above):\n${list}`;
}

/**
 * The parent checkout must be exactly as the user left it.
 *
 * Called after every run. Strict on purpose, untracked files included: px
 * writing into the user's checkout instead of its worktree is a containment
 * bug, and the only useful response to a containment bug is a loud one.
 */
export async function assertParentClean(repoRoot: string): Promise<void> {
  const r = await git(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (r.code !== 0) throw new Error(`git status failed in ${repoRoot}: ${r.stderr || r.stdout}`);
  if (r.stdout === "") return;
  const lines = r.stdout.split("\n");
  const shown = lines.slice(0, 10).join("\n");
  const more = lines.length > 10 ? `\n... and ${lines.length - 10} more` : "";
  throw new Error(`parent checkout ${repoRoot} is not clean:\n${shown}${more}`);
}
