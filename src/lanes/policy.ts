/**
 * Lanes.
 *
 * The thinking marker sits at serialized position 0 of the prefix, and the KV
 * cache is not shared across SKUs. So reasoning effort is not a parameter you
 * tune per call — it is a cache namespace. Switching it mid-session forfeits
 * the entire prefix: on a 200K-token context that is 200,000 x $0.66/M =
 * $0.132 of re-prefill before a single token comes back.
 *
 * px therefore pins one lane per session and bridges to the others through the
 * `consult` tool, which opens a small self-contained side conversation whose
 * answer returns as a tool result in the append-only tail.
 */

import type { ModelId } from "../types.ts";

export interface LaneConfig {
  readonly name: string;
  readonly model: ModelId;
  /** null omits the field entirely, which is a DIFFERENT prefix from "minimal". */
  readonly reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | null;
  /** null omits it. Ignored by the server when thinking is on. */
  readonly temperature: number | null;
  readonly maxTokens: number;
}

/**
 * Lane E — the loop. Roughly 97% of all calls.
 *
 * Thinking off buys three things at once: no hidden input preamble (+26 tokens
 * on flash, +79 on pro, every single request), no reasoning tokens billed at
 * full output rate, and legal forced tool_choice — which is a hard 400 whenever
 * thinking is enabled. It also makes temperature work, so temperature 0 gives
 * byte-identical tool arguments, which is what makes golden tests possible.
 */
export const LANE_E: LaneConfig = Object.freeze({
  name: "E",
  model: "deepseek-flash",
  reasoningEffort: "none",
  temperature: 0,
  maxTokens: 16384,
});

/**
 * Lane R — escalation, reached only through `consult`.
 *
 * max_tokens is deliberately large. Reasoning tokens are emitted before content
 * and consume the budget first, deterministically: 18 of 18 trials at
 * max_tokens 256/1024/4096 with thinking on returned finish_reason=length,
 * completion_tokens == reasoning_tokens, and an empty content field, fully
 * billed. Never send a small max_tokens on a thinking lane.
 */
export const LANE_R: LaneConfig = Object.freeze({
  name: "R",
  model: "deepseek-flash",
  reasoningEffort: "low",
  temperature: null,
  maxTokens: 32768,
});

/**
 * Lane R-pro — second escalation only, when Lane R's answer fails validation.
 *
 * Pinned to "low" forever. At medium and above, v4-pro ran 84-315 seconds per
 * call and produced 2.5-3x LESS content than flash with thinking off. It is a
 * depth tool, not a quality dial.
 */
export const LANE_R_PRO: LaneConfig = Object.freeze({
  name: "R-pro",
  model: "deepseek-v4-pro",
  reasoningEffort: "low",
  temperature: null,
  maxTokens: 32768,
});

/** A session pins exactly one loop lane. This asserts nobody changed it. */
export function assertLanePinned(pinned: LaneConfig, used: LaneConfig): void {
  if (pinned.model !== used.model || pinned.reasoningEffort !== used.reasoningEffort) {
    throw new Error(
      `lane drift: session pinned to ${pinned.name} (${pinned.model}/${pinned.reasoningEffort}) ` +
        `but a call used ${used.name} (${used.model}/${used.reasoningEffort}). ` +
        `That forfeits the cached prefix. Escalate through consult() instead.`,
    );
  }
}
