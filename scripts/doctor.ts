#!/usr/bin/env bun
/**
 * px doctor — the live contract probe.
 *
 * Every number in src/provider/models.ts, every branch in src/wire/sse.ts and
 * the entire reason Lane E exists were measured against a live endpoint on
 * 2026-09-11. None of it is documented by the vendor, so none of it is a
 * promise. This file re-measures the assumptions that would break px silently
 * if they changed — silently being the operative word: a cache quantum that
 * moves does not error, it just triples the bill; a forced tool_choice that
 * starts working under thinking does not error, it just means the lane pin is
 * no longer load-bearing.
 *
 * One line per check, measured value next to the expectation, non-zero exit on
 * any break. Roughly 17 HTTP calls and well under a cent per run.
 *
 * Probes go through DeepSeekClient wherever the client's shapes fit. Two do
 * not, and both exceptions are deliberate:
 *   - GET /models has no client method (the client only ever POSTs chat).
 *   - The thinking-on truncation probe must read `usage` off a response that
 *     the client converts into a TRUNCATED_EMPTY throw, discarding it. That
 *     throw is correct for the loop and useless here, so doctor reads the raw
 *     body once and derives two checks from it.
 */

import { loadConfig } from "../src/config.ts";
import { LANE_E, LANE_R_PRO, type LaneConfig } from "../src/lanes/policy.ts";
import { DeepSeekClient } from "../src/provider/client.ts";
import { MODELS, assertModelEcho, costUsd, predictedHit } from "../src/provider/models.ts";
import { isPeak } from "../src/schedule/offpeak.ts";
import { PxError, type ToolDef } from "../src/types.ts";
import { canonTools, cjson } from "../src/wire/canon.ts";
import { Frag } from "../src/wire/frag.ts";
import { readUsage } from "../src/wire/sse.ts";

export interface DoctorCheck {
  name: string;
  expected: string;
  actual: string;
  ok: boolean;
  note?: string;
}

export interface DoctorOptions {
  /** Build the full check list without touching the network. Used by tests. */
  skipLive?: boolean;
  /** Streamed progress: a live run takes ~30s and silence reads as a hang. */
  onCheck?: (c: DoctorCheck) => void;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
  /** What this run actually cost, priced through costUsd at the current clock. */
  spentUsd: number;
}

/** Mirrors src/provider/client.ts, which does not export it. */
const BASE = "https://api.deepseek.com";

const SKIPPED = "(skipped: offline)";

/**
 * The client cares about exactly two fields of a lane here: `model`, which it
 * feeds to assertModelEcho, and the pricing it implies. Everything else in the
 * probe bodies is written by hand, because several checks send shapes the
 * lane/body layer deliberately cannot express (tool_choice "required", a
 * max_tokens over the ceiling, a model id that is not a ModelId).
 */
const FLASH_LANE: LaneConfig = LANE_E;
const PRO_LANE: LaneConfig = LANE_R_PRO;

/** A one-token answer keeps output cost off the measurement of input behaviour. */
const TINY = "Reply with exactly: x";

/** 70-byte 1x1 PNG. Smallest thing that is unambiguously a real image. */
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Never executed. Doctor only needs the tool to exist on the wire. */
const PROBE_TOOL: ToolDef = {
  name: "px_doctor_echo",
  description: "Echo the given text back verbatim.",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "Text to echo." } },
    required: ["text"],
  },
  executionMode: "concurrent",
  run: async () => ({ content: "" }),
};

const TOOLS_JSON = canonTools([PROBE_TOOL]);

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

interface Probe {
  model: string;
  maxTokens: number;
  /** Omitted entirely when undefined — which is the thinking-ON default, and a
   *  different prefix from any explicit value. See LaneConfig.reasoningEffort. */
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
  temperature?: number;
  /** Pre-canonicalized message fragments, joined verbatim. */
  messages: string[];
  toolsJson?: string;
  /** Raw JSON fragment: `"auto"`, `"required"`, or a function object. */
  toolChoice?: string;
}

/**
 * Build a probe body by concatenation, same as src/wire/body.ts.
 *
 * The cache checks depend on two sends producing byte-identical prompts, so
 * the body must be a pure function of its inputs. Concatenation gives that for
 * free and, unlike buildBody, lets doctor emit shapes the loop must never emit.
 */
