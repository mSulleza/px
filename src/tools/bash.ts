/**
 * bash — the escape hatch.
 *
 * Named "bash" and nothing else on purpose: across 180 trials the single
 * hallucinated tool name the model ever produced was "bash", so making that the
 * real name turns the one guess it makes into a hit instead of a wasted turn.
 *
 * A non-zero exit is NOT an error here. The model needs to read failing test
 * output, and marking it isError invites a retry of the same command instead of
 * a fix.
 */

import { relative } from "node:path";
import { checkCommand, confinePath, SafetyError, truncateOutput } from "../agent/safety.ts";
import type { ToolContext, ToolDef, ToolOutput } from "../types.ts";

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 600;

export const bashTool: ToolDef = {
  name: "bash",
  description:
    "Run a shell command inside the worktree. Returns exit code, stdout and stderr. " +
    "A non-zero exit is ordinary output, not a tool failure — read it and fix the cause. " +
    `Default timeout ${DEFAULT_TIMEOUT_S}s, max ${MAX_TIMEOUT_S}s. Prefer read/grep/ls over cat/grep/find: they cost fewer tokens.`,
  parameters: {
    type: "object",
    properties: {
      cmd: { type: "string", description: "The command line." },
      cwd: { type: "string", description: "Working directory relative to the worktree root. Default root." },
      timeout_s: { type: "number", description: `Seconds before px kills it. Default ${DEFAULT_TIMEOUT_S}.` },
    },
    required: ["cmd"],
  },
  executionMode: "sequential",
  run: (args, ctx) => bashRun(args, ctx),
};

async function bashRun(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const cmd = typeof args["cmd"] === "string" ? args["cmd"].trim() : "";
  if (!cmd) return { content: "ERROR: bash needs a cmd.", isError: true };

  let cwd: string;
  try {
    checkCommand(cmd);
    cwd = confinePath(ctx.root, typeof args["cwd"] === "string" && args["cwd"] ? args["cwd"] : ".");
  } catch (e) {
    // The refusal is content, never a throw: the model has to see it and adapt.
    return { content: `ERROR: ${e instanceof SafetyError ? e.message : String(e)}`, isError: true };
  }

  const asked = Number(args["timeout_s"] ?? DEFAULT_TIMEOUT_S);
  const timeoutS = Math.min(MAX_TIMEOUT_S, Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_TIMEOUT_S);
  const where = relative(ctx.root, cwd);

  let timedOut = false;
  try {
    // `-c`, never `-lc`: a login shell sources the user's profile, which makes
    // the same command behave differently on two machines.
    const proc = Bun.spawn(["bash", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutS * 1000);

    let out: string;
    let err: string;
    let code: number;
    try {
      [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      code = await proc.exited;
    } finally {
      clearTimeout(timer);
    }

    const header = timedOut
      ? `exit ${code} — TIMED OUT after ${timeoutS}s, px sent SIGKILL${where ? ` (cwd ${where})` : ""}`
      : `exit ${code}${where ? ` (cwd ${where})` : ""}`;

    const body = [header, "--- stdout ---", out.trimEnd() || "(empty)", "--- stderr ---", err.trimEnd() || "(empty)"].join(
      "\n",
    );
    return { content: truncateOutput(body).text };
  } catch (e) {
    return { content: `ERROR: bash could not run the command: ${String(e)}`, isError: true };
  }
}
