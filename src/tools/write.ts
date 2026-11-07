/**
 * write — new files and full rewrites only.
 *
 * The 400-line refusal exists because a full rewrite of a large file is how a
 * model quietly deletes code it never read: it reproduces the parts it
 * remembers and drops the rest, and the diff looks intentional. edit cannot
 * fail that way — an anchor either matches or it does not.
 */

import { mkdir } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { confinePath, SafetyError } from "../agent/safety.ts";
import type { ToolContext, ToolDef, ToolOutput } from "../types.ts";

const REWRITE_LIMIT = 400;

export const writeTool: ToolDef = {
  name: "write",
  description:
    "Create a file, or replace one whole. Parent directories are created. " +
    `Refuses to overwrite a file longer than ${REWRITE_LIMIT} lines — use edit for those.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the worktree root." },
      content: { type: "string", description: "Full file contents." },
    },
    required: ["path", "content"],
  },
  executionMode: "sequential",
  run: (args, ctx) => writeRun(args, ctx),
};

async function writeRun(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const path = typeof args["path"] === "string" ? args["path"] : "";
  const content = typeof args["content"] === "string" ? args["content"] : null;
  if (!path) return { content: "ERROR: write needs a path.", isError: true };
  if (content === null) return { content: "ERROR: write needs a content string.", isError: true };

  let abs: string;
  let rel: string;
  try {
    abs = confinePath(ctx.root, path);
    rel = relative(ctx.root, abs) || path;
  } catch (e) {
    return { content: `ERROR: ${e instanceof SafetyError ? e.message : String(e)}`, isError: true };
  }

  const existing = Bun.file(abs);
  const existed = await existing.exists();
  if (existed) {
    const prior = await existing.text();
    const priorLines = countLines(prior);
    if (priorLines > REWRITE_LIMIT) {
      return {
        content:
          `ERROR: ${rel} already exists and is ${priorLines} lines. write only creates files or rewrites short ones. ` +
          `Use edit with anchors instead.`,
        isError: true,
      };
    }
  }

  try {
    await mkdir(dirname(abs), { recursive: true });
    await Bun.write(abs, content);
  } catch (e) {
    return { content: `ERROR: could not write ${rel}: ${String(e)}`, isError: true };
  }

  return { content: `${existed ? "rewrote" : "created"} ${rel} (${countLines(content)} lines)`, changedPaths: [rel] };
}

/**
 * Same convention as read: a trailing newline terminates the final line, it does
 * not add one. Counting it made a 400-line file report 401 and trip the refusal
 * one line early, and made every "created (N lines)" disagree with the "of N"
 * the model had just read off the same file.
 */
function countLines(s: string): number {
  if (s === "") return 0;
  return (s.endsWith("\n") ? s.slice(0, -1) : s).split("\n").length;
}
