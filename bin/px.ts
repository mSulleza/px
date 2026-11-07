#!/usr/bin/env bun
/**
 * px CLI.
 *
 *   px run "<task>"     work to a verified verdict in a fresh worktree
 *   px chat             interactive session, same tools, no verdict
 *   px land <branch>    fast-forward a finished worktree branch into the checkout
 *   px cost [days]      what px has spent, by day, lane and cache tier
 *   px doctor           probe the live API against every assumption px encodes
 *   px eval [args]      run the golden-task regression suite
 */

import { loadConfig } from "../src/config.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { Ui } from "../src/ui/render.ts";
import { runTask } from "../src/agent/loop.ts";
import { runChat } from "../src/agent/chat.ts";
import { gitRoot, land } from "../src/worktree/worktree.ts";
import { isPeak, localTime, nextOffPeak } from "../src/schedule/offpeak.ts";

const HELP = `px — a DeepSeek-native coding agent

  px run "<task>"        Work until the repo's own tests pass. Isolated in a git
                         worktree; the harness, not the model, decides success.
  px chat [message]      Interactive session in a worktree. No correctness guarantee.
  px land <branch>       git merge --ff-only a finished px branch.
  px cost [days=7]       Spend, cache-hit rate and peak/off-peak split.
  px spend               Account balance across ALL consumers of the key, plus
                         today's px spend and the daily ceiling.
  px doctor              Live contract probe against api.deepseek.com.
  px eval [--tasks ...]  Golden-task regression suite.

Flags
  --in-place             Edit the current checkout instead of a worktree.
  --budget-day <usd>     Ceiling across ALL runs today (default PX_DAILY_BUDGET_USD, else 1.00).
  --keep                 Keep the worktree even when the run fails.
  --budget <usd>         Per-task ceiling (default from PX_BUDGET_USD, else 0.15).
  --quiet / --verbose

Pricing note: DeepSeek charges 2x Mon-Fri 01:00-04:00 and 06:00-10:00 UTC,
which is 09:00-12:00 and 14:00-18:00 in UTC+8. Deferrable work is half price.`;

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function value(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }

  const ui = new Ui({ quiet: flag(argv, "quiet"), verbose: flag(argv, "verbose") });

  if (cmd === "doctor") {
    const { runDoctor, formatChecks } = await import("../scripts/doctor.ts");
    const config = loadConfig();
    const { checks, ok } = await runDoctor(config.apiKey);
    console.log(formatChecks(checks));
    return ok ? 0 : 1;
  }

  if (cmd === "spend") {
    const { runSpend } = await import("../scripts/spend.ts");
    return await runSpend();
  }

  if (cmd === "eval") {
    const { main: evalMain } = await import("../eval/run.ts");
    return (await evalMain(argv.slice(1))) ?? 0;
  }

  const config = loadConfig();
  const budgetOverride = value(argv, "budget");
  if (budgetOverride) config.budgetUsd = Number(budgetOverride);
  const dailyOverride = value(argv, "budget-day");
  if (dailyOverride) config.dailyBudgetUsd = Number(dailyOverride);
  const ledger = new Ledger(config.ledgerPath);

  try {
    switch (cmd) {
      case "run": {
        const task = argv.slice(1).filter((a) => !a.startsWith("--")).join(" ");
        if (!task) {
          ui.error('px run needs a task: px run "make the failing auth test pass"');
          return 2;
        }
        const now = new Date();
        if (isPeak(now)) {
          ui.warn(
            `peak pricing (2x) until ${nextOffPeak(now).toISOString().slice(11, 16)} UTC — it is ${localTime(now)} local time`,
          );
        }
        const r = await runTask({
          task,
          cwd: process.cwd(),
          config,
          ui,
          ledger,
          inPlace: flag(argv, "in-place"),
          keepWorktree: flag(argv, "keep"),
        });
        ui.heading(`\n${r.outcome}: ${r.summary}`);
        ui.info(
          `${r.turns} turns, $${r.costUsd.toFixed(4)}, cache hit ${(r.hitRate * 100).toFixed(1)}%` +
            (r.verifyRejects ? `, ${r.verifyRejects} rejected finish(es)` : ""),
        );
        if (r.branch && r.outcome === "passed") ui.info(`land it with: px land ${r.branch}`);
        return r.outcome === "passed" ? 0 : 1;
      }

      case "chat": {
        await runChat({
          cwd: process.cwd(),
          config,
          ui,
          ledger,
          inPlace: flag(argv, "in-place"),
          firstMessage: argv.slice(1).filter((a) => !a.startsWith("--")).join(" ") || undefined,
        });
        return 0;
      }

      case "land": {
        const branch = argv[1];
        if (!branch) {
          ui.error("px land needs a branch name");
          return 2;
        }
        const res = await land(gitRoot(process.cwd()), branch);
        (res.merged ? ui.success : ui.error).call(ui, res.message);
        return res.merged ? 0 : 1;
      }

      case "cost": {
        const days = Number(argv[1] ?? "7");
        const { formatSummary } = await import("../src/ledger/ledger.ts");
        console.log(formatSummary(ledger.summary(days)));
        return 0;
      }

      default:
        ui.error(`unknown command "${cmd}"`);
        console.log(HELP);
        return 2;
    }
  } finally {
    ledger.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`px: ${e?.message ?? e}`);
    process.exit(1);
  });
