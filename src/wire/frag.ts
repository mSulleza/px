/**
 * Immutable message fragments.
 *
 * A Frag is created once from the exact bytes that will be sent for the rest of
 * the session, and there is no accessor that hands back a parsed object. That
 * is deliberate: re-serialization is the failure mode this whole design guards
 * against, so it is made structurally impossible rather than merely forbidden.
 */

import { canonAssistant, canonSystem, canonToolResult, canonUser } from "./canon.ts";
import type { RawToolCall } from "../types.ts";

export type FragKind = "system" | "user" | "assistant" | "tool" | "summary";

export class Frag {
  readonly #json: string;
  readonly kind: FragKind;
  /** Present on assistant frags: the ids this turn asked for. */
  readonly toolCallIds: readonly string[];
  /** Present on tool frags: the id this result answers. */
  readonly answersId?: string;

  private constructor(json: string, kind: FragKind, toolCallIds: string[] = [], answersId?: string) {
    this.#json = json;
    this.kind = kind;
    this.toolCallIds = Object.freeze(toolCallIds);
    this.answersId = answersId;
    Object.freeze(this);
  }

  /** The bytes. This is the only way out, and it is a copy of a frozen string. */
  get json(): string {
    return this.#json;
  }

  get byteLength(): number {
    return Buffer.byteLength(this.#json, "utf8");
  }

  static system(prompt: string): Frag {
    return new Frag(canonSystem(prompt), "system");
  }

  static user(text: string): Frag {
    return new Frag(canonUser(text), "user");
  }

  static assistant(content: string, toolCalls: RawToolCall[]): Frag {
    return new Frag(
      canonAssistant(content, toolCalls),
      "assistant",
      toolCalls.map((t) => t.id),
    );
  }

  static toolResult(toolCallId: string, content: string): Frag {
    return new Frag(canonToolResult(toolCallId, content), "tool", [], toolCallId);
  }

  /** Replaces a dropped span after compaction. Sits at the head of ZONE B. */
  static summary(text: string): Frag {
    return new Frag(canonUser(`[earlier work, summarized]\n${text}`), "summary");
  }
}

/**
 * The tool-result invariant, checked before every send.
 *
 * DeepSeek enforces this bidirectionally: the set of tool_call_ids in the last
 * assistant message must exactly equal the ids in the tool messages that follow
 * it. Missing ids 400. Extra ids also 400. A timeout, a denied permission or a
 * Ctrl-C must therefore still synthesize a result rather than dropping one.
 *
 * Checking it locally converts a wasted round trip into an assertion that names
 * the offending id.
 */
export function assertToolResultInvariant(frags: readonly Frag[]): void {
  for (let i = 0; i < frags.length; i++) {
    const f = frags[i]!;
    if (f.kind !== "assistant" || f.toolCallIds.length === 0) continue;

    const answered = new Set<string>();
    for (let j = i + 1; j < frags.length; j++) {
      const nxt = frags[j]!;
      if (nxt.kind !== "tool") break;
      if (nxt.answersId) answered.add(nxt.answersId);
    }

    const asked = new Set(f.toolCallIds);
    const missing = [...asked].filter((id) => !answered.has(id));
    const extra = [...answered].filter((id) => !asked.has(id));

    // The last assistant turn is allowed to be unanswered: we are mid-dispatch.
    const isLast = i === frags.length - 1 || frags.slice(i + 1).every((x) => x.kind === "tool");
    if (missing.length > 0 && !(isLast && answered.size === 0)) {
      throw new Error(`tool-result invariant: unanswered tool_call_id(s) ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      throw new Error(`tool-result invariant: tool result(s) for unknown id(s) ${extra.join(", ")}`);
    }
  }
}
