/**
 * finish — a request, not a fact.
 *
 * The model does not get to declare success. This tool only records the claim
 * and hands it to the loop, which runs the verifier and either accepts the run
 * or feeds the failure back as the next turn. Naming the tool "finish" rather
 * than "done" keeps that asymmetry legible in the transcript: the model asks,
 * the harness decides.
 */

import type { ToolContext, ToolDef, ToolOutput } from "../types.ts";

export const finishTool: ToolDef = {
  name: "finish",
  description:
    "Ask to end the run. px then runs the project's build and tests against your changes. " +
    "If they fail, the run does NOT end — the failure comes back to you and you keep working. " +
    "So verify before calling this, and list every file you touched.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "What you changed and why, in a few lines." },
      changed_files: { type: "array", description: "Every path you created or modified.", items: { type: "string" } },
    },
    required: ["summary", "changed_files"],
  },
  executionMode: "sequential",
  run: (args, _ctx) => finishRun(args),
};

async function finishRun(args: Record<string, unknown>): Promise<ToolOutput> {
  const summary = typeof args["summary"] === "string" ? args["summary"].trim() : "";
  if (!summary) return { content: "ERROR: finish needs a summary of what you changed.", isError: true };

  const files = Array.isArray(args["changed_files"])
    ? args["changed_files"].filter((f): f is string => typeof f === "string" && f.length > 0)
    : [];

  // The loop intercepts on tool name and never reaches this string in a normal
  // run; it exists so a stray call still produces a legal tool result rather
  // than a dangling tool_call_id, which is a hard 400.
  return { content: `FINISH REQUESTED — ${files.length} file(s) claimed. px will verify before ending the run.` };
}
