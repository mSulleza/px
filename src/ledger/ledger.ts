/**
 * The cost ledger.
 *
 * This is the falsifiability layer. Every efficiency claim px makes — cache hit
 * rate, cost per task, off-peak savings, "the guardrail caught it" — is a story
 * until there is a row here with a timestamp on it. So the ledger writes on
 * every call, unconditionally, and never summarizes at write time: aggregation
 * is a query, because a number you cannot re-derive from the raw rows is a
 * number you cannot audit.
 *
 * Cost is computed by the CALLER via costUsd(), and stored as given. The one
 * exception is expected_miss_tok, which the ledger computes itself — see
 * recordCall. That column is what turns a silent cache break into an alarm.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ErrorClass, ModelId } from "../types.ts";
import { MODELS, predictedHit } from "../provider/models.ts";

/**
 * Slack on the telescoping check, in tokens. Two 128-token quanta: one for the
 * quantum itself, one for flash's measured 128-token floor penalty. A real
 * prefix break is 10^3-10^4 tokens, so the threshold has no need to be tight.
 */
export const MISS_TOLERANCE_TOK = 256;

/**
 * Ceilings on the two caller-supplied numbers that reach a Date or a LIMIT.
 *
 * `px cost 1e12` arrives off argv as a finite number, and an unclamped
 * subtraction walks Date past its +/-8.64e15ms range, where toISOString throws
 * a bare RangeError instead of printing a table. Ten years is longer than any
 * ledger will live. The recent() cap is the same argument applied to rows: a
 * query whose result size is chosen by an argument is an unbounded one.
 */
const MAX_WINDOW_DAYS = 3650;
const MAX_RECENT = 1000;

/** Named bindings. bun:sqlite requires the `$` prefix outside strict mode. */
type Bindings = Record<string, string | number | null>;

// ---------------------------------------------------------------------------
// Write shapes. Snake_case, mirroring the columns, because these rows are built
// at call sites that have just read a usage payload and should not have to
// remember a second spelling of the same nineteen fields.
// ---------------------------------------------------------------------------

export interface CallRow {
  /** Defaults to now. Passed explicitly so a row can be dated by the call, not the write. */
  ts_utc?: string;
  session_id: string;
  task_id: string;
  lane: string;
  model_requested: ModelId;
  /** The SKU the server claimed. Differs from model_requested on a silent alias. */
  model_echoed: string;
  hit_tok: number;
  miss_tok: number;
  out_tok: number;
  reasoning_tok: number;
  /**
   * Accepted for call-site convenience and then ignored: the ledger recomputes
   * it from its own lineage. A caller's prediction lives in a Session object
   * that dies with the process; the ledger's survives a resume, a compaction
   * and a crash, so it is the one that belongs on the record.
   */
  expected_miss_tok?: number;
  /** 1 during the 2x window. Stored, not derived, so it always matches cost_usd. */
  peak: number;
  cost_usd: number;
  prefix_sha: string;
  finish_reason: string;
  error_class?: ErrorClass | null;
  ttfb_ms: number;
  wall_ms: number;
  n_tool_calls: number;
}

export interface CacheBreakRow {
  ts_utc?: string;
  session_id: string;
  zone: string;
  expected_sha: string;
  actual_sha: string;
  detail: string;
}

export interface GuardTripRow {
  ts_utc?: string;
  session_id: string;
  task_id: string;
  guard: string;
  detail: string;
}

export interface RunRow {
  run_id: string;
  task_id: string;
  config: string;
  ts_utc?: string;
  outcome: string;
  baseline_exit?: number | null;
  final_exit?: number | null;
  failing_delta: string;
  turns: number;
  verify_rejects: number;
  consults: number;
  edit_retries: number;
  total_cost_usd: number;
  wall_s: number;
}

// ---------------------------------------------------------------------------
// Read shapes. CamelCase: these are values, not rows.
// ---------------------------------------------------------------------------

export interface SessionTotals {
  costUsd: number;
  hitTok: number;
  missTok: number;
  outTok: number;
  calls: number;
  /** Cache hits over prompt tokens. 0 for an empty session, never NaN. */
  hitRate: number;
}

