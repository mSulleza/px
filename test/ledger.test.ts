/**
 * Ledger tests.
 *
 * The arithmetic assertions here are exact, not approximate, on purpose. This
 * table is the only evidence px has that its cache claims are true, so a
 * rounding-tolerant test of the very numbers being claimed would defeat the
 * point of writing them down.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Ledger, MISS_TOLERANCE_TOK, expectedMiss, formatSummary, type CallRow } from "../src/ledger/ledger.ts";
import { predictedHit } from "../src/provider/models.ts";

let dir: string;
let dbPath: string;
let led: Ledger;

beforeEach(() => {
  // A fresh directory per test also exercises the constructor's mkdir -p.
  dir = mkdtempSync("/private/tmp/px-ledger-");
  dbPath = join(dir, "nested", "ledger.db");
  led = new Ledger(dbPath);
});

afterEach(() => {
  led.close();
  rmSync(dir, { recursive: true, force: true });
});

const BASE: CallRow = {
  ts_utc: "2026-09-11T02:00:00.000Z",
  session_id: "s1",
  task_id: "t1",
  lane: "E",
  model_requested: "deepseek-flash",
  model_echoed: "deepseek-flash",
  hit_tok: 0,
  miss_tok: 0,
  out_tok: 0,
  reasoning_tok: 0,
  peak: 0,
  cost_usd: 0,
  prefix_sha: "abc123",
  finish_reason: "stop",
  error_class: null,
  ttfb_ms: 100,
  wall_ms: 200,
  n_tool_calls: 1,
};

function call(over: Partial<CallRow>): CallRow {
  return { ...BASE, ...over };
}

/** A day-aligned UTC timestamp `back` days ago, so window tests do not expire. */
function dayIso(back: number, hour = 12): string {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString();
}

describe("schema", () => {
  test("applies twice without error and keeps the rows", () => {
    led.recordCall(call({ hit_tok: 100, miss_tok: 200, cost_usd: 0.5 }));
    led.close();

    // Reopening runs the whole DDL again against a populated database.
    led = new Ledger(dbPath);
    led.recordCall(call({ hit_tok: 300, miss_tok: 400, cost_usd: 0.25 }));

    const t = led.sessionTotals("s1");
    expect(t.calls).toBe(2);
    expect(t.hitTok).toBe(400);
    expect(t.missTok).toBe(600);
    expect(t.costUsd).toBe(0.75);
  });

  test("a second Ledger on the same file sees the first one's rows", () => {
    led.recordCall(call({ hit_tok: 1, miss_tok: 1 }));
    const other = new Ledger(dbPath);
    expect(other.sessionTotals("s1").calls).toBe(1);
    other.close();
  });
});

describe("sessionTotals", () => {
  test("sums and divides exactly", () => {
    // Costs chosen to be exact in binary floating point: the ledger must not
    // be the thing that introduces error into a number it exists to prove.
    led.recordCall(call({ hit_tok: 0, miss_tok: 1000, out_tok: 100, cost_usd: 0.5 }));
    led.recordCall(call({ hit_tok: 896, miss_tok: 200, out_tok: 50, cost_usd: 0.25 }));
    led.recordCall(call({ hit_tok: 1024, miss_tok: 300, out_tok: 25, cost_usd: 0.125 }));

    const t = led.sessionTotals("s1");
    expect(t.calls).toBe(3);
    expect(t.hitTok).toBe(1920);
    expect(t.missTok).toBe(1500);
    expect(t.outTok).toBe(175);
    expect(t.costUsd).toBe(0.875);
    expect(t.hitRate).toBe(1920 / 3420);
  });

  test("is scoped to one session", () => {
    led.recordCall(call({ session_id: "a", hit_tok: 10, miss_tok: 10, cost_usd: 1 }));
    led.recordCall(call({ session_id: "b", hit_tok: 90, miss_tok: 10, cost_usd: 2 }));
    expect(led.sessionTotals("a").costUsd).toBe(1);
    expect(led.sessionTotals("b").hitRate).toBe(0.9);
  });

  test("an unknown session is zeroes, not NaN", () => {
    const t = led.sessionTotals("nobody");
    expect(t.calls).toBe(0);
    expect(t.costUsd).toBe(0);
    expect(t.hitRate).toBe(0);
    expect(Number.isNaN(t.hitRate)).toBe(false);
  });
});

