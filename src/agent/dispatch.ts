/**
 * Tool dispatch for one assistant turn.
 *
 * Two rules, both forced by measurement:
 *
 * 1. Every tool_call_id gets a result, always. The invariant is bidirectional —
 *    a missing result is a 400 and so is an extra one. A crash, a timeout, a
 *    refusal and a Ctrl-C therefore all have to synthesize a result rather than
 *    dropping one on the floor.
 *
 * 2. Reads run concurrently, mutations run in order. The model already
 *    parallelizes correctly on its own (45/45 trials issued three independent
 *    reads in one turn, and 45/45 serialized a dependent read-then-edit), so
 *    this is about protecting the filesystem from ourselves, not about coaching
 *    the model. `parallel_tool_calls: false` is accepted by the API and then
 *    ignored, so the gate has to live here.
 */

import { parseArgs } from "./session.ts";
import { SafetyError } from "./safety.ts";
import type { RawToolCall, ToolContext, ToolDef, ToolOutput } from "../types.ts";
import type { Ui } from "../ui/render.ts";

export interface DispatchResult {
  toolCallId: string;
  name: string;
  output: ToolOutput;
}

export async function dispatch(
  calls: RawToolCall[],
  tools: ToolDef[],
  ctx: ToolContext,
  ui: Ui,
): Promise<DispatchResult[]> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const results = new Map<string, DispatchResult>();

  const concurrent: RawToolCall[] = [];
  const sequential: RawToolCall[] = [];

  for (const c of calls) {
    const def = byName.get(c.function.name);
    if (!def) {
      // Hallucinated tool name: 1 in 180 trials. Name the real ones and let the
      // model correct itself next turn rather than failing the run.
      results.set(c.id, {
        toolCallId: c.id,
        name: c.function.name,
        output: {
          content: `ERROR: no tool named "${c.function.name}". Available: ${[...byName.keys()].join(", ")}.`,
          isError: true,
        },
      });
      continue;
    }
    (def.executionMode === "concurrent" ? concurrent : sequential).push(c);
  }

  await Promise.all(
    concurrent.map(async (c) => {
      results.set(c.id, await runOne(c, byName.get(c.function.name)!, ctx, ui));
    }),
  );

  for (const c of sequential) {
    results.set(c.id, await runOne(c, byName.get(c.function.name)!, ctx, ui));
  }

  // Preserve the model's own ordering in the transcript.
  return calls.map(
    (c) =>
      results.get(c.id) ?? {
        toolCallId: c.id,
        name: c.function.name,
        output: { content: "ERROR: px failed to produce a result for this call.", isError: true },
      },
  );
}

async function runOne(c: RawToolCall, def: ToolDef, ctx: ToolContext, ui: Ui): Promise<DispatchResult> {
  const started = Date.now();
  try {
    const args = parseArgs(c);
    const out = await def.run(args, ctx);
    ui.toolResult(def.name, `${summarize(out.content)} ${Date.now() - started}ms`, out.isError);
    return { toolCallId: c.id, name: def.name, output: out };
  } catch (e) {
    // A refusal is information the model should act on, not a crash. Everything
    // that reaches here becomes a normal tool result carrying the reason.
    const msg =
      e instanceof SafetyError
        ? `REFUSED: ${e.message}`
        : `ERROR: ${(e as Error).message ?? String(e)}`;
    ui.toolResult(def.name, msg.slice(0, 120), true);
    return { toolCallId: c.id, name: def.name, output: { content: msg, isError: true } };
  }
}

function summarize(content: string): string {
  const lines = content.split("\n").length;
  const bytes = Buffer.byteLength(content, "utf8");
  return `${lines} line${lines === 1 ? "" : "s"}, ${bytes}B,`;
}
