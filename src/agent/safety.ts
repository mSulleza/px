/**
 * Path confinement and command denial. Imported by both the tools and the
 * guards, so it lives on its own to keep that dependency one-directional.
 *
 * The permission model is: the agent works inside a git worktree it owns, so
 * ordinary edits need no prompt, and the blast radius of a mistake is one
 * `git worktree remove --force`. What is blocked here is the set of actions
 * that escape that containment.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export class SafetyError extends Error {}

/**
 * Resolve a model-supplied path inside the worktree, or refuse.
 *
 * Symlinks are resolved before the check: a symlink inside the worktree
 * pointing at ~/.ssh would otherwise pass a naive prefix test.
 */
export function confinePath(root: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const realRoot = safeReal(root);
  const real = safeReal(abs);
  if (real !== realRoot && !real.startsWith(realRoot.endsWith("/") ? realRoot : realRoot + "/")) {
    throw new SafetyError(
      `path "${p}" resolves outside the worktree (${realRoot}). px only edits inside its own worktree.`,
    );
  }
  return abs;
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Not created yet: resolve the deepest existing ancestor instead.
    const parent = resolve(p, "..");
    if (parent === p) return p;
    return resolve(safeReal(parent), p.slice(parent.length + 1));
  }
}

interface DenyRule {
  re: RegExp;
  why: string;
}

const DENY: DenyRule[] = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf][a-zA-Z]*\s+\/(?:\s|$)/, why: "recursive delete of /" },
  { re: /\bsudo\b/, why: "privilege escalation" },
  { re: /\bgit\s+push\b.*(--force|-f)\b/, why: "force push" },
  { re: /\bgit\s+push\b/, why: "pushing is the user's call, not the agent's" },
  { re: /\bgit\s+reset\s+--hard\b/, why: "destroys uncommitted work" },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, why: "destroys untracked work" },
  { re: /\bgit\s+worktree\s+remove\b/, why: "px owns worktree lifecycle" },
  { re: /\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/, why: "piping a download into a shell" },
  { re: /\b(shutdown|reboot|halt)\b/, why: "host control" },
  { re: /\b(launchctl|systemctl)\b/, why: "service control" },
  { re: /\bdd\s+if=/, why: "raw device write" },
  { re: /\bmkfs(\.|\b)/, why: "filesystem format" },
  { re: /\bchmod\s+(-R\s+)?777\b/, why: "world-writable permissions" },
  { re: />\s*\/dev\/(sd|disk|nvme)/, why: "raw device write" },
];

export function checkCommand(cmd: string): void {
  for (const rule of DENY) {
    if (rule.re.test(cmd)) {
      throw new SafetyError(`refused: ${rule.why}. Command was: ${cmd}`);
    }
  }
}

/**
 * Tool output cap. Large outputs are the second-biggest token sink after the
 * conversation itself, and the middle of a 5,000-line log is almost never what
 * the model needs. Head and tail, with an explicit marker so the model knows
 * material was dropped and can narrow its own command.
 */
export function truncateOutput(text: string, maxLines = 400): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, truncated: false };
  const head = lines.slice(0, Math.floor(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 2));
  const dropped = lines.length - head.length - tail.length;
  return {
    text: [...head, `... [${dropped} lines omitted by px; narrow the command to see them] ...`, ...tail].join("\n"),
    truncated: true,
  };
}