describe("expectedMiss", () => {
  test("no predecessor means the whole prompt is a miss", () => {
    expect(expectedMiss("deepseek-flash", 5000, undefined)).toBe(5000);
  });

  test("follows the measured quantum, including flash's floor penalty", () => {
    // 128*floor(5000/128) - 128 = 4864 cacheable, so 5200 - 4864 = 336 new.
    expect(predictedHit("deepseek-flash", 5000)).toBe(4864);
    expect(expectedMiss("deepseek-flash", 5200, 5000)).toBe(336);
    // pro has no floor penalty, so one quantum more is expected to hit.
    expect(expectedMiss("deepseek-v4-pro", 5200, 5000)).toBe(208);
  });

  test("a shrinking prompt is a compaction, and re-prefill is expected", () => {
    expect(expectedMiss("deepseek-flash", 6000, 20000)).toBe(6000);
  });
});

describe("anomalies", () => {
  /** A clean telescoping chain: each turn's miss is just the new tail. */
  function goodChain(session: string, lane = "E"): void {
    led.recordCall(call({ session_id: session, lane, hit_tok: 0, miss_tok: 5000 }));
    led.recordCall(call({ session_id: session, lane, hit_tok: 4864, miss_tok: 336 }));
    led.recordCall(call({ session_id: session, lane, hit_tok: 4992, miss_tok: 608 }));
  }

  test("a byte-stable session produces none", () => {
    goodChain("s-good");
    expect(led.anomalies("s-good")).toEqual([]);
  });

  test("flags the broken turn and prices it, leaving the good ones alone", () => {
    led.recordCall(call({ session_id: "s-bad", hit_tok: 0, miss_tok: 5000 }));
    // Turn 2: prompt is still 5200, but the prefix broke and only 128 tokens
    // hit. Nothing in the API response says so; only this column does.
    led.recordCall(call({ session_id: "s-bad", hit_tok: 128, miss_tok: 5072 }));
    led.recordCall(call({ session_id: "s-bad", hit_tok: 4992, miss_tok: 608 }));

    const found = led.anomalies("s-bad");
    expect(found.length).toBe(1);
    const a = found[0]!;
    expect(a.missTok).toBe(5072);
    expect(a.expectedMissTok).toBe(336);
    expect(a.excessTok).toBe(4736);
    // 4736 tokens billed at miss rate that should have been hits:
    // 4736 * ($0.15 - $0.003)/M, off-peak.
    expect(a.excessUsd).toBeCloseTo((4736 * (0.15 - 0.003)) / 1_000_000, 10);
    expect(a.prefixSha).toBe("abc123");
  });

  test("doubles the damage inside the peak window", () => {
    led.recordCall(call({ session_id: "s-peak", hit_tok: 0, miss_tok: 5000, peak: 1 }));
    led.recordCall(call({ session_id: "s-peak", hit_tok: 128, miss_tok: 5072, peak: 1 }));
    const a = led.anomalies("s-peak")[0]!;
    expect(a.excessUsd).toBeCloseTo((2 * (4736 * (0.15 - 0.003))) / 1_000_000, 10);
  });

  test("tolerates drift up to the quantum allowance and flags one token past it", () => {
    led.recordCall(call({ session_id: "s-edge", hit_tok: 0, miss_tok: 5000 }));
    // expected miss is 336; 336 + 256 is still clean.
    led.recordCall(call({ session_id: "s-edge", hit_tok: 4864 - MISS_TOLERANCE_TOK, miss_tok: 336 + MISS_TOLERANCE_TOK }));
    expect(led.anomalies("s-edge")).toEqual([]);

    led.recordCall(call({ session_id: "s-edge2", hit_tok: 0, miss_tok: 5000 }));
    led.recordCall(
      call({ session_id: "s-edge2", hit_tok: 4864 - MISS_TOLERANCE_TOK - 1, miss_tok: 336 + MISS_TOLERANCE_TOK + 1 }),
    );
    expect(led.anomalies("s-edge2").length).toBe(1);
  });

  test("a consult on another lane neither inherits nor breaks the loop lineage", () => {
    led.recordCall(call({ session_id: "s-mix", lane: "E", hit_tok: 0, miss_tok: 5000 }));
    // Lane R is an ephemeral side conversation on its own cache namespace:
    // all-miss is correct for it, and it must not be judged against Lane E.
    led.recordCall(call({ session_id: "s-mix", lane: "R", hit_tok: 0, miss_tok: 800 }));
    // Lane E resumes and still telescopes off its own last turn.
    led.recordCall(call({ session_id: "s-mix", lane: "E", hit_tok: 4864, miss_tok: 336 }));
    expect(led.anomalies("s-mix")).toEqual([]);
  });

  test("a compaction is not an anomaly", () => {
    led.recordCall(call({ session_id: "s-compact", hit_tok: 0, miss_tok: 20000 }));
    led.recordCall(call({ session_id: "s-compact", hit_tok: 0, miss_tok: 6000 }));
    led.recordCall(call({ session_id: "s-compact", hit_tok: 5760, miss_tok: 440 }));
    expect(led.anomalies("s-compact")).toEqual([]);
  });

  test("the caller's expected_miss_tok is ignored in favour of the ledger's own", () => {
    led.recordCall(call({ session_id: "s-own", hit_tok: 0, miss_tok: 5000, expected_miss_tok: 999_999 }));
    const receipt = led.recordCall(
      call({ session_id: "s-own", hit_tok: 4864, miss_tok: 336, expected_miss_tok: 999_999 }),
    );
    expect(receipt.expectedMissTok).toBe(336);
    expect(receipt.excessTok).toBe(0);
    expect(receipt.anomalous).toBe(false);
    expect(led.recent(1)[0]!.expectedMissTok).toBe(336);
  });

  test("the receipt reports the break at write time", () => {
    led.recordCall(call({ session_id: "s-live", hit_tok: 0, miss_tok: 5000 }));
    const r = led.recordCall(call({ session_id: "s-live", hit_tok: 128, miss_tok: 5072 }));
    expect(r.id).toBeGreaterThan(0);
    expect(r.anomalous).toBe(true);
    expect(r.excessTok).toBe(4736);
  });
});

