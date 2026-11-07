/**
 * The tool set.
 *
 * buildRegistry takes no arguments and has no branches, and that is the whole
 * contract. The serialized tools array sits inside the frozen prefix, so a set
 * that varies by turn — a tool hidden until it is "relevant", a debug tool
 * added under a flag — changes bytes at a fixed offset and destroys the cache
 * behind it. Measured: appending one tool took a session's hit from 20,224
 * tokens to 3,328. Order does not matter (canonTools sorts); membership does.
 *
 * Anything conditional belongs in ZONE C, never here.
 */

import type { ToolDef } from "../types.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { finishTool } from "./finish.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";
import { readTool } from "./read.ts";
import { todoTool } from "./todo.ts";
import { writeTool } from "./write.ts";

export function buildRegistry(): ToolDef[] {
  return [bashTool, editTool, finishTool, grepTool, lsTool, readTool, todoTool, writeTool];
}
