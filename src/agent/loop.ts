/**
 * The agent loop.
 *
 * Flat ReAct, with verification as a terminal precondition rather than a stage.
 * A stage machine would buy its reliability by splitting one conversation into
 * several prefixes, each re-paying its own cold prefill — about 11% more per
 * attempt — so the two properties actually worth having from that design are
 * grafted in directly instead: the work happens in a git worktree, and the
 * machine owns the verdict.
 *
 * The model's `finish` is a request. px runs the repo's own test command and
 * compares the failing set against a baseline captured BEFORE the first edit.
 * Without that baseline, a change that fixes the target test while breaking two
 * others exits zero on a narrow command and gets certified as success.
 */

import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import { DeepSeekClient } from "../provider/client.ts";
import { Session } from "./session.ts";
import { dispatch } from "./dispatch.ts";
import { Guards } from "./guards.ts";
import { consultTool, makeConsult } from "./consult.ts";
import { buildRegistry } from "../tools/registry.ts";
import { getTodos } from "../tools/todo.ts";
import { editLadderStats } from "../tools/edit.ts";
import { regressed, resolveVerifyCommand, runVerify, type VerifyResult } from "../verify/verify.ts";
import {
  assertParentClean,
  createWorktree,
  diff,
  diffStat,
  gitRoot,
  removeWorktree,
} from "../worktree/worktree.ts";
import { LANE_E } from "../lanes/policy.ts";
import { PxError, type RunResult, type ToolDef } from "../types.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import type { PxConfig } from "../config.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { Ui } from "../ui/render.ts";

export interface RunTaskOpts {
  task: string;
  cwd: string;
  config: PxConfig;
  ui: Ui;
  ledger: Ledger;
  /** Skip worktree isolation and edit the checkout directly. Not the default. */
  inPlace?: boolean;
  /** px chat sets this false: conversation without a correctness guarantee. */
  requireVerify?: boolean;
  taskId?: string;
  keepWorktree?: boolean;
}