export interface Bucket {
  key: string;
  calls: number;
  costUsd: number;
  hitTok: number;
  missTok: number;
  outTok: number;
  hitRate: number;
}

export interface Summary {
  days: number;
  sinceUtc: string;
  byDay: Bucket[];
  byLane: Bucket[];
  totals: Bucket & { reasoningTok: number };
  peakSplit: { peakCalls: number; peakCostUsd: number; offCalls: number; offCostUsd: number };
}

export interface RecentCall {
  id: number;
  tsUtc: string;
  sessionId: string;
  taskId: string;
  lane: string;
  modelRequested: string;
  modelEchoed: string;
  hitTok: number;
  missTok: number;
  outTok: number;
  reasoningTok: number;
  expectedMissTok: number;
  peak: boolean;
  costUsd: number;
  prefixSha: string;
  finishReason: string;
  errorClass: string | null;
  ttfbMs: number;
  wallMs: number;
  nToolCalls: number;
}

/** A turn that paid to re-read a prefix it should have had cached. */
export interface Anomaly {
  id: number;
  tsUtc: string;
  lane: string;
  modelRequested: string;
  hitTok: number;
  missTok: number;
  expectedMissTok: number;
  /** miss - expected. The size of the prefix that was thrown away. */
  excessTok: number;
  /** What throwing it away cost, at the miss-minus-hit differential. */
  excessUsd: number;
  prefixSha: string;
}

/** What recordCall learned while writing the row, so the loop can warn live. */
export interface CallReceipt {
  id: number;
  expectedMissTok: number;
  excessTok: number;
  anomalous: boolean;
}

// ---------------------------------------------------------------------------

const SQL_INSERT_CALL = `
INSERT INTO calls (
  ts_utc, session_id, task_id, lane, model_requested, model_echoed,
  hit_tok, miss_tok, out_tok, reasoning_tok, expected_miss_tok,
  peak, cost_usd, prefix_sha, finish_reason, error_class,
  ttfb_ms, wall_ms, n_tool_calls
) VALUES (
  $ts_utc, $session_id, $task_id, $lane, $model_requested, $model_echoed,
  $hit_tok, $miss_tok, $out_tok, $reasoning_tok, $expected_miss_tok,
  $peak, $cost_usd, $prefix_sha, $finish_reason, $error_class,
  $ttfb_ms, $wall_ms, $n_tool_calls
) RETURNING id`;

/** The prefix this turn inherits from: same session, same lane, most recent. */
const SQL_LINEAGE = `
SELECT hit_tok + miss_tok AS promptTok
FROM calls
WHERE session_id = $session_id AND lane = $lane AND model_requested = $model_requested
ORDER BY id DESC LIMIT 1`;

const SUM_COLS = `
  COUNT(*)                       AS calls,
  COALESCE(SUM(cost_usd),  0.0)  AS costUsd,
  COALESCE(SUM(hit_tok),   0)    AS hitTok,
  COALESCE(SUM(miss_tok),  0)    AS missTok,
  COALESCE(SUM(out_tok),   0)    AS outTok`;

const CALL_COLS = `
  id, ts_utc AS tsUtc, session_id AS sessionId, task_id AS taskId, lane,
  model_requested AS modelRequested, model_echoed AS modelEchoed,
  hit_tok AS hitTok, miss_tok AS missTok, out_tok AS outTok,
  reasoning_tok AS reasoningTok, expected_miss_tok AS expectedMissTok,
  peak, cost_usd AS costUsd, prefix_sha AS prefixSha,
  finish_reason AS finishReason, error_class AS errorClass,
  ttfb_ms AS ttfbMs, wall_ms AS wallMs, n_tool_calls AS nToolCalls`;

interface BucketRaw {
  bucket: string;
  calls: number;
  costUsd: number;
  hitTok: number;
  missTok: number;
  outTok: number;
}

export class Ledger {
  readonly #db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path, { create: true });