describe("recent", () => {
  test("returns newest first with peak decoded", () => {
    led.recordCall(call({ task_id: "first", hit_tok: 1, miss_tok: 1 }));
    led.recordCall(call({ task_id: "second", hit_tok: 2, miss_tok: 2, peak: 1, error_class: "RATE_LIMIT" }));

    const rows = led.recent(10);
    expect(rows.map((r) => r.taskId)).toEqual(["second", "first"]);
    expect(rows[0]!.peak).toBe(true);
    expect(rows[1]!.peak).toBe(false);
    expect(rows[0]!.errorClass).toBe("RATE_LIMIT");
    expect(rows[1]!.errorClass).toBe(null);
    expect(led.recent(1).length).toBe(1);
  });

  test("a caller-chosen row count is capped and a nonsense one falls back", () => {
    for (let i = 0; i < 3; i++) led.recordCall(call({ hit_tok: i, miss_tok: i }));
    // The cap is what keeps `recent` from being a query whose result size is
    // chosen by its argument. Below the cap nothing changes.
    expect(led.recent(1e12).length).toBe(3);
    expect(led.recent(Number.POSITIVE_INFINITY).length).toBe(3);
    expect(led.recent(2).length).toBe(2);
  });
});

describe("summary", () => {
  function seed(): void {
    led.recordCall(call({ ts_utc: dayIso(0), lane: "E", hit_tok: 900, miss_tok: 100, out_tok: 10, cost_usd: 0.5 }));
    led.recordCall(
      call({ ts_utc: dayIso(0), lane: "R", hit_tok: 0, miss_tok: 400, out_tok: 90, cost_usd: 0.25, peak: 1, reasoning_tok: 700 }),
    );
    led.recordCall(call({ ts_utc: dayIso(1), lane: "E", hit_tok: 700, miss_tok: 300, out_tok: 40, cost_usd: 0.125 }));
    // Outside a 7-day window; must not appear anywhere in the summary.
    led.recordCall(call({ ts_utc: dayIso(30), lane: "E", hit_tok: 5, miss_tok: 5, cost_usd: 64 }));
  }

  test("buckets by UTC day and by lane, and honours the window", () => {
    seed();
    const s = led.summary(7);

    expect(s.byDay.map((b) => b.key)).toEqual([dayIso(1).slice(0, 10), dayIso(0).slice(0, 10)]);
    expect(s.byDay[1]!.calls).toBe(2);
    expect(s.byDay[1]!.costUsd).toBe(0.75);
    expect(s.byDay[1]!.hitRate).toBe(900 / 1400);

    const laneE = s.byLane.find((b) => b.key === "E")!;
    expect(laneE.calls).toBe(2);
    expect(laneE.costUsd).toBe(0.625);
    expect(laneE.hitRate).toBe(1600 / 2000);

    expect(s.totals.calls).toBe(3);
    expect(s.totals.costUsd).toBe(0.875);
    expect(s.totals.hitTok).toBe(1600);
    expect(s.totals.missTok).toBe(800);
    expect(s.totals.outTok).toBe(140);
    expect(s.totals.reasoningTok).toBe(700);
    expect(s.totals.hitRate).toBe(1600 / 2400);

    expect(s.peakSplit).toEqual({ peakCalls: 1, peakCostUsd: 0.25, offCalls: 2, offCostUsd: 0.625 });
  });

  test("summary(1) is today only", () => {
    seed();
    const s = led.summary(1);
    expect(s.byDay.length).toBe(1);
    expect(s.totals.calls).toBe(2);
  });

  test("a nonsense window falls back to a week rather than throwing", () => {
    seed();
    expect(led.summary(Number.NaN).days).toBe(7);
    expect(led.summary(0).days).toBe(7);
  });

  test("an absurd window is clamped, not walked off the end of Date", () => {
    seed();
    // `px cost 1e12` reaches summary() as a finite number >= 1, so the fallback
    // above does not catch it; unclamped it puts `since` past Date's range and
    // toISOString throws a RangeError where a table should be.
    const s = led.summary(1e12);
    expect(s.days).toBe(3650);
    expect(s.sinceUtc).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    expect(s.totals.calls).toBe(4); // the 30-day-old row is inside this window
    expect(formatSummary(s)).toContain("last 3650 days");
  });

  test("formatSummary renders every bucket and says so when there is nothing", () => {
    expect(formatSummary(led.summary(7))).toContain("no calls on record");

    seed();
    const text = formatSummary(led.summary(7));
    expect(text).toContain(dayIso(0).slice(0, 10));
    expect(text).toContain(dayIso(1).slice(0, 10));
    expect(text).toContain("$0.8750"); // the total
    expect(text).toContain("66.7%"); // 1600/2400, token-weighted
    expect(text).toContain("of spend at 2x");
    // Every line of a table is the same width, or the columns are not columns.
    const widths = new Set(text.split("\n").filter((l) => l.startsWith("-")).map((l) => l.length));
    expect(widths.size).toBe(1);
  });
});

