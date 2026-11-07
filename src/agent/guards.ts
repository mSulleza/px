/**
 * Loop guards: the things that stop a session that is no longer getting
 * anywhere, before it spends the budget proving it.
 *
 * Three independent stops, because they fail differently:
 *   - no-progress detection, which is cheap and catches the common stall
 *   - a step ceiling, which catches a loop that varies its arguments enough to
 *     dodge the hash but is still going nowhere
 *   - a spend ceiling, which is the only one that is actually load-bearing
 *
 * The hash is the interesting part. Tool argument whitespace drifts in ~80% of
 * calls with zero semantic change, so `read {"path":"a.ts"}` and
 * `read { "path" : "a.ts" }` are the same call and must hash the same, or the
 * guard never fires on the one failure mode it exists for.
 */

import { createHash } from "node:crypto";
import { cjson } from "../wire/canon.ts";
import type { RawToolCall } from "../types.ts";

/**
 * Longest window compared. 3 is enough to name the shape of a stall — beyond
 * that you are describing the plot of the session, not a loop.
 */
const WINDOW = 3;

/** Joins hashes within one turn. NUL cannot occur in a hex digest or a tool name. */
const SEP = "\u0000";

/**
 * Joins turn signatures into a window key. Distinct from SEP so a call cannot
 * migrate across a turn boundary and flatten to the same key: one turn of two
 * calls must never compare equal to two turns of one call, which would report
 * a stall that did not happen.
 */
const TURN_SEP = "\n";

export type Progress = "none" | "repeat" | "oscillation";
export type Escalation = "note" | "force_consult" | "block";

export interface GuardOptions {
  maxSteps: number;
  budgetUsd: number;
}

export class Guards {
  readonly maxSteps: number;
  readonly budgetUsd: number;

  /** One signature per recorded turn, oldest first. */
  readonly #turns: string[] = [];
  /** How many times the loop has asked what to do about a stall. */
  #trips = 0;

  constructor(opts: GuardOptions) {
    this.maxSteps = opts.maxSteps;
    this.budgetUsd = opts.budgetUsd;
  }

  /**
   * Fold one assistant turn into a single comparable signature.
   *
   * Sorted, so two tools dispatched concurrently in either order are one turn:
   * a concurrent turn has no meaningful order, and letting the stream's arrival
   * order into the signature would make an identical repeat look novel.
   * Not deduplicated, so `read a.ts` twice differs from `read a.ts` once.
   *
   * The call id is deliberately excluded — it is a fresh nonce every turn, so
   * including it would make every turn unique and the guard inert.
   */
  recordTurn(toolCalls: RawToolCall[]): void {
    const hashes = toolCalls.map((tc) => `${tc.function.name}:${digest(sanitizeArgs(tc.function.arguments))}`);
    hashes.sort();
    // An empty turn is a real signature, not a skip: two text-only turns in a
    // row is a model talking to itself, which is exactly the stall being hunted.
    this.#turns.push(hashes.join(SEP));
  }

  /**
   * Classify the recent history.
   *
   * Window comparison rather than a last-call check is the whole point. A naive
   * "did it just do that again" test sees A,B,A,B as four distinct turns and
   * lets the agent alternate two failing edits until the budget runs out.
   *
   * `repeat` is checked first and wins: an identical consecutive turn is the
   * stronger, more actionable finding, and a run of identical turns would
   * otherwise also satisfy the oscillation test and report the weaker one.
   */
  noProgress(): Progress {
    const n = this.#turns.length;
    if (n < 2) return "none";

    const last = this.#turns[n - 1];
    if (last !== undefined && last === this.#turns[n - 2]) return "repeat";

    // Widest window first: a matching 3-window is the stronger signal, though
    // both land on the same verdict. Capped at n-1 so at least one earlier
    // window exists to compare against — a full-length window matches nothing.
    // The 2-window is not a weaker fallback but the only one that can catch
    // A,B,A,B at turn 4; waiting for a 3-window to repeat costs two more turns.
    //
    // HORIZON is what keeps this from firing on coincidence. Searching all of
    // history flags any pair that ever recurs — `read x` then `bun test` thirty
    // turns and a dozen real edits later is not a loop, but it matches, and
    // since #trips never decays three such coincidences block a healthy run.
    // A cycle of period w that is actually cycling puts its previous occurrence
    // at start n-2w, so a lookback of 2*WINDOW catches every period this
    // detector claims to see and nothing older.
    const horizon = Math.max(0, n - 2 * WINDOW);
    for (let w = Math.min(WINDOW, n - 1); w >= 2; w--) {
      const tail = this.#turns.slice(n - w).join(TURN_SEP);
      for (let start = n - w - 1; start >= horizon; start--) {
        if (this.#turns.slice(start, start + w).join(TURN_SEP) === tail) return "oscillation";
      }
    }
    return "none";
  }

  /**
   * What to do about the stall, escalating each time it is asked.
   *
   * Nudge, then force a second opinion, then stop. The `note` rung is rendered
   * into ZONE C rather than appended as a message: ZONE C is rebuilt every turn
   * anyway, so the nudge costs nothing and, more importantly, evaporates once
   * the agent moves on instead of sitting in the cached prefix forever.
   */
  escalation(): Escalation {
    this.#trips++;
    if (this.#trips <= 1) return "note";
    if (this.#trips === 2) return "force_consult";
    return "block";
  }

  /** `step` is 1-based and names the turn about to run: maxSteps 12 permits 1..12. */
  stepExceeded(step: number): boolean {
    return step > this.maxSteps;
  }

  /**
   * Inclusive, unlike stepExceeded, and the asymmetry is intentional: having
   * spent exactly the budget leaves nothing to pay for the next call, whereas
   * being on step 12 of 12 means that step still gets to run.
   */
  budgetExceeded(spentUsd: number): boolean {
    return spentUsd >= this.budgetUsd;
  }

  reset(): void {
    this.#turns.length = 0;
    this.#trips = 0;
  }

  /** Recorded signatures, for the run log. Read-only by construction. */
  get signatures(): readonly string[] {
    return this.#turns;
  }

  get trips(): number {
    return this.#trips;
  }
}

/**
 * Canonicalize a raw tool-argument string so whitespace and key order drop out.
 *
 * Tolerant on purpose: flash truncates or malforms arguments often enough that
 * throwing here would turn a recoverable bad-arguments turn into a crash. An
 * unparseable string is returned verbatim, which still hashes consistently —
 * the same malformed blob twice is still a repeat.
 */
export function sanitizeArgs(raw: string): string {
  try {
    return cjson(JSON.parse(raw) as unknown);
  } catch {
    return raw;
  }
}

/**
 * Synchronous SHA-256.
 *
 * wire/canon.ts exports a sha256 too, but it is WebCrypto and therefore async;
 * recordTurn sits on the synchronous path between the stream closing and tool
 * dispatch, and awaiting a digest of a few hundred bytes there would colour
 * every caller async for no benefit. Same algorithm, same hex encoding.
 */
function digest(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