    // WAL, because the agent loop writes a row per turn while `px cost` or a
    // second worktree may be reading the same file. busy_timeout covers the
    // eval harness, which runs tasks in parallel against one ledger.
    this.#db.query("PRAGMA journal_mode = WAL").get();
    this.#db.run("PRAGMA busy_timeout = 5000");
    this.#db.run("PRAGMA synchronous = NORMAL");

    // The DDL is a file, read relative to this module, and every statement in
    // it is IF NOT EXISTS. Applying it on every open is the whole migration story.
    this.#db.run(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  }

  /**
   * Write one call, and decide for it what its miss tokens should have been.
   *
   * The telescoping law: with a byte-stable prefix, the miss tokens of a turn
   * are just the bytes appended since the last one, so the misses over a whole
   * conversation sum to roughly its final prompt size. That makes a single
   * oversized miss the only visible signature of a cache-breaking bug — the API
   * reports no error, returns no warning, and bills the difference at 50x the
   * hit rate on flash. Hence the prediction is stored next to the measurement.
   *
   * Lineage is (session, lane, model): the KV cache is not shared across SKUs
   * or effort settings, so a consult on Lane R does not inherit Lane E's prefix
   * and must not be judged against it. A prompt SMALLER than its predecessor's
   * is treated as a fresh lineage, which is exactly what a compaction is — the
   * re-prefill after dropping the oldest half is earned, not a bug.
   */
  recordCall(row: CallRow): CallReceipt {
    const promptTok = row.hit_tok + row.miss_tok;
    const prev = this.#lineagePromptTokens(row.session_id, row.lane, row.model_requested);
    const expected = expectedMiss(row.model_requested, promptTok, prev);

    const params: Bindings = {
      $ts_utc: row.ts_utc ?? new Date().toISOString(),
      $session_id: row.session_id,
      $task_id: row.task_id,
      $lane: row.lane,
      $model_requested: row.model_requested,
      $model_echoed: row.model_echoed,
      $hit_tok: row.hit_tok,
      $miss_tok: row.miss_tok,
      $out_tok: row.out_tok,
      $reasoning_tok: row.reasoning_tok,
      $expected_miss_tok: expected,
      $peak: row.peak ? 1 : 0,
      $cost_usd: row.cost_usd,
      $prefix_sha: row.prefix_sha,
      $finish_reason: row.finish_reason,
      $error_class: row.error_class ?? null,
      $ttfb_ms: row.ttfb_ms,
      $wall_ms: row.wall_ms,
      $n_tool_calls: row.n_tool_calls,
    };
    const inserted = this.#db.query<{ id: number }, Bindings>(SQL_INSERT_CALL).get(params);
    // RETURNING always yields a row for a successful insert, so an absent one
    // means the write did not land. Handing back a fabricated id would make the
    // one table px points at to prove its claims quietly agree with a lost row.
    if (!inserted) throw new Error("ledger: INSERT INTO calls returned no id; the row was not written");

    const excess = row.miss_tok - expected;
    return {
      id: inserted.id,
      expectedMissTok: expected,
      excessTok: excess,
      anomalous: excess > MISS_TOLERANCE_TOK,
    };
  }

  recordCacheBreak(row: CacheBreakRow): void {
    this.#db
      .query<unknown, Bindings>(
        `INSERT INTO cache_breaks (ts_utc, session_id, zone, expected_sha, actual_sha, detail)
         VALUES ($ts_utc, $session_id, $zone, $expected_sha, $actual_sha, $detail)`,
      )
      .run({
        $ts_utc: row.ts_utc ?? new Date().toISOString(),
        $session_id: row.session_id,
        $zone: row.zone,
        $expected_sha: row.expected_sha,
        $actual_sha: row.actual_sha,
        $detail: row.detail,
      });
  }

  recordGuardTrip(row: GuardTripRow): void {
    this.#db
      .query<unknown, Bindings>(
        `INSERT INTO guard_trips (ts_utc, session_id, task_id, guard, detail)
         VALUES ($ts_utc, $session_id, $task_id, $guard, $detail)`,
      )
      .run({
        $ts_utc: row.ts_utc ?? new Date().toISOString(),
        $session_id: row.session_id,
        $task_id: row.task_id,
        $guard: row.guard,
        $detail: row.detail,
      });
  }