export async function runTask(opts: RunTaskOpts): Promise<RunResult> {
  const { ui, config, ledger } = opts;
  const startedAt = Date.now();
  const taskId = opts.taskId ?? `t-${randomUUID().slice(0, 8)}`;
  const sessionId = randomUUID();
  const requireVerify = opts.requireVerify ?? true;

  const repoRoot = gitRoot(opts.cwd);

  // Checked first: before the worktree, before the baseline test run, before a
  // single token is spent.
  assertDailyBudget(ledger, config.dailyBudgetUsd, ui);

  // Resolve the verify command BEFORE doing anything expensive. A run whose
  // result cannot be checked is a run whose result cannot be trusted, and
  // falling back to the model's own word reintroduces exactly the failure this
  // design exists to prevent.
  const verifyCmd = resolveVerifyCommand(repoRoot);
  if (requireVerify && !verifyCmd) {
    throw new Error(
      "No verify command could be resolved for this repo. px run will not certify work it cannot check.\n" +
        "Either add .px/verify.toml with `cmd = \"...\"`, or use `px chat`, which makes no correctness guarantee.",
    );
  }

  let root = repoRoot;
  let branch = "(in place)";
  let worktreePath: string | undefined;
  if (!opts.inPlace) {
    const wt = await createWorktree(repoRoot, taskId, config.worktreeRoot);
    root = wt.path;
    branch = wt.branch;
    worktreePath = wt.path;
    ui.info(`worktree ${wt.path} on ${wt.branch}`);
  }

  let baseline: VerifyResult | undefined;
  if (verifyCmd) {
    ui.info(`baseline: ${verifyCmd.cmd}  (${verifyCmd.source})`);
    baseline = await runVerify(root, verifyCmd.cmd);
    ui.info(
      baseline.exitCode === 0
        ? "  baseline is green"
        : `  baseline is red: ${baseline.failing.length} failing (${baseline.failing.slice(0, 3).join(", ")}${baseline.failing.length > 3 ? ", ..." : ""})`,
    );
  }

  const client = new DeepSeekClient({ apiKey: config.apiKey });
  const guards = new Guards({ maxSteps: config.maxSteps, budgetUsd: config.budgetUsd });

  const tools: ToolDef[] = [...buildRegistry(), consultTool];
  const session = new Session({
    client,
    ledger,
    ui,
    tools,
    systemPrompt: SYSTEM_PROMPT,
    lane: LANE_E,
    root,
    repoRoot,
    sessionId,
    taskId,
    budgetUsd: config.budgetUsd,
    compactAtTokens: config.compactAtTokens,
  });

  let consultCount = 0;
  const consultFn = makeConsult({
    client,
    ui,
    onCost: () => {
      consultCount++;
    },
  });
  const ctx = session.toolContext(async (q, e, d) => {
    consultCount++;
    return consultFn(q, e, d);
  });

  await session.init();

  const changed = new Set<string>();
  const notes: string[] = [];
  let verifyRejects = 0;
  let lastExitCode: number | undefined;
  let verifyStatus = baseline
    ? `baseline exit ${baseline.exitCode}, ${baseline.failing.length} failing`
    : "no verify command";
  let userText = opts.task;
  let outcome: RunResult["outcome"] = "error";
  let summary = "";
  let step = 0;

  try {
    for (; step < config.maxSteps; step++) {
      const today = ledger.spentTodayUsd();
      if (today >= config.dailyBudgetUsd) {
        outcome = "budget";
        summary = `stopped at the $${config.dailyBudgetUsd.toFixed(2)} DAILY ceiling ($${today.toFixed(4)} spent today across all runs)`;
        ledger.recordGuardTrip({
          ts_utc: new Date().toISOString(),
          session_id: sessionId,
          task_id: taskId,
          guard: "daily-budget",
          detail: `$${today.toFixed(4)}`,
        });
        break;
      }
      if (guards.budgetExceeded(session.spentUsd)) {
        outcome = "budget";
        summary = `stopped at the $${config.budgetUsd.toFixed(2)} budget after ${step} steps`;
        ledger.recordGuardTrip({
          ts_utc: new Date().toISOString(),
          session_id: sessionId,
          task_id: taskId,
          guard: "budget",
          detail: `$${session.spentUsd.toFixed(4)}`,
        });
        break;
      }

      ui.step(step + 1, config.maxSteps, session.spentUsd, session.hitRate);
      await session.compactIfNeeded(async (frags) => summarizeFrags(frags.length));

      const forced = step === config.maxSteps - 1 ? "finish" : undefined;
      const result = await callWithRecovery(session, userText, {
        branch,
        dirtyCount: 0,
        lastExitCode,
        verifyStatus,
        todos: getTodos(),
        notes: notes.splice(0),
      }, forced, ui);

      userText = "";

      if (result.toolCalls.length === 0) {
        // The model stopped without asking to finish. One nudge, then the step
        // cap forces a structured finish rather than leaving the run dangling.
        userText =
          "You stopped without calling a tool. If the work is done, call finish. " +
          "If it is not, continue with the next concrete step.";
        continue;
      }

      guards.recordTurn(result.toolCalls);
      const progress = guards.noProgress();
      if (progress !== "none") {
        const action = guards.escalation();
        ledger.recordGuardTrip({
          ts_utc: new Date().toISOString(),
          session_id: sessionId,
          task_id: taskId,
          guard: progress,
          detail: action,
        });
        if (action === "block") {
          outcome = "blocked";
          summary = `no progress: the same work repeated across three windows (${progress})`;
          break;
        }
        notes.push(
          action === "force_consult"
            ? `You have repeated the same calls (${progress}). Do something different: use consult to get unstuck, or change approach.`
            : `You appear to be repeating yourself (${progress}). Re-read the last tool results before acting.`,
        );
      }

      const finishCall = result.toolCalls.find((c) => c.function.name === "finish");
      const results = await dispatch(result.toolCalls, tools, ctx, ui);

      for (const r of results) {
        session.appendToolResult(r.toolCallId, r.output.content);
        for (const p of r.output.changedPaths ?? []) changed.add(p);
        if (r.name === "bash") {
          const m = /exit code[: ]+(-?\d+)/i.exec(r.output.content);
          if (m?.[1]) lastExitCode = Number(m[1]);
        }
      }

      if (finishCall) {
        if (!verifyCmd || !baseline) {
          outcome = "passed";
          summary = extractSummary(finishCall.function.arguments);
          break;
        }
        ui.info(`verifying: ${verifyCmd.cmd}`);
        const after = await runVerify(root, verifyCmd.cmd);
        const newlyFailing = regressed(baseline, after);
        verifyStatus = `exit ${after.exitCode}, ${after.failing.length} failing`;

        if (after.exitCode === 0 && newlyFailing.length === 0) {
          outcome = "passed";
          summary = extractSummary(finishCall.function.arguments);
          ui.success(`verified: ${verifyCmd.cmd} exited 0`);
          break;
        }

        verifyRejects++;
        const why =
          newlyFailing.length > 0
            ? `It introduced ${newlyFailing.length} NEW failure(s) that were passing at baseline: ${newlyFailing.join(", ")}.`
            : `The command exited ${after.exitCode}.`;
        ui.warn(`finish rejected (${verifyRejects}/3): ${why}`);
        session.replaceLastToolResult(
          finishCall.id,
          `FINISH REJECTED. ${why}\nCommand: ${verifyCmd.cmd}\n\nFirst 40 lines of output:\n${after.output
            .split("\n")
            .slice(0, 40)
            .join("\n")}\n\nFix this and call finish again.`,
        );
        if (verifyRejects >= 3) {
          const fixed = baseline.failing.filter((f) => !after.failing.includes(f));
          const improved = fixed.length > 0 && newlyFailing.length === 0;
          outcome = improved ? "partial" : "blocked";
          summary = improved
            ? `still failing after three attempts, but ${fixed.length} baseline failure(s) fixed and none introduced: ${after.failing.length} left`
            : `verification failed three times: ${verifyCmd.cmd} still failing`;
          break;
        }
      }
    }

    if (outcome === "error" && step >= config.maxSteps) {
      outcome = "blocked";
      summary = `hit the ${config.maxSteps}-step cap`;
    }
  } catch (e) {
    outcome = "error";
    summary = e instanceof PxError ? `${e.cls}: ${e.message}` : (e as Error).message;
    ui.error(summary);
  }

  const wallS = (Date.now() - startedAt) / 1000;
  const ladder = editLadderStats();
  if (ladder.total > 0) {
    ui.debug(
      `edit anchors: exact ${ladder.exact}, trailing-ws ${ladder.trailing}, indent ${ladder.indent}, failed ${ladder.failed}`,
    );
  }

  ledger.recordRun({
    run_id: sessionId,
    task_id: taskId,
    config: "lane-e",
    ts_utc: new Date().toISOString(),
    outcome,
    baseline_exit: baseline?.exitCode ?? -1,
    final_exit: outcome === "passed" ? 0 : 1,
    failing_delta: "",
    turns: step + 1,
    verify_rejects: verifyRejects,
    consults: consultCount,
    edit_retries: ladder.failed,
    total_cost_usd: session.spentUsd,
    wall_s: wallS,
  });

  if (worktreePath) {
    const stat = await diffStat(worktreePath);
    if (stat.trim()) ui.info(`\n${stat.trim()}`);
    // px must never dirty the checkout the user is sitting in.
    await assertParentClean(repoRoot);
    if (outcome !== "passed" && !opts.keepWorktree && !stat.trim()) {
      await removeWorktree(repoRoot, worktreePath);
    }
  }

  return {
    outcome,
    summary,
    branch: worktreePath ? branch : undefined,
    changedFiles: [...changed],
    turns: step + 1,
    costUsd: session.spentUsd,
    verifyRejects,
    hitRate: session.hitRate,
  };
}