function probeBody(p: Probe): string {
  return [
    `{"model":${JSON.stringify(p.model)}`,
    `,"max_tokens":${p.maxTokens}`,
    p.reasoningEffort === undefined ? "" : `,"reasoning_effort":${JSON.stringify(p.reasoningEffort)}`,
    p.temperature === undefined ? "" : `,"temperature":${p.temperature}`,
    `,"stream":false`,
    p.toolChoice ? `,"tool_choice":${p.toolChoice}` : "",
    p.toolsJson ? `,"tools":${p.toolsJson}` : "",
    `,"messages":[${p.messages.join(",")}]}`,
  ].join("");
}

interface RawChat {
  model?: string;
  usage?: Record<string, unknown>;
  choices?: { finish_reason?: string; message?: { content?: string; reasoning_content?: string } }[];
}

/**
 * Raw POST. Only used where the client's error taxonomy destroys the measurement.
 *
 * `text` comes back alongside the parse because a bare status is not a finding:
 * "thinking probe returned 400" and "thinking probe returned 400 because
 * max_tokens is out of range" are the same line to a reader who cannot see the
 * body, and this probe deliberately has no client to fold the body into a throw.
 */
async function rawPost(
  apiKey: string,
  path: string,
  body: string,
): Promise<{ status: number; json: RawChat; text: string }> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body,
  });
  const text = await res.text();
  let json: RawChat = {};
  try {
    json = JSON.parse(text) as RawChat;
  } catch {
    // Leave it empty; the caller reports the status and the body, which is the finding.
  }
  return { status: res.status, json, text: redact(text) };
}

/** Words are deliberately short and common: ~1 token each, so length is predictable. */
const WORDS = [
  "alpha", "beta", "gamma", "delta", "north", "south", "east", "west",
  "river", "stone", "cable", "meter", "index", "layer", "queue", "frame",
  "token", "cache", "prefix", "window", "ledger", "branch", "commit", "worker",
  "signal", "packet", "buffer", "cursor", "anchor", "matrix", "vector", "kernel",
];

/** Deterministic filler. The bytes must be stable so two sends share a prefix. */
function filler(words: number, seed = 0x5eed_1234): string {
  let s = seed >>> 0;
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0; // LCG; any PRNG works, determinism is the point
    out.push(WORDS[s % WORDS.length]!);
  }
  return out.join(" ");
}

function promptTokens(u: { hitTokens: number; missTokens: number }): number {
  // prompt_tokens is inclusive of the hit; see readUsage in src/wire/sse.ts.
  return u.hitTokens + u.missTokens;
}

/**
 * Error bodies echo the credential back. DeepSeek's own auth failure reads
 * `Your api key: ****abcd is invalid`, and doctor forwards response bodies into
 * notes that get printed and pasted into issues. Scrub on the way in and again
 * on the way out; neither pass is expensive and the failure mode is permanent.
 */
function redact(s: string): string {
  return s.replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-***").replace(/(api\s*key:\s*)\S+/gi, "$1***");
}

function errText(e: unknown): string {
  const raw = e instanceof PxError ? `${e.cls}: ${e.message}` : e instanceof Error ? e.message : String(e);
  return redact(raw);
}

// ---------------------------------------------------------------------------
// Check plumbing
// ---------------------------------------------------------------------------

interface Ctx {
  apiKey: string;
  client: DeepSeekClient;
  /** Canonical user frag for the ~1000-token cache probe, unique to this run. */
  bulkUser: string;
  /** Charged outside the client (raw probes), added to the run total by hand. */
  addCost: (usd: number) => void;
  /** Memoized thinking-on probe; checks 5 and 10 both read it. */
  thinkOn: () => Promise<ThinkProbe>;
}

interface ThinkProbe {
  status: number;
  pt: number;
  finish: string;
  content: string;
  reasoning: number;
  /** Redacted response body, non-empty only when the probe did not return 200. */
  errBody: string;
}

type CheckResult = { actual: string; ok: boolean; note?: string };

interface CheckSpec {
  name: string;
  expected: string;
  run: (ctx: Ctx) => Promise<CheckResult>;
}