  /**
   * Upsert, not insert: a run is written once when it starts and once when it
   * ends, under the same id, so a run that never reaches its finish line still
   * leaves a row saying so instead of vanishing from the denominator.
   */
  recordRun(row: RunRow): void {
    this.#db
      .query<unknown, Bindings>(
        `INSERT OR REPLACE INTO runs (
           run_id, task_id, config, ts_utc, outcome, baseline_exit, final_exit,
           failing_delta, turns, verify_rejects, consults, edit_retries,
           total_cost_usd, wall_s
         ) VALUES (
           $run_id, $task_id, $config, $ts_utc, $outcome, $baseline_exit, $final_exit,
           $failing_delta, $turns, $verify_rejects, $consults, $edit_retries,
           $total_cost_usd, $wall_s
         )`,
      )
      .run({
        $run_id: row.run_id,
        $task_id: row.task_id,
        $config: row.config,
        $ts_utc: row.ts_utc ?? new Date().toISOString(),
        $outcome: row.outcome,
        $baseline_exit: row.baseline_exit ?? null,
        $final_exit: row.final_exit ?? null,
        $failing_delta: row.failing_delta,
        $turns: row.turns,
        $verify_rejects: row.verify_rejects,
        $consults: row.consults,
        $edit_retries: row.edit_retries,
        $total_cost_usd: row.total_cost_usd,
        $wall_s: row.wall_s,
      });
  }

  sessionTotals(sessionId: string): SessionTotals {
    const r = this.#db
      .query<Omit<BucketRaw, "bucket">, Bindings>(
        `SELECT ${SUM_COLS} FROM calls WHERE session_id = $session_id`,
      )
      .get({ $session_id: sessionId });
    const calls = r?.calls ?? 0;
    const hitTok = r?.hitTok ?? 0;
    const missTok = r?.missTok ?? 0;
    return {
      costUsd: r?.costUsd ?? 0,
      hitTok,
      missTok,
      outTok: r?.outTok ?? 0,
      calls,
      hitRate: hitRate(hitTok, missTok),
    };
  }

  /**
   * Everything px has spent today, UTC, across every session.
   *
   * The per-task budget bounds one runaway. It does not bound twenty tasks, a
   * loop that relaunches, or an eval sweep — and the way an API bill actually
   * gets large is many small correct-looking runs, not one obvious disaster.
   * This is what the daily ceiling is checked against.
   */
  spentTodayUsd(): number {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const r = this.#db
      .query<{ costUsd: number }, Bindings>(
        `SELECT COALESCE(SUM(cost_usd), 0.0) AS costUsd FROM calls WHERE ts_utc >= $since`,
      )
      .get({ $since: since.toISOString() });
    return r?.costUsd ?? 0;
  }

  /**
   * `days` is calendar days in UTC, inclusive of today: summary(1) is today,
   * summary(7) is this day and the six before it. Rolling 24h windows would
   * make consecutive runs of `px cost 7` disagree for no reason a human cares about.
   */
  summary(days: number): Summary {
    const d = Number.isFinite(days) && days >= 1 ? Math.min(Math.floor(days), MAX_WINDOW_DAYS) : 7;
    const since = new Date(Date.now() - (d - 1) * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);
    const sinceUtc = since.toISOString();
    const p: Bindings = { $since: sinceUtc };

    const byDay = this.#db
      .query<BucketRaw, Bindings>(
        `SELECT substr(ts_utc, 1, 10) AS bucket, ${SUM_COLS}
         FROM calls WHERE ts_utc >= $since GROUP BY bucket ORDER BY bucket`,
      )
      .all(p)
      .map(toBucket);

    const byLane = this.#db
      .query<BucketRaw, Bindings>(
        `SELECT lane AS bucket, ${SUM_COLS}
         FROM calls WHERE ts_utc >= $since GROUP BY lane ORDER BY costUsd DESC`,
      )
      .all(p)
      .map(toBucket);

    const t = this.#db
      .query<Omit<BucketRaw, "bucket"> & { reasoningTok: number }, Bindings>(
        `SELECT ${SUM_COLS}, COALESCE(SUM(reasoning_tok), 0) AS reasoningTok
         FROM calls WHERE ts_utc >= $since`,
      )
      .get(p);

    const split = this.#db
      .query<{ peak: number; calls: number; costUsd: number }, Bindings>(
        `SELECT peak, COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0.0) AS costUsd
         FROM calls WHERE ts_utc >= $since GROUP BY peak`,
      )
      .all(p);
    const peakRow = split.find((s) => s.peak === 1);
    const offRow = split.find((s) => s.peak !== 1);

    return {
      days: d,
      sinceUtc,
      byDay,
      byLane,
      totals: {
        ...toBucket({ bucket: "total", ...(t ?? EMPTY_SUM) }),
        reasoningTok: t?.reasoningTok ?? 0,
      },
      peakSplit: {
        peakCalls: peakRow?.calls ?? 0,
        peakCostUsd: peakRow?.costUsd ?? 0,
        offCalls: offRow?.calls ?? 0,
        offCostUsd: offRow?.costUsd ?? 0,
      },
    };
  }

