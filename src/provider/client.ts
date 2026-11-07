/**
 * The HTTP client. Owns the wire, the error taxonomy, and retry policy.
 *
 * No SDK. An SDK would re-serialize the body, and byte-exact bodies are the
 * whole premise of this project.
 */

import { PxError, type StreamResult } from "../types.ts";
import { assertModelEcho } from "./models.ts";
import { consumeStream, readUsage, scrubToolTags, type SseHandlers } from "../wire/sse.ts";
import type { LaneConfig } from "../lanes/policy.ts";

const BASE = "https://api.deepseek.com";

/** Inactivity, not total duration: the server can legitimately stall 10 minutes. */
const INACTIVITY_MS = 120_000;
const ABSOLUTE_MS = 900_000;

export interface ClientOptions {
  apiKey: string;
  onRequest?: (body: string) => void;
  onUsage?: (r: StreamResult, lane: LaneConfig) => void;
}

export class DeepSeekClient {
  constructor(private readonly opts: ClientOptions) {}

  async stream(body: string, lane: LaneConfig, handlers: SseHandlers = {}): Promise<StreamResult> {
    this.opts.onRequest?.(body);
    const started = Date.now();

    const res = await this.fetchWithRetry("/chat/completions", body);
    const result = await withAbsoluteDeadline(
      consumeStream(res, handlers, INACTIVITY_MS, started),
      ABSOLUTE_MS,
    );

    try {
      assertModelEcho(lane.model, result.modelEchoed);
    } catch (e) {
      throw new PxError("MODEL_MISMATCH", (e as Error).message, result.modelEchoed);
    }

    classifyResponse(result);
    this.opts.onUsage?.(result, lane);
    return result;
  }

  /** Non-streaming call, used by consult and by doctor probes. */
  async complete(body: string, lane: LaneConfig): Promise<StreamResult> {
    this.opts.onRequest?.(body);
    const started = Date.now();
    const res = await this.fetchWithRetry("/chat/completions", body);
    const json: any = await res.json();

    const msg = json.choices?.[0]?.message ?? {};
    const result: StreamResult = {
      content: scrubToolTags(msg.content ?? ""),
      toolCalls: (msg.tool_calls ?? []).map((tc: any) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" },
      })),
      finishReason: json.choices?.[0]?.finish_reason ?? "",
      modelEchoed: json.model ?? "",
      usage: readUsage(json.usage ?? {}),
      reasoningContent: msg.reasoning_content ?? "",
      ttfbMs: Date.now() - started,
      wallMs: Date.now() - started,
    };

    try {
      assertModelEcho(lane.model, result.modelEchoed);
    } catch (e) {
      throw new PxError("MODEL_MISMATCH", (e as Error).message, result.modelEchoed);
    }
    classifyResponse(result);
    this.opts.onUsage?.(result, lane);
    return result;
  }

  /**
   * The free, server-exact token counter on the Anthropic-shaped endpoint.
   * px carries no local tokenizer — a local estimate that drifts from billing
   * is worse than no estimate, and this one costs nothing.
   */
  async countTokens(model: string, system: string, messages: unknown[], tools: unknown[]): Promise<number> {
    const res = await fetch(`${BASE}/anthropic/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, system, messages, tools }),
    });
    if (!res.ok) throw new PxError("BAD_REQUEST", `count_tokens ${res.status}: ${await res.text()}`);
    const j: any = await res.json();
    return Number(j.input_tokens ?? 0);
  }

  private async fetchWithRetry(path: string, body: string): Promise<Response> {
    let attempt = 0;
    for (;;) {
      attempt++;
      let res: Response;
      try {
        res = await fetch(BASE + path, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.opts.apiKey}`,
            "content-type": "application/json",
          },
          body,
        });
      } catch (e) {
        if (attempt >= 3) throw new PxError("NETWORK", `network failure after ${attempt} attempts: ${e}`);
        await sleep(backoffMs(attempt));
        continue;
      }

      if (res.ok) return res;

      const text = await res.text();
      if (res.status === 429) {
        if (attempt >= 5) throw new PxError("RATE_LIMIT", `rate limited after ${attempt} attempts: ${text}`);
        const retryAfter = Number(res.headers.get("retry-after") ?? 0) * 1000;
        await sleep(retryAfter || backoffMs(attempt));
        continue;
      }
      if (res.status >= 500) {
        if (attempt >= 3) throw new PxError("SERVER_ERROR", `${res.status} after ${attempt} attempts: ${text}`);
        await sleep(backoffMs(attempt));
        continue;
      }
      if (res.status === 400 && /maximum context length/i.test(text)) {
        throw new PxError("CONTEXT_OVERFLOW", text);
      }
      // Every other 4xx is a px bug, not a transient fault. Fail loudly.
      throw new PxError("BAD_REQUEST", `${res.status}: ${text}`);
    }
  }
}

/**
 * The truncation trap, which is deterministic rather than occasional.
 *
 * With thinking on, reasoning is emitted before content and eats max_tokens
 * first. The response comes back 200, fully billed, finish_reason=length, with
 * an empty content field and a populated reasoning_content. A harness shipping
 * a Claude-typical max_tokens of 4096 produces this on essentially every call.
 * Retrying blind doubles the bill, so px names it and retries with thinking off.
 */
function classifyResponse(r: StreamResult): void {
  if (r.finishReason === "length" && r.content === "" && r.toolCalls.length === 0) {
    throw new PxError(
      "TRUNCATED_EMPTY",
      `max_tokens consumed entirely by reasoning (${r.usage.reasoningTokens} reasoning tokens, no content). ` +
        `Salvaged reasoning is available in detail.`,
      r.reasoningContent,
    );
  }
}

function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withAbsoluteDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PxError("INACTIVITY_TIMEOUT", `request exceeded ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}
