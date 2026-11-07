/**
 * Interactive mode.
 *
 * Same loop, same tools, same worktree — the difference is that a human supplies
 * the next instruction instead of the task running to a verified verdict. There
 * is no correctness guarantee here, and `px run` is the mode that carries one.
 *
 * One session means one cached prefix across the whole conversation, which is
 * why chat is the cheapest way to work: turn 30 pays cache-hit rates on
 * everything said in turns 1 through 29.
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

import { DeepSeekClient } from "../provider/client.ts";
import { Session } from "./session.ts";
import { dispatch } from "./dispatch.ts";
import { Guards } from "./guards.ts";
import { consultTool, makeConsult } from "./consult.ts";
import { buildRegistry } from "../tools/registry.ts";
import { getTodos } from "../tools/todo.ts";
import { createWorktree, gitRoot } from "../worktree/worktree.ts";
import { LANE_E } from "../lanes/policy.ts";
import { assertDailyBudget } from "./loop.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { PxError, type ToolDef } from "../types.ts";
import type { PxConfig } from "../config.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { Ui } from "../ui/render.ts";

export interface ChatOpts {
  cwd: string;
  config: PxConfig;
  ui: Ui;
  ledger: Ledger;
  inPlace?: boolean;
  firstMessage?: string;
}

export async function runChat(opts: ChatOpts): Promise<void> {
  const { ui, config, ledger } = opts;
  const sessionId = randomUUID();
  const taskId = `chat-${sessionId.slice(0, 8)}`;
  const repoRoot = gitRoot(opts.cwd);
  assertDailyBudget(ledger, config.dailyBudgetUsd, ui);

  let root = repoRoot;
  let branch = "(in place)";
  if (!opts.inPlace) {
    const wt = await createWorktree(repoRoot, taskId, config.worktreeRoot);
    root = wt.path;
    branch = wt.branch;
    ui.info(`worktree ${wt.path} on ${wt.branch}`);
  }

  const client = new DeepSeekClient({ apiKey: config.apiKey });
  const tools: ToolDef[] = [...buildRegistry(), consultTool];
  const guards = new Guards({ maxSteps: config.maxSteps, budgetUsd: config.budgetUsd * 20 });

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
    budgetUsd: config.budgetUsd * 20,
    compactAtTokens: config.compactAtTokens,
  });

  const consultFn = makeConsult({ client, ui, onCost: () => {} });
  const ctx = session.toolContext((q, e, d) => consultFn(q, e, d));
  await session.init();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  ui.info("px chat. Ctrl-D to exit, /cost for spend, /diff for the worktree diff.\n");

  let pending = opts.firstMessage;
  try {
    for (;;) {
      let line: string;
      try {
        line = pending ?? (await rl.question("› "));
      } catch {
        break; // Ctrl-D closes stdin, which rejects the pending question. Not an error.
      }
      pending = undefined;
      const text = line.trim();
      if (!text) continue;

      if (text === "/cost") {
        const t = ledger.sessionTotals(sessionId);
        ui.info(
          `$${t.costUsd.toFixed(4)} over ${t.calls} calls, cache hit ${(t.hitRate * 100).toFixed(1)}%`,
        );
        continue;
      }
      if (text === "/diff") {
        const { diff } = await import("../worktree/worktree.ts");
        ui.info((await diff(root)) || "(no changes)");
        continue;
      }
      if (text === "/quit" || text === "/exit") break;

      let userText = text;
      // Run until the model stops calling tools: that is one "turn" to a human.
      for (let step = 0; step < config.maxSteps; step++) {
        const result = await session.call(userText, {
          branch,
          dirtyCount: 0,
          todos: getTodos(),
          notes: [],
        });
        userText = "";
        if (result.toolCalls.length === 0) break;

        guards.recordTurn(result.toolCalls);
        const results = await dispatch(result.toolCalls, tools, ctx, ui);
        for (const r of results) session.appendToolResult(r.toolCallId, r.output.content);

        if (result.toolCalls.some((c) => c.function.name === "finish")) break;
        if (guards.budgetExceeded(session.spentUsd)) {
          ui.warn(`session budget reached at $${session.spentUsd.toFixed(4)}`);
          break;
        }
      }
      ui.info("");
    }
  } catch (e) {
    if (e instanceof PxError) ui.error(`${e.cls}: ${e.message}`);
    else throw e;
  } finally {
    rl.close();
    const t = ledger.sessionTotals(sessionId);
    ui.info(
      `\nsession: $${t.costUsd.toFixed(4)}, ${t.calls} calls, cache hit ${(t.hitRate * 100).toFixed(1)}%` +
        (branch === "(in place)" ? "" : `\nwork is on branch ${branch} — land it with: px land ${branch}`),
    );
  }
}