  recent(n: number): RecentCall[] {
    const limit = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_RECENT) : 20;
    return this.#db
      .query<Omit<RecentCall, "peak"> & { peak: number }, Bindings>(
        `SELECT ${CALL_COLS} FROM calls ORDER BY id DESC LIMIT $limit`,
      )
      .all({ $limit: limit })
      .map((r) => ({ ...r, peak: r.peak === 1 }));
  }

  /**
   * Turns whose miss tokens exceed what the telescoping law allows.
   *
   * This is the audit that the whole byte-stability apparatus exists to pass.
   * An empty result across a long session is the evidence; anything else names
   * the turn where ZONE A or ZONE B changed bytes, and prices the mistake.
   */
  anomalies(sessionId: string): Anomaly[] {
    const rows = this.#db
      .query<
        {
          id: number;
          tsUtc: string;
          lane: string;
          modelRequested: string;
          hitTok: number;
          missTok: number;
          expectedMissTok: number;
          peak: number;
          prefixSha: string;
        },
        Bindings
      >(
        `SELECT id, ts_utc AS tsUtc, lane, model_requested AS modelRequested,
                hit_tok AS hitTok, miss_tok AS missTok,
                expected_miss_tok AS expectedMissTok, peak, prefix_sha AS prefixSha
         FROM calls
         WHERE session_id = $session_id AND miss_tok - expected_miss_tok > $tol
         ORDER BY id`,
      )
      .all({ $session_id: sessionId, $tol: MISS_TOLERANCE_TOK });

    return rows.map((r) => {
      const excessTok = r.missTok - r.expectedMissTok;
      const facts = modelFacts(r.modelRequested);
      // Those tokens were billed as misses when they should have been hits, so
      // the damage is the differential, doubled inside the peak window.
      const perM = facts ? facts.price.missPerM - facts.price.hitPerM : 0;
      return {
        id: r.id,
        tsUtc: r.tsUtc,
        lane: r.lane,
        modelRequested: r.modelRequested,
        hitTok: r.hitTok,
        missTok: r.missTok,
        expectedMissTok: r.expectedMissTok,
        excessTok,
        excessUsd: ((excessTok * perM) / 1_000_000) * (r.peak === 1 ? 2 : 1),
        prefixSha: r.prefixSha,
      };
    });
  }

  close(): void {
    // Fold the WAL back in, so the .db file is self-contained for anyone who
    // copies it out to check the numbers. That is the point of keeping it.
    try {
      this.#db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } catch {
      // A read-only or already-closed handle is not worth failing a run over.
    }
    this.#db.close();
  }

  #lineagePromptTokens(sessionId: string, lane: string, model: ModelId): number | undefined {
    const r = this.#db.query<{ promptTok: number }, Bindings>(SQL_LINEAGE).get({
      $session_id: sessionId,
      $lane: lane,
      $model_requested: model,
    });
    return r?.promptTok;
  }
}

