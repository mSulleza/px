/**
 * Shared types for px.
 *
 * Everything here is wire-adjacent. The rule that governs this file: any value
 * that ends up inside a request body must be representable as deterministic
 * bytes, because DeepSeek's prefix cache is byte-exact and prices a hit at 2%
 * of a miss (flash: $0.003/M vs $0.15/M). See src/wire/canon.ts.
 */

export type ModelId = "deepseek-flash" | "deepseek-v4-pro";

/** Roles px actually emits. No "developer", no vendor extensions. */
export type Role = "system" | "user" | "assistant" | "tool";

/** A tool call exactly as the stream produced it. `arguments` stays a raw string. */
export interface RawToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolResultPayload {
  tool_call_id: string;
  content: string;
}

/** JSON Schema subset px uses for tool parameters. DeepSeek accepts far more. */
export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  [k: string]: unknown;
}

export type ExecutionMode = "concurrent" | "sequential";

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Concurrent tools may run in parallel within one assistant turn. */
  executionMode: ExecutionMode;
  /** Implementation. Receives parsed args; returns the string the model sees. */
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;
}

export interface ToolOutput {
  content: string;
  /** Set when the tool mutated the filesystem, for the diff renderer. */
  changedPaths?: string[];
  isError?: boolean;
}

export interface ToolContext {
  /** Absolute path the agent is confined to. Every path resolves inside this. */
  root: string;
  budgetUsd: number;
  spentUsd: () => number;
  /** Opens an ephemeral Lane R conversation. Wired by the loop. */
  consult: (question: string, evidence: string[], depth: "low" | "pro") => Promise<string>;
  log: (line: string) => void;
}

/** Usage as px accounts it. Read only these three; never prompt_tokens. */
export interface Usage {
  hitTokens: number;
  missTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface StreamResult {
  /** Assistant text. May be non-empty alongside tool calls (flash narrates). */
  content: string;
  toolCalls: RawToolCall[];
  finishReason: string;
  modelEchoed: string;
  usage: Usage;
  reasoningContent: string;
  ttfbMs: number;
  wallMs: number;
}

/**
 * Error classes. Each one has a distinct recovery, which is the entire point
 * of naming them: a blind retry on TRUNCATED_EMPTY doubles a bill that was
 * already spent on reasoning tokens that produced no content.
 */
export type ErrorClass =
  | "TRUNCATED_EMPTY"
  | "MODEL_MISMATCH"
  | "TOOL_INVARIANT_VIOLATION"
  | "IMAGE_TO_PRO"
  | "RATE_LIMIT"
  | "INACTIVITY_TIMEOUT"
  | "CONTEXT_OVERFLOW"
  | "BAD_REQUEST"
  | "SERVER_ERROR"
  | "NETWORK";

export class PxError extends Error {
  constructor(
    readonly cls: ErrorClass,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = `PxError(${cls})`;
  }
}

/**
 * "partial" exists because a repo whose suite was already red is the normal
 * case for this tool, and "we removed two failures and introduced none, but the
 * suite is still not green" is genuinely different information from "we got
 * nowhere". Neither one is success: only `passed` means the command exited 0.
 */
export type Outcome = "passed" | "partial" | "blocked" | "budget" | "error";

export interface RunResult {
  outcome: Outcome;
  summary: string;
  branch?: string;
  changedFiles: string[];
  turns: number;
  costUsd: number;
  verifyRejects: number;
  hitRate: number;
}