describe("the other tables", () => {
  test("cache breaks, guard trips and runs land, and a run upserts by id", () => {
    led.recordCacheBreak({
      session_id: "s1",
      zone: "A",
      expected_sha: "aaa",
      actual_sha: "bbb",
      detail: "tools array reordered",
    });
    led.recordGuardTrip({ session_id: "s1", task_id: "t1", guard: "budget", detail: "$0.1600" });
    led.recordRun({
      run_id: "r1",
      task_id: "t1",
      config: "lane-e",
      outcome: "error",
      baseline_exit: 1,
      final_exit: 1,
      failing_delta: "",
      turns: 3,
      verify_rejects: 0,
      consults: 0,
      edit_retries: 0,
      total_cost_usd: 0.01,
      wall_s: 12.5,
    });
    // The same run, finished. One row, not two.
    led.recordRun({
      run_id: "r1",
      task_id: "t1",
      config: "lane-e",
      outcome: "passed",
      baseline_exit: 1,
      final_exit: 0,
      failing_delta: "[]",
      turns: 9,
      verify_rejects: 2,
      consults: 1,
      edit_retries: 0,
      total_cost_usd: 0.04,
      wall_s: 61.25,
    });

    const raw = new Database(dbPath, { readonly: true });
    const breaks = raw.query<{ zone: string; detail: string }, []>("SELECT zone, detail FROM cache_breaks").all();
    expect(breaks).toEqual([{ zone: "A", detail: "tools array reordered" }]);

    const trips = raw.query<{ guard: string }, []>("SELECT guard FROM guard_trips").all();
    expect(trips).toEqual([{ guard: "budget" }]);

    const runs = raw
      .query<{ run_id: string; outcome: string; final_exit: number; turns: number; total_cost_usd: number }, []>(
        "SELECT run_id, outcome, final_exit, turns, total_cost_usd FROM runs",
      )
      .all();
    expect(runs).toEqual([{ run_id: "r1", outcome: "passed", final_exit: 0, turns: 9, total_cost_usd: 0.04 }]);

    // ts_utc defaults to write time when the caller omits it.
    const ts = raw.query<{ ts_utc: string }, []>("SELECT ts_utc FROM guard_trips").get();
    expect(ts?.ts_utc).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    raw.close();
  });
});