const CHECKS: CheckSpec[] = [
  {
    name: "model-inventory",
    expected: `GET /models == [${Object.keys(MODELS).sort().join(", ")}]`,
    async run(ctx) {
      const res = await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${ctx.apiKey}` } });
      if (!res.ok) return { actual: `HTTP ${res.status}`, ok: false };
      const j = (await res.json()) as { data?: { id?: string }[] };
      const ids = (j.data ?? []).map((m) => m.id ?? "").sort();
      const want = Object.keys(MODELS).sort();
      const ok = ids.length === want.length && ids.every((id, i) => id === want[i]);
      // The inventory is vendor-controlled and unbounded; render at most a
      // handful so one surprising day cannot produce a thousand-column line.
      const shown = ids.length > 8 ? `${ids.slice(0, 8).join(", ")}, +${ids.length - 8} more` : ids.join(", ");
      return {
        actual: `[${shown}]`,
        ok,
        // A new SKU is not a failure of the code, but MODELS has no facts for it
        // and every lane is pinned to a name, so it needs a human either way.
        note: ok ? undefined : "inventory moved: MODELS and the lane pins need re-measuring, not just editing",
      };
    },
  },

  {
    name: "max-tokens-ceiling",
    expected: `${MODELS["deepseek-flash"].maxTokensCeiling} accepted, +1 rejected 400 naming the range`,
    async run(ctx) {
      const ceiling = MODELS["deepseek-flash"].maxTokensCeiling;
      const msgs = [Frag.user(TINY).json];

      // A ceiling max_tokens is a reservation, not a charge: thinking is off, so
      // this answers in one token and costs the same as any other tiny call.
      let acceptOk = false;
      let acceptNote = "";
      try {
        const r = await ctx.client.complete(
          probeBody({ model: "deepseek-flash", maxTokens: ceiling, reasoningEffort: "none", temperature: 0, messages: msgs }),
          FLASH_LANE,
        );
        acceptOk = true;
        acceptNote = `finish=${r.finishReason}`;
      } catch (e) {
        // Bounded like every other captured body: a 4xx from this endpoint can
        // carry a multi-kilobyte echo of the request that made it.
        acceptNote = errText(e).slice(0, 120);
      }

      let rejectOk = false;
      let rejectNote = "";
      try {
        await ctx.client.complete(
          probeBody({ model: "deepseek-flash", maxTokens: ceiling + 1, reasoningEffort: "none", temperature: 0, messages: msgs }),
          FLASH_LANE,
        );
        rejectNote = "accepted (no 400)";
      } catch (e) {
        const msg = errText(e);
        // The client folds every non-retryable 4xx into BAD_REQUEST with the
        // status and body inlined, so the range text is still readable here.
        rejectOk =
          e instanceof PxError && e.cls === "BAD_REQUEST" && /\b400\b/.test(msg) && (/range/i.test(msg) || msg.includes(String(ceiling)));
        rejectNote = msg.slice(0, 120);
      }

      return {
        actual: `${ceiling} -> ${acceptOk ? "200" : "refused"}, ${ceiling + 1} -> ${rejectOk ? "400 (range named)" : "unexpected"}`,
        ok: acceptOk && rejectOk,
        note: acceptOk && rejectOk ? undefined : `accept: ${acceptNote} | reject: ${rejectNote}`,
      };
    },
  },

  {
    name: "cache-quantum",
    expected: "2nd send hits predictedHit(), a non-zero multiple of 128",
    async run(ctx) {
      const body = probeBody({
        model: "deepseek-flash",
        maxTokens: 64,
        reasoningEffort: "none",
        temperature: 0,
        messages: [ctx.bulkUser],
      });
      // Byte-identical sends. The only thing that can differ is the cache split.
      const a = await ctx.client.complete(body, FLASH_LANE);
      const b = await ctx.client.complete(body, FLASH_LANE);

      const pt = promptTokens(a.usage);
      const predicted = predictedHit("deepseek-flash", pt);
      const hit = b.usage.hitTokens;
      const ok = hit > 0 && hit % 128 === 0 && hit === predicted;
      return {
        actual: `hit=${hit} predicted=${predicted} pt=${pt}`,
        ok,
        note: ok
          ? undefined
          : "flash hit is max(0, 128*floor(pt/128) - 128). A change re-prices every session and nothing else reports it",
      };
    },
  },

  {
    name: "cache-namespace",
    expected: "same prompt bytes on v4-pro hit 0 (caches are per-SKU)",
    async run(ctx) {
      // Same messages the flash pair just cached; only the model field differs.
      const r = await ctx.client.complete(
        probeBody({ model: "deepseek-v4-pro", maxTokens: 64, reasoningEffort: "none", temperature: 0, messages: [ctx.bulkUser] }),
        PRO_LANE,
      );
      const hit = r.usage.hitTokens;
      return {
        actual: `hit=${hit} pt=${promptTokens(r.usage)}`,
        ok: hit === 0,
        note:
          hit === 0
            ? undefined
            : "a shared cache would make cross-SKU escalation free; consult() is priced assuming it is not",
      };
    },
  },

  {
    name: "thinking-default",
    expected: "omitting reasoning_effort adds a hidden prompt preamble (+26 on flash)",
    async run(ctx) {
      const on = await ctx.thinkOn();
      if (on.status !== 200) {
        return { actual: `thinking probe returned ${on.status}`, ok: false, note: on.errBody || "no response body" };
      }
      // Identical bytes either side of the only difference that matters: the
      // messages, the max_tokens and the absent temperature all match thinkOn().
      const off = await ctx.client.complete(
        probeBody({ model: "deepseek-flash", maxTokens: 256, reasoningEffort: "none", messages: [Frag.user(TINY).json] }),
        FLASH_LANE,
      );
      const ptOff = promptTokens(off.usage);
      const delta = on.pt - ptOff;
      const ok = delta > 0;
      return {
        actual: `+${delta} (thinking ${on.pt} vs none ${ptOff})`,
        ok,
        note: ok
          ? delta === 26
            ? undefined
            : "preamble size moved from the measured 26; harmless, but the prefix changed"
          : "no preamble delta: thinking may no longer be on by default, which changes what 'none' is opting out of",
      };
    },
  },

  {
    name: "forced-tool-choice",
    expected: 'tool_choice "required" 400s under thinking, 200s with reasoning_effort "none"',
    async run(ctx) {
      const msgs = [Frag.user("Echo the word ping using the tool.").json];

      let onStatus: string;
      try {
        const r = await ctx.client.complete(
          probeBody({ model: "deepseek-flash", maxTokens: 256, messages: msgs, toolsJson: TOOLS_JSON, toolChoice: '"required"' }),
          FLASH_LANE,
        );
        onStatus = `200 finish=${r.finishReason}`;
      } catch (e) {
        // TRUNCATED_EMPTY here means the request was ACCEPTED and then ate its
        // max_tokens on reasoning — a 200, not the 400 this check wants.
        //
        // BAD_REQUEST is the client's bucket for every non-retryable 4xx, so a
        // 401 from a dead key lands here too. Read the status out of the message
        // rather than assuming: "any 4xx counts as the expected 400" is how a
        // broken credential turns into a green contract check.
        onStatus =
          e instanceof PxError
            ? e.cls === "BAD_REQUEST"
              ? /\b400\b/.test(e.message)
                ? "400"
                : `4xx/${errText(e).slice(0, 40)}`
              : `200/${e.cls}`
            : errText(e).slice(0, 60);
      }

      const off = await ctx.client.complete(
        probeBody({
          model: "deepseek-flash",
          maxTokens: 256,
          reasoningEffort: "none",
          temperature: 0,
          messages: msgs,
          toolsJson: TOOLS_JSON,
          toolChoice: '"required"',
        }),
        FLASH_LANE,
      );

      const ok = onStatus === "400" && off.toolCalls.length > 0;
      return {
        actual: `thinking-on ${onStatus}, thinking-off 200 with ${off.toolCalls.length} tool call(s)`,
        ok,
        note: ok
          ? undefined
          : "this incompatibility is the reason the loop is pinned to Lane E; if it lifted, the pin is worth re-deciding",
      };
    },
  },

  {
    name: "model-echo-alias",
    expected: "deepseek-reasoner echoes a flash spelling, never v4-pro",
    async run(ctx) {
      // Requested through FLASH_LANE on purpose: complete() runs assertModelEcho
      // for us, so a pro echo throws MODEL_MISMATCH before this code resumes.
      const r = await ctx.client.complete(
        probeBody({ model: "deepseek-reasoner", maxTokens: 64, reasoningEffort: "none", temperature: 0, messages: [Frag.user(TINY).json] }),
        FLASH_LANE,
      );
      const echo = r.modelEchoed;
      let accepted = true;
      let why = "";
      try {
        assertModelEcho("deepseek-flash", echo);
      } catch (e) {
        accepted = false;
        why = errText(e).slice(0, 160);
      }
      // assertModelEcho returns early on an empty echo — correct for the loop,
      // where some frames legitimately omit the field, and wrong here: an absent
      // echo means this probe measured nothing, and a check that measured
      // nothing must not report PASS. It is the only signal px has that the
      // alias still resolves to flash.
      const ok = accepted && echo !== "" && echo !== "deepseek-v4-pro";
      return {
        actual: `echo=${echo || "(absent)"}`,
        ok,
        note: ok
          ? undefined
          : echo === ""
            ? "the response carried no model field, so the alias was not verified at all"
            : why || "an alias that now resolves to pro would bill 4.4x with no other symptom",
      };
    },
  },

  {
    name: "count-tokens-exact",
    expected: "count_tokens == hit + miss on the same payload",
    async run(ctx) {
      const sys = "You are a token accounting probe. Answer with one word.";
      const text = `Count this exactly. ${filler(40, 0xc0_ffee)}`;

      let counted: number;
      try {
        counted = await ctx.client.countTokens("deepseek-flash", sys, [{ role: "user", content: text }], []);
      } catch (e) {
        // Distinct failure from a disagreement: the counter refusing the payload
        // shape is a shim change, not a tokenizer drift.
        return { actual: "counter rejected the payload", ok: false, note: errText(e).slice(0, 200) };
      }

      // Two billed sends of the same payload: one on Lane E settings, one with
      // thinking left on. reasoning_effort is silently ignored on /anthropic,
      // so the counter always prices the payload as if thinking were enabled.
      // The exact invariant is therefore counted == billed-with-thinking, and
      // the gap to Lane E is the hidden preamble, which makes every px budget
      // conservative by that constant rather than wrong.
      const messages = [Frag.system(sys).json, Frag.user(text).json];
      const bill = async (effort: "none" | null): Promise<number> => {
        const { json } = await rawPost(
          ctx.apiKey,
          "/chat/completions",
          probeBody({
            model: "deepseek-flash",
            maxTokens: 32,
            ...(effort ? { reasoningEffort: effort, temperature: 0 } : {}),
            messages,
          }),
        );
        const usage = readUsage(json.usage ?? {});
        ctx.addCost(costUsd("deepseek-flash", usage, isPeak(new Date())));
        return promptTokens(usage);
      };

      const billedLaneE = await bill("none");
      const billedThinking = await bill(null);
      const ok = counted === billedThinking;
      return {
        actual: `counted=${counted} billed(thinking)=${billedThinking} billed(lane E)=${billedLaneE}`,
        ok,
        // px carries no local tokenizer precisely because this endpoint is exact
        // and free. A drift here means compaction is budgeting against fiction.
        note: ok
          ? `counter prices the thinking preamble, so Lane E budgets run ${billedThinking - billedLaneE} tokens conservative`
          : `off by ${billedThinking - counted} against a thinking-on send: compaction thresholds derive from this counter`,
      };
    },
  },

  {
    name: "pro-image-drop",
    expected: "v4-pro pt unchanged by an image block; flash pt rises on the same bytes",
    async run(ctx) {
      const textPart = { type: "text", text: "What colour is this image? One word." };
      const imagePart = { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1X1}` } };
      const textOnly = cjson({ role: "user", content: [textPart] });
      const withImage = cjson({ role: "user", content: [textPart, imagePart] });

      const send = async (model: "deepseek-flash" | "deepseek-v4-pro", msg: string): Promise<number> => {
        const r = await ctx.client.complete(
          probeBody({ model, maxTokens: 32, reasoningEffort: "none", temperature: 0, messages: [msg] }),
          model === "deepseek-flash" ? FLASH_LANE : PRO_LANE,
        );
        return promptTokens(r.usage);
      };

      const proBase = await send("deepseek-v4-pro", textOnly);
      const proImg = await send("deepseek-v4-pro", withImage);
      // The flash pair is the control. Without it, a payload the API rejected as
      // malformed would pass the pro assertion vacuously.
      const flashBase = await send("deepseek-flash", textOnly);
      const flashImg = await send("deepseek-flash", withImage);

      // The assertion is a ratio, not equality. v4-pro was once observed to bill
      // an image at exactly the text-only count; it now adds a handful of tokens.
      // Either way it is not ingesting the pixels — flash encodes the identical
      // bytes at roughly forty times the cost. What matters for px is that pro
      // will answer confidently about an image it cannot see, so the refusal in
      // MODELS.supportsVision stays until pro's delta approaches flash's.
      const proDelta = proImg - proBase;
      const flashDelta = flashImg - flashBase;
      const tokenized = flashDelta > 0;
      const dropped = tokenized && proDelta * 4 < flashDelta;
      return {
        actual: `pro +${proDelta} vs flash +${flashDelta} tokens for the same image bytes`,
        ok: dropped,
        note: !tokenized
          ? "flash did not tokenize the image either: the probe payload, not the SKU, is suspect"
          : dropped
            ? proDelta > 0
              ? `pro bills ${proDelta} tokens for an image it does not read — still refuse, still not vision`
              : undefined
            : "v4-pro now tokenizes images like flash: revisit MODELS.supportsVision and the client-side refusal",
      };
    },
  },

  {
    name: "truncation-determinism",
    expected: "thinking on, hard prompt, max_tokens 256 -> finish_reason length, empty content",
    async run(ctx) {
      // Deliberately a prompt that needs real reasoning. The hazard is not that
      // every thinking call truncates — a trivial prompt answers inside 256
      // tokens and returns normally. It is that a prompt worth thinking about
      // spends the whole budget before emitting one content token, and comes
      // back 200, fully billed, empty. Probing it with "say OK" tests nothing.
      const hard =
        "Write a thread-safe LRU cache with per-entry TTL expiry in Python. " +
        "Explain the eviction order and the locking strategy before the code.";
      const { status, json, text } = await rawPost(
        ctx.apiKey,
        "/chat/completions",
        probeBody({ model: "deepseek-flash", maxTokens: 256, messages: [Frag.user(hard).json] }),
      );
      const usage = readUsage(json.usage ?? {});
      ctx.addCost(costUsd("deepseek-flash", usage, isPeak(new Date())));
      const choice = json.choices?.[0];
      const r = {
        status,
        finish: choice?.finish_reason ?? "",
        content: (choice?.message?.content ?? "") as string,
        reasoning: usage.reasoningTokens,
        errBody: status === 200 ? "" : text.slice(0, 200),
      };
      const ok = r.status === 200 && r.finish === "length" && r.content === "";
      return {
        actual: `status=${r.status} finish=${r.finish} content=${r.content.length}ch reasoning=${r.reasoning}tok`,
        ok,
        // The whole PxError("TRUNCATED_EMPTY") branch exists for this. If it
        // stopped reproducing, that branch is now untested dead weight. A
        // non-200 says nothing about determinism, so report the body instead of
        // the standing verdict — the probe never ran.
        note: ok
          ? undefined
          : r.status !== 200
            ? `probe did not run (HTTP ${r.status}): ${r.errBody || "no response body"}`
            : "the TRUNCATED_EMPTY recovery path is built on this being deterministic, not occasional",
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runDoctor(apiKey: string, opts: DoctorOptions = {}): Promise<DoctorReport> {
  if (opts.skipLive) {
    const checks = CHECKS.map<DoctorCheck>((spec) => ({
      name: spec.name,
      expected: spec.expected,
      actual: SKIPPED,
      ok: true,
      note: "offline mode: nothing was measured",
    }));
    for (const c of checks) opts.onCheck?.(c);
    return { checks, ok: true, spentUsd: 0 };
  }

  if (!apiKey) throw new Error("runDoctor needs an API key; pass {skipLive:true} to build the check list offline");

  const peak = isPeak(new Date());
  let spentUsd = 0;
  const client = new DeepSeekClient({
    apiKey,
    onUsage: (r, lane) => {
      spentUsd += costUsd(lane.model, r.usage, peak);
    },
  });

  // A nonce at the HEAD of the cache probe, not the tail: a prefix cache keyed
  // on a trailing nonce would still hit from a previous doctor run, and then
  // the first send is not a true miss.
  const bulkUser = Frag.user(`px doctor cache probe ${crypto.randomUUID()}\n${filler(900)}\n${TINY}`).json;

  let thinkOnCache: Awaited<ReturnType<Ctx["thinkOn"]>> | undefined;
  const ctx: Ctx = {
    apiKey,
    client,
    bulkUser,
    addCost: (usd) => {
      spentUsd += usd;
    },
    thinkOn: async () => {
      if (thinkOnCache) return thinkOnCache;
      // Raw, because this response is exactly the one complete() turns into a
      // throw — and the throw carries reasoning_content but not usage.
      const body = probeBody({ model: "deepseek-flash", maxTokens: 256, messages: [Frag.user(TINY).json] });
      const { status, json, text } = await rawPost(apiKey, "/chat/completions", body);
      const usage = readUsage(json.usage ?? {});
      ctx.addCost(costUsd("deepseek-flash", usage, peak));
      const choice = json.choices?.[0];
      thinkOnCache = {
        status,
        pt: promptTokens(usage),
        finish: choice?.finish_reason ?? "",
        content: choice?.message?.content ?? "",
        reasoning: usage.reasoningTokens,
        errBody: status === 200 ? "" : text.slice(0, 200),
      };
      return thinkOnCache;
    },
  };

  const checks: DoctorCheck[] = [];
  for (const spec of CHECKS) {
    let check: DoctorCheck;
    try {
      const r = await spec.run(ctx);
      check = { name: spec.name, expected: spec.expected, actual: r.actual, ok: r.ok, note: r.note };
    } catch (e) {
      // One broken assumption must not hide the other nine.
      check = { name: spec.name, expected: spec.expected, actual: `threw`, ok: false, note: errText(e).slice(0, 240) };
    }
    checks.push(check);
    opts.onCheck?.(check);
  }

  return { checks, ok: checks.every((c) => c.ok), spentUsd };
}

/**
 * Notes often carry a raw error body; a stray newline would break the column.
 *
 * The cap is a backstop, not the budget: every check bounds what it captures.
 * It exists because the one that forgets will be a check reporting an unexpected
 * vendor response, i.e. exactly when the table needs to stay readable.
 */
const FIELD_MAX = 400;

function oneLine(s: string): string {
  const flat = redact(s.replace(/\s+/g, " ").trim());
  return flat.length > FIELD_MAX ? `${flat.slice(0, FIELD_MAX)}...(+${flat.length - FIELD_MAX} chars)` : flat;
}

/** One line per check, plus an indented note wherever something is off. */
export function formatChecks(checks: readonly DoctorCheck[]): string {
  const w = checks.reduce((m, c) => Math.max(m, c.name.length), 0);
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(w)}  expect ${oneLine(c.expected)}`);
    lines.push(`      ${" ".repeat(w)}  actual ${oneLine(c.actual)}`);
    if (c.note) lines.push(`      ${" ".repeat(w)}  note   ${oneLine(c.note)}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const offline = process.argv.includes("--offline");
  let key = "";
  if (!offline) {
    try {
      key = loadConfig().apiKey;
    } catch (e) {
      // loadConfig's message names the env var, never a value.
      console.error((e as Error).message);
      process.exit(2);
    }
  }

  // Streamed, because the live run is ~17 round trips and a silent 30 seconds
  // is indistinguishable from a hang.
  const report = await runDoctor(key, {
    skipLive: offline,
    onCheck: (c) => process.stderr.write(`${c.ok ? "PASS" : "FAIL"}  ${c.name}\n`),
  });

  console.log(formatChecks(report.checks));
  const failed = report.checks.filter((c) => !c.ok).length;
  // "10/10 passed" under --offline would read as a verified contract. Nothing
  // was measured, so say that instead of reporting a score nobody earned.
  console.log(
    offline
      ? `\n${report.checks.length} checks listed, 0 measured — --offline makes no requests`
      : `\n${report.checks.length - failed}/${report.checks.length} passed  spend $${report.spentUsd.toFixed(5)}` +
          (isPeak(new Date()) ? "  (PEAK 2x)" : ""),
  );
  process.exit(report.ok ? 0 : 1);
}
