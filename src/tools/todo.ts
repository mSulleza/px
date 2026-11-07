/**
 * todo — the agent's own plan.
 *
 * The list lives in a module store rather than in the prompt because it changes
 * almost every turn. Anything that changes per turn must sit in ZONE C, after
 * the frozen prefix; splicing it into the system prompt would move a mutating
 * span to serialized position 0 and forfeit the entire prefix cache on every
 * single update. The loop reads it from here and renders it into the tail.
 */

import type { ToolContext, ToolDef, ToolOutput } from "../types.ts";

export type TodoStatus = "todo" | "doing" | "done";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

let store: readonly TodoItem[] = Object.freeze([]);

/** A copy, always: the loop renders this into ZONE C and must not be able to mutate the store. */
export function getTodos(): TodoItem[] {
  return store.map((i) => ({ ...i }));
}

export function setTodos(items: readonly TodoItem[]): void {
  store = Object.freeze(items.map((i) => Object.freeze({ ...i })));
}

const STATUSES = new Set<string>(["todo", "doing", "done"]);

export const todoTool: ToolDef = {
  name: "todo",
  description:
    "Replace your task list. Send the WHOLE list every time, not a delta. " +
    "Keep exactly one item at \"doing\". Use it to hold multi-step work; it is not shown to the user as output.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable short id." },
            text: { type: "string", description: "One line, imperative." },
            status: { type: "string", enum: ["todo", "doing", "done"] },
          },
          required: ["id", "text", "status"],
        },
      },
    },
    required: ["items"],
  },
  executionMode: "sequential",
  run: (args, _ctx) => todoRun(args, _ctx),
};

async function todoRun(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolOutput> {
  const raw = args["items"];
  if (!Array.isArray(raw)) {
    return { content: 'ERROR: todo needs an items array, e.g. items=[{"id":"1","text":"...","status":"doing"}].', isError: true };
  }

  const items: TodoItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const r: unknown = raw[i];
    if (!r || typeof r !== "object") return { content: `ERROR: items[${i}] is not an object.`, isError: true };
    const o = r as Record<string, unknown>;
    const id = typeof o["id"] === "string" ? o["id"] : String(i + 1);
    const text = typeof o["text"] === "string" ? o["text"] : "";
    const status = typeof o["status"] === "string" && STATUSES.has(o["status"]) ? (o["status"] as TodoStatus) : "todo";
    if (!text) return { content: `ERROR: items[${i}].text is required.`, isError: true };
    items.push({ id, text, status });
  }

  setTodos(items);
  const done = items.filter((i) => i.status === "done").length;
  const doing = items.find((i) => i.status === "doing");
  return {
    content: `todo: ${done}/${items.length} done${doing ? `, now: ${doing.text}` : ""}`,
  };
}
