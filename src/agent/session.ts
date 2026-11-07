/**
 * A session: one pinned lane, one frozen ZONE A, one append-only ZONE B.
 *
 * Everything that mutates lives in ZONE C, which is rebuilt every turn and sits
 * last. That split is the whole cost model: the prefix above ZONE C stays byte
 * identical from turn to turn, so it is priced at $0.003/M instead of $0.15/M.
 */

import { assertToolResultInvariant, Frag } from "../wire/frag.ts";
import { assertZoneAIntact, buildBody, buildTail, freezeZoneA, type ZoneA } from "../wire/body.ts";
import { canonTools, sha256 } from "../wire/canon.ts";
import { DeepSeekClient } from "../provider/client.ts";
import { costUsd, predictedHit } from "../provider/models.ts";
import { isPeak } from "../schedule/offpeak.ts";
import { assertLanePinned, type LaneConfig } from "../lanes/policy.ts";
import { PxError, type RawToolCall, type StreamResult, type ToolContext, type ToolDef } from "../types.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { Ui } from "../ui/render.ts";

export interface SessionOpts {
  client: DeepSeekClient;
  ledger: Ledger;
  ui: Ui;
  tools: ToolDef[];
  systemPrompt: string;
  lane: LaneConfig;
  /** Worktree the agent is confined to. */
  root: string;
  repoRoot: string;
  sessionId: string;
  taskId: string;
  budgetUsd: number;
  compactAtTokens: number;
}

export interface TurnState {
  branch: string;
  dirtyCount: number;
  lastExitCode?: number;
  verifyStatus?: string;
  todos: { id: string; text: string; status: string }[];
  notes: string[];
}

export class Session {
  readonly frags: Frag[] = [];
  private zoneA!: ZoneA;
  private spent = 0;
  private hitTotal = 0;
  private missTotal = 0;
  private lastPromptTokens = 0;
  private callCount = 0;
  /** Byte size of everything sent last turn, for the telescoping check below. */
  private bytesAtSend = 0;
  private bytesAtLastSend = 0;

  constructor(private readonly o: SessionOpts) {}

  get spentUsd(): number {
    return this.spent;
  }

  get hitRate(): number {
    const t = this.hitTotal + this.missTotal;
    return t === 0 ? 0 : this.hitTotal / t;
  }

  get calls(): number {
    return this.callCount;
  }

  /**
   * Freeze ZONE A and prove the cache is actually working before spending a
   * session's worth of tokens on the assumption that it is.
   *
   * The canary is two identical minimal requests. If the second reports a zero
   * cache hit, something in ZONE A is non-deterministic and every turn from
   * here would be billed at 50x. Better to abort at $0.0001 than to bleed for
   * an hour. Note the canary buys no latency — a hit and a miss return in the
   * same time. Its entire value is this assertion.
   */
  async init(): Promise<void> {
    const toolsJson = canonTools(this.o.tools);
    const systemFrag = Frag.system(this.o.systemPrompt);
    this.zoneA = await freezeZoneA(toolsJson, systemFrag, this.o.lane);

    const probeTail = Frag.user("ok");
    const body = buildBody({
      zoneA: this.zoneA,
      lane: { ...this.o.lane, maxTokens: 1 },
      frags: [],
      tail: probeTail,
      stream: false,
    });

    let second: StreamResult | undefined;
    for (let i = 0; i < 2; i++) {
      try {
        second = await this.o.client.complete(body, this.o.lane);
      } catch (e) {
        // max_tokens 1 with thinking off returns a length finish and empty
        // content, which classifyResponse flags. For the canary that is fine:
        // all we need is the usage line.
        if (e instanceof PxError && e.cls === "TRUNCATED_EMPTY") continue;
        throw e;
      }
    }

    if (second && second.usage.hitTokens === 0 && second.usage.missTokens > 256) {
      throw new Error(
        "cache canary failed: two byte-identical requests both missed the prefix cache. " +
          "ZONE A is not deterministic — every turn would be billed at cache-miss rates (50x). " +
          "Run `px doctor` before continuing.",
      );
    }
    this.o.ui.debug(`cache canary ok (hit ${second?.usage.hitTokens ?? 0} tokens), ZONE A ${this.zoneA.sha.slice(0, 12)}`);
  }

  /** One model call. Returns the assistant turn; does not dispatch tools. */
  async call(userText: string, state: TurnState, forceTool?: string): Promise<StreamResult> {
    assertLanePinned(this.o.lane, this.o.lane);

    const now = new Date();
    const tail = Frag.user(
      buildTail({
        userText,
        cwd: this.o.root,
        branch: state.branch,
        dirtyCount: state.dirtyCount,
        nowUtc: now.toISOString(),
        peak: isPeak(now),
        budgetRemainingUsd: Math.max(0, this.o.budgetUsd - this.spent),
        todos: state.todos,
        lastExitCode: state.lastExitCode,
        verifyStatus: state.verifyStatus,
        notes: state.notes,
      }),
    );

    assertToolResultInvariant(this.frags);
    this.bytesAtSend = this.frags.reduce((n, f) => n + f.byteLength, 0) + tail.byteLength;

    const body = buildBody({
      zoneA: this.zoneA,
      lane: this.o.lane,
      frags: this.frags,
      tail,
      forceTool,
      stream: true,
    });
    await assertZoneAIntact(body, this.zoneA, this.o.lane);

    const result = await this.o.client.stream(body, this.o.lane, {
      onText: (d) => this.o.ui.streamText(d),
      onToolCallStart: (_i, name) => this.o.ui.toolStart(name),
    });

    this.account(result, tail, forceTool ? 1 : 0);

    // ZONE B grows here and never anywhere else.
    this.frags.push(tail);
    this.frags.push(Frag.assistant(result.content, result.toolCalls));
    return result;
  }

