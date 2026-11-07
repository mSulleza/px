/**
 * Configuration. Env only, no config-file DSL.
 *
 * Load order: process env wins, then .px/env in the project, then ~/.px/env.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PxConfig {
  apiKey: string;
  /** Per-task ceiling. Default is ~10x the reference session, so it only fires on runaways. */
  budgetUsd: number;
  /**
   * Ceiling across ALL px runs in one UTC day, checked against the ledger.
   *
   * The per-task budget only ever bounds one task. A bill gets large through
   * repetition — an eval sweep, a loop, twenty ordinary runs — so this is the
   * limit that actually protects anything. A normal task costs ~$0.001, so the
   * default is roughly a thousand tasks a day and will only ever fire on
   * something pathological.
   */
  dailyBudgetUsd: number;
  ledgerPath: string;
  worktreeRoot: string;
  /** Hard stop on turns, independent of budget. */
  maxSteps: number;
  /** Compact here, set by the 128,000-token per-request cache-write cap. */
  compactAtTokens: number;
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

export function loadConfig(cwd: string = process.cwd()): PxConfig {
  const home = homedir();
  const merged = {
    ...parseEnvFile(join(home, ".px", "env")),
    ...parseEnvFile(join(cwd, ".px", "env")),
    ...(process.env as Record<string, string>),
  };

  const apiKey = merged["PX_DEEPSEEK_API_KEY"] ?? merged["DEEPSEEK_API_KEY"] ?? "";
  if (!apiKey) {
    throw new Error(
      "No API key. Set PX_DEEPSEEK_API_KEY in ~/.px/env (a dedicated key is strongly preferred: " +
        "a key shared with other tools makes balance reconciliation impossible).",
    );
  }

  return {
    apiKey,
    budgetUsd: Number(merged["PX_BUDGET_USD"] ?? "0.15"),
    dailyBudgetUsd: Number(merged["PX_DAILY_BUDGET_USD"] ?? "1.00"),
    ledgerPath: merged["PX_LEDGER_PATH"] ?? join(home, ".px", "ledger.db"),
    worktreeRoot: merged["PX_WORKTREE_ROOT"] ?? join(home, ".px", "worktrees"),
    maxSteps: Number(merged["PX_MAX_STEPS"] ?? "40"),
    compactAtTokens: Number(merged["PX_COMPACT_AT"] ?? "120000"),
  };
}
