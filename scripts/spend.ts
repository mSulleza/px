#!/usr/bin/env bun
/**
 * `px spend` — one place to see what DeepSeek is actually costing, across every
 * consumer, not just px.
 *
 * px's own ledger is exact but it only sees px. The account balance sees
 * everything — px, dsh, the LiteLLM gateway, and any script or agent holding
 * the same key — which is precisely how a bill grows without any single tool
 * looking expensive. The balance settles on a 2-3 minute delay, so treat it as
 * a reconciliation oracle rather than a live meter.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { loadConfig } from "../src/config.ts";

interface Snapshot {
  ts: string;
  balance: number;
}

const SNAP_PATH = join(homedir(), ".px", "balance-history.json");

async function fetchBalance(apiKey: string): Promise<number | null> {
  try {
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { balance_infos?: { total_balance?: string }[] };
    const raw = j.balance_infos?.[0]?.total_balance;
    return raw === undefined ? null : Number(raw);
  } catch {
    return null;
  }
}

function readSnapshots(): Snapshot[] {
  if (!existsSync(SNAP_PATH)) return [];
  try {
    return JSON.parse(readFileSync(SNAP_PATH, "utf8")) as Snapshot[];
  } catch {
    return [];
  }
}

function writeSnapshot(balance: number): Snapshot[] {
  const all = readSnapshots();
  all.push({ ts: new Date().toISOString(), balance });
  // 400 snapshots is over a year of daily runs; the file stays a few KB.
  const trimmed = all.slice(-400);
  mkdirSync(dirname(SNAP_PATH), { recursive: true });
  writeFileSync(SNAP_PATH, JSON.stringify(trimmed, null, 2));
  return trimmed;
}

/**
 * Not opened readonly: bun:sqlite cannot open a WAL database readonly (it needs
 * to touch -shm), and the first version of this silently caught that and
 * reported $0.00 — the single worst failure mode a spend tool can have. Errors
 * here are surfaced, never swallowed.
 */
function ledgerToday(path: string): { usd: number; calls: number } {
  if (!existsSync(path)) return { usd: 0, calls: 0 };
  const db = new Database(path);
  try {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const r = db
      .query<{ usd: number; calls: number }, { $since: string }>(
        "SELECT COALESCE(SUM(cost_usd),0.0) AS usd, COUNT(*) AS calls FROM calls WHERE ts_utc >= $since",
      )
      .get({ $since: since.toISOString() });
    return { usd: r?.usd ?? 0, calls: r?.calls ?? 0 };
  } finally {
    db.close();
  }
}

function gatewayToday(): number {
  const p = join(homedir(), "litellm", "usage.db");
  if (!existsSync(p)) return 0;
  const db = new Database(p);
  try {
    const r = db
      .query<{ usd: number }, []>("SELECT COALESCE(SUM(cost),0.0) AS usd FROM usage WHERE ts > date('now')")
      .get();
    return r?.usd ?? 0;
  } finally {
    db.close();
  }
}

export async function runSpend(): Promise<number> {
  const config = loadConfig();
  const balance = await fetchBalance(config.apiKey);
  // A failure to read either database must be loud. Reporting zero spend
  // because a file would not open is how a budget tool becomes a liability.
  let px: { usd: number; calls: number };
  try {
    px = ledgerToday(config.ledgerPath);
  } catch (e) {
    throw new Error(`could not read the px ledger at ${config.ledgerPath}: ${(e as Error).message}`);
  }
  let gw = 0;
  try {
    gw = gatewayToday();
  } catch (e) {
    console.warn(`  ! could not read the litellm gateway db: ${(e as Error).message}`);
  }

  const lines: string[] = [];
  lines.push("px spend");
  lines.push("");

  if (balance === null) {
    lines.push("  account balance   unavailable (could not reach /user/balance)");
  } else {
    const history = writeSnapshot(balance);
    lines.push(`  account balance   $${balance.toFixed(2)}`);

    const today = new Date().toISOString().slice(0, 10);
    const firstToday = history.find((s) => s.ts.slice(0, 10) === today);
    if (firstToday && firstToday.balance > balance) {
      lines.push(
        `  burned today      $${(firstToday.balance - balance).toFixed(2)}  (since the first check at ${firstToday.ts.slice(11, 16)} UTC)`,
      );
    }
    const prev = history.at(-2);
    if (prev && prev.balance > balance) {
      lines.push(
        `  since last check  $${(prev.balance - balance).toFixed(2)}  (${prev.ts.slice(0, 16).replace("T", " ")} UTC)`,
      );
    }
  }

  lines.push("");
  lines.push(`  px runs today     $${px.usd.toFixed(4)} over ${px.calls} calls`);
  lines.push(`  litellm gateway   $${gw.toFixed(4)}`);
  lines.push(`  px daily ceiling  $${config.dailyBudgetUsd.toFixed(2)}  (PX_DAILY_BUDGET_USD)`);
  lines.push("");
  lines.push(
    "  The balance covers EVERY consumer of this key — px, dsh, the gateway, and",
  );
  lines.push(
    "  any script or agent holding it. A gap between the balance delta and the px",
  );
  lines.push("  figure above is spend px did not make and cannot cap.");

  console.log(lines.join("\n"));
  return 0;
}

if (import.meta.main) {
  runSpend()
    .then((c) => process.exit(c))
    .catch((e) => {
      console.error(`px spend: ${e?.message ?? e}`);
      process.exit(1);
    });
}
