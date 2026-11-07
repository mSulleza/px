/**
 * Wire-layer tests. These are the ones that must never go red: every claim px
 * makes about cost depends on the bytes below being stable.
 */

import { describe, expect, test } from "bun:test";

import { canonTools, cjson, sha256 } from "../src/wire/canon.ts";
import { assertToolResultInvariant, Frag } from "../src/wire/frag.ts";
import { buildBody, buildTail, freezeZoneA } from "../src/wire/body.ts";
import { consumeStream, readUsage, scrubToolTags } from "../src/wire/sse.ts";
import { LANE_E } from "../src/lanes/policy.ts";
import { costUsd, predictedHit } from "../src/provider/models.ts";
import { isPeak, nextOffPeak } from "../src/schedule/offpeak.ts";
import type { ToolDef } from "../src/types.ts";

const tool = (name: string, extra: Record<string, unknown> = {}): ToolDef => ({
  name,
  description: `does ${name}`,
  parameters: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"], ...extra },
  executionMode: "concurrent",
  run: async () => ({ content: "" }),
});

describe("canonical serialization", () => {
  test("key order never leaks into the bytes", () => {
    const a = cjson({ z: 1, a: { d: 4, c: [1, { y: 2, x: 1 }] } });
    const b = cjson({ a: { c: [1, { x: 1, y: 2 }], d: 4 }, z: 1 });
    expect(a).toBe(b);
  });

  test("1000 shuffled rebuilds of the same tool set produce one hash", async () => {
    const names = ["read", "edit", "bash", "grep", "finish", "todo"];
    const hashes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const shuffled = [...names].sort(() => (i % 3) - 1);
      const tools = shuffled.map((n) => tool(n));
      hashes.add(await sha256(canonTools(tools)));
    }
    expect(hashes.size).toBe(1);
  });

  test("a description edit does change the bytes", () => {
    const before = canonTools([tool("read")]);
    const after = canonTools([{ ...tool("read"), description: "does read (v2)" }]);
    expect(before).not.toBe(after);
  });

  test("illegal and duplicate tool names are refused before the API 400s", () => {
    expect(() => canonTools([tool("a.b")])).toThrow(/illegal/);
    expect(() => canonTools([tool("read"), tool("read")])).toThrow(/duplicate/);
  });
});

describe("fragments", () => {
  test("assistant arguments are replayed as the raw string, not re-serialized", () => {
    const raw = '{"b":2,  "a":"x"}'; // deliberately odd spacing and key order
    const f = Frag.assistant("", [{ id: "call_1", type: "function", function: { name: "read", arguments: raw } }]);
    expect(f.json).toContain(JSON.stringify(raw).slice(1, -1));
  });

  test("tool-result invariant catches both directions", () => {
    const asst = Frag.assistant("", [
      { id: "a", type: "function", function: { name: "read", arguments: "{}" } },
      { id: "b", type: "function", function: { name: "grep", arguments: "{}" } },
    ]);
    expect(() => assertToolResultInvariant([asst, Frag.toolResult("a", "x"), Frag.toolResult("b", "y")])).not.toThrow();
    expect(() => assertToolResultInvariant([asst, Frag.toolResult("a", "x"), Frag.user("next")])).toThrow(/unanswered/);
    expect(() =>
      assertToolResultInvariant([asst, Frag.toolResult("a", "x"), Frag.toolResult("b", "y"), Frag.toolResult("c", "z")]),
    ).toThrow(/unknown id/);
  });

  test("mid-dispatch state is legal", () => {
    const asst = Frag.assistant("", [{ id: "a", type: "function", function: { name: "read", arguments: "{}" } }]);
    expect(() => assertToolResultInvariant([asst])).not.toThrow();
  });
});