const EMPTY_SUM = { calls: 0, costUsd: 0, hitTok: 0, missTok: 0, outTok: 0 };

/**
 * What this turn's miss tokens should have been.
 *
 * No predecessor, or a prompt that shrank (compaction, or a reused session id
 * on a fresh conversation): nothing was cacheable, so the whole prompt is miss.
 */
export function expectedMiss(model: ModelId, promptTok: number, prevPromptTok: number | undefined): number {
  if (prevPromptTok === undefined || promptTok < prevPromptTok) return promptTok;
  return Math.max(0, promptTok - predictedHit(model, prevPromptTok));
}

function hitRate(hitTok: number, missTok: number): number {
  const prompt = hitTok + missTok;
  return prompt > 0 ? hitTok / prompt : 0;
}

/**
 * Hit rate is token-weighted, not the mean of per-call rates: a one-line
 * follow-up on a cold prefix and a 200K-token turn are not the same event, and
 * averaging their percentages would let the cheap one hide the expensive one.
 */
function toBucket(r: BucketRaw): Bucket {
  return {
    key: r.bucket,
    calls: r.calls,
    costUsd: r.costUsd,
    hitTok: r.hitTok,
    missTok: r.missTok,
    outTok: r.outTok,
    hitRate: hitRate(r.hitTok, r.missTok),
  };
}

function modelFacts(id: string) {
  return id === "deepseek-flash" || id === "deepseek-v4-pro" ? MODELS[id] : undefined;
}

// ---------------------------------------------------------------------------
// Rendering. `px cost` and nothing else.
// ---------------------------------------------------------------------------

const W = { key: 12, calls: 7, rate: 8, tok: 11, cost: 11 };

export function formatSummary(s: Summary): string {
  const window = `last ${s.days} day${s.days === 1 ? "" : "s"} · since ${s.sinceUtc.slice(0, 10)} UTC`;
  if (s.totals.calls === 0) return `px cost · ${window}\n\nno calls on record.`;

  const out: string[] = [`px cost · ${window}`, ""];
  out.push(...renderTable("day", s.byDay, s.totals));
  if (s.byLane.length > 1) {
    out.push("");
    out.push(...renderTable("lane", s.byLane));
  }

  const p = s.peakSplit;
  const spend = p.peakCostUsd + p.offCostUsd;
  out.push("");
  out.push(
    `peak ${p.peakCalls} calls ${usd(p.peakCostUsd)}` +
      (spend > 0 ? ` (${pct(p.peakCostUsd / spend)} of spend at 2x)` : "") +
      ` · off-peak ${p.offCalls} calls ${usd(p.offCostUsd)}`,
  );
  if (s.totals.reasoningTok > 0) {
    // Lane E pins effort to "none", so a non-zero total here is consult traffic.
    out.push(`reasoning ${tok(s.totals.reasoningTok)} tokens (consults)`);
  }
  return out.join("\n");
}

function renderTable(label: string, rows: Bucket[], total?: Bucket): string[] {
  const head =
    label.padEnd(W.key) +
    "calls".padStart(W.calls) +
    "hit%".padStart(W.rate) +
    "hit tok".padStart(W.tok) +
    "miss tok".padStart(W.tok) +
    "out tok".padStart(W.tok) +
    "cost".padStart(W.cost);
  const lines = [head, "-".repeat(head.length)];
  for (const r of rows) lines.push(renderRow(r));
  if (total) {
    lines.push("-".repeat(head.length));
    lines.push(renderRow(total));
  }
  return lines;
}

function renderRow(b: Bucket): string {
  return (
    b.key.slice(0, W.key - 1).padEnd(W.key) +
    String(b.calls).padStart(W.calls) +
    pct(b.hitRate).padStart(W.rate) +
    tok(b.hitTok).padStart(W.tok) +
    tok(b.missTok).padStart(W.tok) +
    tok(b.outTok).padStart(W.tok) +
    usd(b.costUsd).padStart(W.cost)
  );
}

/** Four decimals: a whole px task lands around $0.01, so cents hide the signal. */
function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function tok(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
