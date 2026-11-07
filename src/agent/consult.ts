/**
 * `consult` — the escalation bridge.
 *
 * Reasoning effort sits at position 0 of the serialized prefix, and caches are
 * not shared across SKUs. So turning thinking on inside the loop, or switching
 * to v4-pro, throws away the entire cached prefix: on a 200K-token context that
 * is 200,000 x $0.66/M = $0.132 of re-prefill before a single token comes back.
 *
 * Instead, consult opens a small, self-contained side conversation on its own
 * small prefix and returns the answer as an ordinary tool result in the
 * append-only tail. The loop's prefix is never touched.
 *
 * Escalation to v4-pro is not a "try harder" button — it happens only when the
 * flash answer fails a structural check, because pro at medium effort or above
 * takes 84-315 seconds and produces less content than flash with thinking off.
 */

import { buildBody, freezeZoneA } from "../wire/body.ts";
import { Frag } from "../wire/frag.ts";
import { LANE_R, LANE_R_PRO } from "../lanes/policy.ts";
import { costUsd } from "../provider/models.ts";
import { isPeak } from "../schedule/offpeak.ts";
import { PxError, type ToolDef } from "../types.ts";
import type { DeepSeekClient } from "../provider/client.ts";
import type { Ui } from "../ui/render.ts";

const CONSULT_SYSTEM =
  "You are a senior engineer answering one bounded question for another agent. " +
  "You cannot run tools or read files: everything you know is in the question and the evidence provided. " +
  "Answer concretely and briefly. If the evidence is insufficient, say exactly what else is needed. " +
  "Do not restate the question. Do not hedge.";

export interface ConsultDeps {
  client: DeepSeekClient;
  ui: Ui;
  onCost: (usd: number) => void;
}

export function makeConsult(deps: ConsultDeps) {
  return async function consult(question: string, evidence: string[], depth: "low" | "pro"): Promise<string> {
    const lane = depth === "pro" ? LANE_R_PRO : LANE_R;
    const zoneA = await freezeZoneA("[]", Frag.system(CONSULT_SYSTEM), lane);

    const body = buildBody({
      zoneA,
      lane,
      frags: [],
      tail: Frag.user(
        evidence.length > 0
          ? `${question}\n\n<evidence>\n${evidence.join("\n---\n")}\n</evidence>`
          : question,
      ),
      stream: false,
    });

    deps.ui.debug(`consult on lane ${lane.name} (${lane.model})`);
    try {
      const r = await deps.client.complete(body, lane);
      deps.onCost(costUsd(lane.model, r.usage, isPeak(new Date())));
      return r.content.trim() || "(the consulted model returned no answer)";
    } catch (e) {
      if (e instanceof PxError && e.cls === "TRUNCATED_EMPTY") {
        // Reasoning ate the whole budget. The salvaged chain of thought is
        // usually still useful, and it is already paid for.
        const salvaged = typeof e.detail === "string" ? e.detail.slice(-2000) : "";
        return `(consult truncated before it produced an answer; salvaged reasoning tail)\n${salvaged}`;
      }
      throw e;
    }
  };
}

/** The model-facing tool. The implementation is injected by the loop. */
export const consultTool: ToolDef = {
  name: "consult",
  description:
    "Ask a reasoning model one bounded question when you are stuck or a decision is genuinely ambiguous. " +
    "It cannot see the repo, so include the relevant code or output in `evidence`. " +
    "Use depth 'pro' only after a 'low' answer proved inadequate.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "One specific question." },
      evidence: {
        type: "array",
        items: { type: "string" },
        description: "Code, errors or output the answer depends on.",
      },
      depth: { type: "string", enum: ["low", "pro"], default: "low" },
    },
    required: ["question"],
  },
  executionMode: "sequential",
  async run(args, ctx) {
    const question = String(args["question"] ?? "");
    const evidence = Array.isArray(args["evidence"]) ? (args["evidence"] as unknown[]).map(String) : [];
    const depth = args["depth"] === "pro" ? "pro" : "low";
    if (!question.trim()) return { content: "ERROR: consult requires a question.", isError: true };
    const answer = await ctx.consult(question, evidence, depth);
    return { content: answer };
  },
};