describe("body assembly", () => {
  test("ZONE A bytes appear verbatim and the tail is last", async () => {
    const zoneA = await freezeZoneA(canonTools([tool("read")]), Frag.system("SYS"), LANE_E);
    const body = buildBody({ zoneA, lane: LANE_E, frags: [Frag.user("one")], tail: Frag.user("two"), stream: true });
    expect(body).toContain(zoneA.toolsJson);
    expect(body).toContain('"reasoning_effort":"none"');
    expect(body).toContain('"stream_options":{"include_usage":true}');
    expect(body.indexOf(Frag.user("two").json)).toBeGreaterThan(body.indexOf(Frag.user("one").json));
    expect(() => JSON.parse(body)).not.toThrow();
  });

  test("the prefix is byte-identical as the conversation grows", async () => {
    const zoneA = await freezeZoneA(canonTools([tool("read")]), Frag.system("SYS"), LANE_E);
    const one = buildBody({ zoneA, lane: LANE_E, frags: [], tail: Frag.user("t1"), stream: true });
    const two = buildBody({
      zoneA,
      lane: LANE_E,
      frags: [Frag.user("t1"), Frag.assistant("ok", [])],
      tail: Frag.user("t2"),
      stream: true,
    });
    const shared = one.slice(0, one.indexOf(Frag.user("t1").json));
    expect(two.startsWith(shared)).toBe(true);
  });

  test("forcing a tool appends past the shared prefix rather than rewriting it", async () => {
    const zoneA = await freezeZoneA(canonTools([tool("read")]), Frag.system("SYS"), LANE_E);
    const plain = buildBody({ zoneA, lane: LANE_E, frags: [], tail: Frag.user("t"), stream: false });
    const forced = buildBody({ zoneA, lane: LANE_E, frags: [], tail: Frag.user("t"), forceTool: "finish", stream: false });
    expect(forced).toContain('"tool_choice":{"function":{"name":"finish"},"type":"function"}');
    expect(plain).toContain('"tool_choice":"auto"');
  });

  test("the volatile state block carries the things ZONE A must never contain", () => {
    const tail = buildTail({
      userText: "do the thing",
      cwd: "/tmp/wt",
      branch: "px/t-1",
      dirtyCount: 2,
      nowUtc: "2026-09-11T00:00:00.000Z",
      peak: true,
      budgetRemainingUsd: 0.1234,
      todos: [{ id: "1", text: "fix it", status: "doing" }],
      lastExitCode: 1,
      verifyStatus: "exit 1, 2 failing",
    });
    expect(tail).toContain("PEAK");
    expect(tail).toContain("px/t-1");
    expect(tail).toContain("[doing] 1 fix it");
    expect(tail).toContain("do the thing");
  });
});

describe("sse", () => {
  function sseResponse(frames: string[]): Response {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    });
    return new Response(body);
  }

  test("comment frames and blank lines are not end-of-stream", async () => {
    const r = await consumeStream(
      sseResponse([
        ": keep-alive\n\n",
        '\n\ndata: {"model":"deepseek-flash","choices":[{"delta":{"content":"he"}}]}\n',
        'data: {"choices":[{"delta":{"content":"llo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":300,"prompt_cache_hit_tokens":256,"prompt_cache_miss_tokens":44,"completion_tokens":2}}\n',
        "data: [DONE]\n",
      ]),
      {},
      5000,
      Date.now(),
    );
    expect(r.content).toBe("hello");
    expect(r.finishReason).toBe("stop");
    expect(r.usage.hitTokens).toBe(256);
    expect(r.usage.missTokens).toBe(44);
  });

  test("tool-call arguments are reassembled from fragments in index order", async () => {
    const r = await consumeStream(
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ths\\":[\\"a.ts\\"]}"}}]}}]}\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"grep","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n',
        "data: [DONE]\n",
      ]),
      {},
      5000,
      Date.now(),
    );
    expect(r.toolCalls.map((t) => t.id)).toEqual(["c1", "c2"]);
    expect(r.toolCalls[0]!.function.arguments).toBe('{"paths":["a.ts"]}');
  });

  test("usage is read without triple counting", () => {
    const u = readUsage({
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 896,
      prompt_cache_miss_tokens: 104,
      prompt_tokens_details: { cached_tokens: 896 },
      completion_tokens: 50,
    });
    expect(u.hitTokens + u.missTokens).toBe(1000);
    expect(u.outputTokens).toBe(50);
  });

  test("leaked tool markup is scrubbed", () => {
    expect(scrubToolTags("done <tool_call> x </tool_call>")).toBe("done  x");
  });
});

describe("pricing", () => {
  test("flash cache formula matches the measured quantum", () => {
    expect(predictedHit("deepseek-flash", 908)).toBe(768);
    expect(predictedHit("deepseek-flash", 1048)).toBe(896);
    expect(predictedHit("deepseek-v4-pro", 1048)).toBe(1024);
  });

  test("a cache hit is priced at 2% of a miss on flash, and peak doubles both", () => {
    const hit = costUsd("deepseek-flash", { hitTokens: 1_000_000, missTokens: 0, outputTokens: 0, reasoningTokens: 0 }, false);
    const miss = costUsd("deepseek-flash", { hitTokens: 0, missTokens: 1_000_000, outputTokens: 0, reasoningTokens: 0 }, false);
    expect(hit).toBeCloseTo(0.003, 6);
    expect(miss).toBeCloseTo(0.15, 6);
    expect(miss / hit).toBeCloseTo(50, 3);
    const peak = costUsd("deepseek-flash", { hitTokens: 0, missTokens: 1_000_000, outputTokens: 0, reasoningTokens: 0 }, true);
    expect(peak).toBeCloseTo(0.3, 6);
  });

  test("peak window is weekdays only, in UTC", () => {
    expect(isPeak(new Date("2026-09-11T02:00:00Z"))).toBe(true); // Friday 02:00 UTC
    expect(isPeak(new Date("2026-09-11T05:00:00Z"))).toBe(false); // the gap between windows
    expect(isPeak(new Date("2026-09-12T02:00:00Z"))).toBe(false); // Saturday
    expect(nextOffPeak(new Date("2026-09-11T02:00:00Z")).toISOString()).toBe("2026-09-11T04:00:00.000Z");
  });
});
