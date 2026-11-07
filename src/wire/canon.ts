/**
 * Canonical serialization. This file is the byte authority for px.
 *
 * Why it exists, measured: DeepSeek's prefix cache matches on exact bytes at a
 * 128-token quantum, and tool JSON key order is part of the prefix. Two
 * semantically identical tool arrays with different key order produce the same
 * prompt_tokens and a cache hit that collapses from 20,224 to 3,200. Nothing in
 * the usage payload signals that you did it. So px never hands the model an
 * object it serialized casually — every byte comes through here.
 *
 * Rule: sorted keys, no whitespace, everywhere, recursively. Sorting rather
 * than a per-shape key order means a new field cannot silently reorder a
 * sibling and break the prefix for the life of the session.
 */

import type { JsonSchema, RawToolCall, ToolDef } from "../types.ts";

/** Deterministic JSON: object keys sorted lexicographically, no whitespace. */
export function cjson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (src[k] === undefined) continue; // undefined would vanish anyway; drop it deterministically
      out[k] = sortDeep(src[k]);
    }
    return out;
  }
  return v;
}

/** One tool, in wire shape. */
export function canonTool(t: ToolDef): unknown {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters as JsonSchema },
  };
}

/**
 * The whole tools array, lexicographically sorted by name.
 *
 * Sorting is not cosmetic: appending a tool at the end of the array destroyed
 * ~98% of the cache hit in a real session (20,224 -> 3,328). Sorted order means
 * the array is a pure function of the tool set, so the same set always produces
 * the same bytes regardless of registration order.
 */
export function canonTools(tools: ToolDef[]): string {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const names = new Set<string>();
  for (const t of sorted) {
    if (!/^[a-zA-Z0-9_-]+$/.test(t.name)) {
      throw new Error(`tool name "${t.name}" is illegal: DeepSeek requires ^[a-zA-Z0-9_-]+$ (dots and colons 400)`);
    }
    if (names.has(t.name)) throw new Error(`duplicate tool name "${t.name}" (DeepSeek returns 400)`);
    names.add(t.name);
  }
  return cjson(sorted.map(canonTool));
}

export function canonSystem(prompt: string): string {
  return cjson({ role: "system", content: prompt });
}

export function canonUser(text: string): string {
  return cjson({ role: "user", content: text });
}

/**
 * An assistant turn, replayed exactly.
 *
 * `arguments` is passed through as the raw string the stream produced. Parsing
 * and re-stringifying it would normalize whitespace and key order, which is a
 * cache break with no visible symptom. A parsed copy is used for execution;
 * this copy is bytes only.
 */
export function canonAssistant(content: string, toolCalls: RawToolCall[]): string {
  const msg: Record<string, unknown> = { role: "assistant", content };
  if (toolCalls.length > 0) {
    msg["tool_calls"] = toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }
  return cjson(msg);
}

/** Tool result. The id must be replayed verbatim: the API keys reasoning to it. */
export function canonToolResult(toolCallId: string, content: string): string {
  return cjson({ role: "tool", tool_call_id: toolCallId, content });
}

export async function sha256(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