  appendToolResult(toolCallId: string, content: string): void {
    this.frags.push(Frag.toolResult(toolCallId, content));
  }

  /**
   * Replace the last tool result. Used when the verification gate rejects a
   * finish: the model asked to stop, the machine says no and hands back the
   * failing output in the same slot, so the conversation stays append-only.
   */
  replaceLastToolResult(toolCallId: string, content: string): void {
    const last = this.frags[this.frags.length - 1];
    if (!last || last.kind !== "tool") throw new Error("replaceLastToolResult called with no tool result on top");
    this.frags.pop();
    this.frags.push(Frag.toolResult(toolCallId, content));
  }

  private account(r: StreamResult, tail: Frag, forcedTokens: number): void {
    const peak = isPeak(new Date());
    const cost = costUsd(this.o.lane.model, r.usage, peak);
    this.spent += cost;
    this.hitTotal += r.usage.hitTokens;
    this.missTotal += r.usage.missTokens;
    this.callCount++;

    const expected = this.lastPromptTokens === 0 ? 0 : predictedHit(this.o.lane.model, this.lastPromptTokens);
    this.lastPromptTokens = r.usage.hitTokens + r.usage.missTokens;

    this.o.ledger.recordCall({
      ts_utc: new Date().toISOString(),
      session_id: this.o.sessionId,
      task_id: this.o.taskId,
      lane: this.o.lane.name,
      model_requested: this.o.lane.model,
      model_echoed: r.modelEchoed,
      hit_tok: r.usage.hitTokens,
      miss_tok: r.usage.missTokens,
      out_tok: r.usage.outputTokens,
      reasoning_tok: r.usage.reasoningTokens,
      expected_miss_tok: Math.max(0, this.lastPromptTokens - expected),
      peak: peak ? 1 : 0,
      cost_usd: cost,
      prefix_sha: this.zoneA.sha,
      finish_reason: r.finishReason,
      error_class: null,
      ttfb_ms: r.ttfbMs,
      wall_ms: r.wallMs,
      n_tool_calls: r.toolCalls.length,
    });

    // The telescoping check: over a conversation, the sum of miss tokens should
    // approximate its final prompt size, so any single turn should only miss on
    // what was actually appended since the previous send. That is the whole
    // tail of new bytes — the previous tail, the assistant turn, and every tool
    // result — not just the current ZONE C block, which is what made this alarm
    // fire on any turn that read a file. Anything beyond that means bytes
    // changed above ZONE C, and this is the only place it becomes visible.
    const appendedTokens = Math.ceil(Math.max(0, this.bytesAtSend - this.bytesAtLastSend) / 4) + forcedTokens;
    this.bytesAtLastSend = this.bytesAtSend;
    if (expected > 0 && r.usage.missTokens > appendedTokens + 512) {
      this.o.ui.warn(
        `cache anomaly: ${r.usage.missTokens} miss tokens for ~${appendedTokens} tokens of appended text. ` +
          `Something above the append point changed bytes.`,
      );
      this.o.ledger.recordCacheBreak({
        ts_utc: new Date().toISOString(),
        session_id: this.o.sessionId,
        zone: "B",
        expected_sha: this.zoneA.sha,
        actual_sha: "",
        detail: `miss=${r.usage.missTokens} appended~=${appendedTokens}`,
      });
    }
  }

  /**
   * Compaction, triggered by the per-request cache-write cap rather than by the
   * context window.
   *
   * A request can only write 128,000 tokens into the cache at once, so a
   * session above that re-warms in ceil(pt/128000) near-full-price prefills
   * every time it resumes. Below it, one request re-warms everything. That cap,
   * not the 1M window, is what makes 120,000 the right threshold.
   *
   * The oldest half goes in a single chunk, replaced by one summary at the head
   * of ZONE B. Trimming a little every turn would be the volatile-prefix
   * failure mode wearing a different hat.
   */
  async compactIfNeeded(summarize: (frags: Frag[]) => Promise<string>): Promise<boolean> {
    const approxTokens = this.frags.reduce((n, f) => n + f.byteLength, 0) / 4;
    if (approxTokens < this.o.compactAtTokens) return false;

    const cut = Math.floor(this.frags.length / 2);
    // Never cut in the middle of an assistant/tool pair: the invariant is
    // bidirectional and a dangling tool result is a hard 400.
    let split = cut;
    while (split < this.frags.length && this.frags[split]!.kind === "tool") split++;

    const dropped = this.frags.slice(0, split);
    const summary = await summarize(dropped);
    this.frags.splice(0, split, Frag.summary(summary));
    this.o.ui.warn(`compacted ${dropped.length} fragments into one summary (~${Math.round(approxTokens)} tokens)`);
    return true;
  }

  toolContext(consult: ToolContext["consult"]): ToolContext {
    return {
      root: this.o.root,
      budgetUsd: this.o.budgetUsd,
      spentUsd: () => this.spent,
      consult,
      log: (l) => this.o.ui.debug(l),
    };
  }

  async fingerprint(): Promise<string> {
    return sha256(this.frags.map((f) => f.json).join(""));
  }
}

/** Parsed view of a tool call, used only for execution. Never replayed. */
export function parseArgs(tc: RawToolCall): Record<string, unknown> {
  if (!tc.function.arguments.trim()) return {};
  try {
    return JSON.parse(tc.function.arguments) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`tool ${tc.function.name} produced unparseable arguments: ${(e as Error).message}`);
  }
}