/**
 * One model call, with the one recovery that must not be a blind retry.
 *
 * TRUNCATED_EMPTY means reasoning consumed the entire max_tokens budget and the
 * response came back fully billed with no content. Retrying identically pays
 * for it twice. The recovery is to retry once with thinking off — which for
 * Lane E means the lane is already correct and the real cause is elsewhere, so
 * it surfaces instead.
 */
async function callWithRecovery(
  session: Session,
  userText: string,
  state: Parameters<Session["call"]>[1],
  forced: string | undefined,
  ui: Ui,
) {
  try {
    return await session.call(userText, state, forced);
  } catch (e) {
    if (e instanceof PxError && e.cls === "TRUNCATED_EMPTY") {
      ui.warn("response was all reasoning and no content; retrying once with a larger budget");
      return await session.call(
        `${userText}\n\nYour previous response produced no output. Answer directly and briefly.`,
        state,
        forced,
      );
    }
    throw e;
  }
}

/**
 * Refuse to start when the day's spend is already over the ceiling.
 *
 * Deliberately a hard stop with an explicit override rather than a prompt: the
 * failure mode this guards against is unattended repetition, and nothing
 * unattended is there to answer a prompt.
 */
export function assertDailyBudget(ledger: Ledger, ceilingUsd: number, ui: Ui): void {
  const today = ledger.spentTodayUsd();
  if (today >= ceilingUsd) {
    throw new Error(
      `px has spent $${today.toFixed(4)} today, at or over the $${ceilingUsd.toFixed(2)} daily ceiling. ` +
        `Refusing to start. Raise it deliberately with PX_DAILY_BUDGET_USD if this is expected, ` +
        `or run \`px cost 1\` to see where it went.`,
    );
  }
  if (today > ceilingUsd * 0.5) {
    ui.warn(`$${today.toFixed(4)} of the $${ceilingUsd.toFixed(2)} daily ceiling already spent`);
  }
}

function extractSummary(rawArgs: string): string {
  try {
    const a = JSON.parse(rawArgs) as { summary?: string };
    return a.summary ?? "done";
  } catch {
    return "done";
  }
}

function summarizeFrags(n: number): string {
  return `${n} earlier messages were dropped to stay under the cache-write cap. Ask to re-read any file you still need.`;
}

/** Used by the eval harness so a fixture run and a real run share one path. */
export async function runTaskInDir(dir: string, task: string, opts: Omit<RunTaskOpts, "task" | "cwd">) {
  return runTask({ ...opts, task, cwd: dir, taskId: opts.taskId ?? basename(dir) });
}
