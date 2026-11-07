/**
 * SSE parsing for DeepSeek's OpenAI-compatible stream.
 *
 * Two behaviours here are not optional, both observed live:
 *  - The server may hold a connection for up to ten minutes before inference
 *    starts, padding with blank lines and `:` comment frames. A parser that
 *    treats either as end-of-stream truncates a request that was about to
 *    succeed, and a total-request timeout kills it outright. px uses an
 *    inactivity timeout on token deltas instead.
 *  - Tool-call arguments arrive as fragments across deltas, keyed by index.
 *    They are accumulated into a string buffer and never parsed until the call
 *    is complete, because the raw string is what gets replayed into history.
 */

import type { RawToolCall, StreamResult, Usage } from "../types.ts";

export interface SseHandlers {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCallStart?: (index: number, name: string) => void;
}

interface PartialCall {
  id: string;
  name: string;
  args: string;
}

export async function consumeStream(
  res: Response,
  handlers: SseHandlers,
  inactivityMs: number,
  startedAt: number,
): Promise<StreamResult> {
  if (!res.body) throw new Error("stream response had no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let content = "";
  let reasoning = "";
  let finishReason = "";
  let modelEchoed = "";
  let ttfbMs = 0;
  const calls = new Map<number, PartialCall>();
  let usage: Usage = { hitTokens: 0, missTokens: 0, outputTokens: 0, reasoningTokens: 0 };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let kick: () => void = () => {};
  const idle = new Promise<never>((_, reject) => {
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => reject(new Error(`no stream activity for ${Math.round(inactivityMs / 1000)}s`)),
        inactivityMs,
      );
    };
    kick = arm;
    arm();
  });

  try {
    for (;;) {
      const next = await Promise.race([reader.read(), idle]);
      if (next.done) break;
      kick();
      buffer += decoder.decode(next.value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);

        if (line === "") continue; // keep-alive padding, not end-of-stream
        if (line.startsWith(":")) continue; // comment frame, same
        if (!line.startsWith("data:")) continue;

        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          buffer = "";
          break;
        }

        let evt: any;
        try {
          evt = JSON.parse(data);
        } catch {
          continue; // partial frame; the next read completes it
        }

        if (evt.model) modelEchoed = evt.model;
        if (evt.usage) usage = readUsage(evt.usage);

        const choice = evt.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (!delta) continue;

        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          if (!ttfbMs) ttfbMs = Date.now() - startedAt;
          reasoning += delta.reasoning_content;
          handlers.onReasoning?.(delta.reasoning_content);
        }
        if (typeof delta.content === "string" && delta.content) {
          if (!ttfbMs) ttfbMs = Date.now() - startedAt;
          content += delta.content;
          handlers.onText?.(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx: number = tc.index ?? 0;
          let cur = calls.get(idx);
          if (!cur) {
            cur = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
            calls.set(idx, cur);
            if (cur.name) handlers.onToolCallStart?.(idx, cur.name);
          }
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }

  const toolCalls: RawToolCall[] = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } }));

  return {
    content: scrubToolTags(content),
    toolCalls,
    finishReason,
    modelEchoed,
    usage,
    reasoningContent: reasoning,
    ttfbMs,
    wallMs: Date.now() - startedAt,
  };
}

/**
 * OpenAI-endpoint usage semantics: prompt_tokens is INCLUSIVE of the cache hit,
 * and prompt_tokens_details.cached_tokens duplicates the hit again. Reading all
 * three and adding them overstates input by roughly 2.5x, which would make
 * every efficiency claim in this project unfalsifiable. Read exactly these.
 */
export function readUsage(u: any): Usage {
  const hit = Number(u.prompt_cache_hit_tokens ?? 0);
  const missReported = u.prompt_cache_miss_tokens;
  const miss = missReported !== undefined ? Number(missReported) : Math.max(0, Number(u.prompt_tokens ?? 0) - hit);
  return {
    hitTokens: hit,
    missTokens: miss,
    outputTokens: Number(u.completion_tokens ?? 0),
    reasoningTokens: Number(u.completion_tokens_details?.reasoning_tokens ?? 0),
  };
}

/**
 * Raw tool-call markup leaked into user-visible content in 2 of 90 trials,
 * across three different tag families. Cheap to scrub unconditionally.
 */
export function scrubToolTags(text: string): string {
  return text
    .replace(/<\/?tool_calls?>/g, "")
    .replace(/<\/?function_call>/g, "")
    .replace(/<\/?invoke[^>]*>/g, "")
    .trimEnd();
}
