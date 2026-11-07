# px

A coding agent built for DeepSeek's pricing and failure modes rather than ported onto them.

Every general-purpose harness treats the provider as an interchangeable text
endpoint. DeepSeek is not one. Its prefix cache is automatic, byte-exact, and
prices a hit at 2% of a miss; its thinking mode emits reasoning tokens *before*
content and bills them at output rate; its API silently aliases model ids and
silently discards images on one of its two SKUs. None of that is visible through
a provider abstraction, and all of it decides what a session costs and whether
it works. px is what you get when those behaviours are the load-bearing design
input instead of a compatibility layer's problem.

The measurable consequence: a 30-turn session costs **$0.0149** off-peak, against
roughly $0.075 for the same work on a harness that hasn't been tuned for this
provider, and roughly $0.48 at Claude-class rates. Section 5 shows the
arithmetic.

---

## 1. Quick start

```sh
bun install
```

Put a key in `~/.px/env` (see `.px/env.example` for every variable px reads):

```sh
mkdir -p ~/.px
printf 'PX_DEEPSEEK_API_KEY=sk-...\n' > ~/.px/env
chmod 600 ~/.px/env
```

**Use a dedicated DeepSeek key.** px writes every call to a local SQLite ledger,
and the only independent check on that arithmetic is your account balance. If
the key is shared with a chat client or another agent, the balance moves for
reasons px cannot see, every discrepancy becomes unattributable, and the ledger
turns into a number you have to take on faith. Keys are free; mint a second one.

Then:

```sh
bun run doctor                      # probe the live API against every assumption px encodes
bun link                            # put `px` on PATH (package.json maps it to bin/px.ts)
px run "make the failing auth test pass"
px land px/<taskId>                 # git merge --ff-only the finished branch
```

`bun install` alone does not create the `px` binary — nothing depends on this
package, so nothing links it. Skip `bun link` and spell every command
`bun run bin/px.ts <cmd>` instead; the two are the same entry point.

The full surface:

| Command | What it does |
|---|---|
| `px run "<task>"` | Work to a verified verdict in a fresh worktree. Exit 0 only on `passed`. |
| `px chat [message]` | Interactive session, same tools, same worktree. **No verdict.** |
| `px land <branch>` | `git merge --ff-only` a finished px branch into your checkout. |
| `px cost [days=7]` | Spend by day, lane and cache tier, from the local ledger. |
| `px doctor` | Live contract probe against `api.deepseek.com`. |
| `px eval [--tasks ...]` | Golden-task regression suite. |

Flags: `--in-place` (edit the current checkout instead of a worktree — this
gives up the containment in section 6, so it is opt-in), `--keep` (keep the
worktree even on failure), `--budget <usd>`, `--quiet`, `--verbose`.

`px doctor` exists because everything in section 7 is a *measurement*, not a
documented guarantee. It re-probes the SKU ceilings, the cache quantum, the
model-echo aliases, and the peak-hour clock, and tells you which ones have
moved. Run it before you trust a cost number you didn't just observe.

`px land` is fast-forward only, never a merge commit and never a rebase. px is
not allowed to resolve a conflict on your behalf or to rewrite history it did
not author. If the parent branch moved, the answer is "rebase it yourself or run
me again", not an automatic merge.

---

## 2. Three zones, and why the body is a string

The request body is assembled by byte concatenation in `src/wire/body.ts`. It is
never produced by `JSON.stringify` over a request object. That looks like
premature micro-optimization and is not.

DeepSeek's prefix cache matches on **exact bytes**, quantized to 128 tokens. A
hit on flash costs `$0.003/M` against `$0.15/M` for a miss — a 50x spread on the
single largest line item in an agent's bill, since an agent re-sends its entire
conversation every turn. Anything that perturbs a byte anywhere in the prefix
invalidates everything downstream of it. And a `JSON.stringify` of an object
puts key order at the mercy of whoever last added a field.

So the prompt is split into three zones, and each has exactly one rule:

| Zone | Contents | Lifetime | Rule |
|---|---|---|---|
| **A** | effort marker, system prompt, tools array | frozen at boot, hashed, re-asserted every turn | contains nothing volatile |
| **B** | the conversation, as immutable `Frag`s | append-only | never re-serialized after creation |
| **C** | cwd, branch, UTC clock, peak flag, budget, todos, verify status | rebuilt every turn | always last |

**Zone A is frozen.** `freezeZoneA` takes a SHA-256 over
`model + effort + toolsJson + systemJson` at boot, and `assertZoneAIntact`
re-derives it on every send *and* checks that both byte strings appear verbatim
in the assembled body. This catches the one class of cache break the API will
never tell you about: drift that leaves `prompt_tokens` identical. The usage
payload cannot distinguish "the tools array key order changed" from "everything
is fine." Two real examples from development:

- Appending a tool at the end of the array instead of in sorted position:
  hit collapsed from **20,224 to 3,328 tokens**, about 98% of the cache gone,
  `prompt_tokens` unchanged.
- Two semantically identical tool arrays with different JSON key order: same
  `prompt_tokens`, hit down from **20,224 to 3,200**.

That is why `src/wire/canon.ts` sorts object keys recursively and emits no
whitespace, and why `canonTools` sorts the array by tool name. Sorting rather
than a hand-maintained key order means a new field cannot silently reorder a
sibling and break the prefix for the rest of the session.

**Zone B is append-only and never re-serialized.** A `Frag` is constructed once
from the exact bytes that will be sent for the remainder of the session, and the
class exposes no accessor returning a parsed object. That is structural, not
stylistic: re-serialization is precisely the failure mode being guarded against,
so it is made impossible rather than merely discouraged. Tool-call `arguments`
in particular are replayed as the raw string the stream produced — parsing and
re-stringifying would normalize whitespace and key order, which is a cache break
with no visible symptom.

**Zone C absorbs everything volatile.** The measured cost of getting this wrong:
leaking a single Zone C value into Zone A drove the session hit rate from
**86.0% to 25.3%** — a 4.8x increase in input cost that *widens* as the
conversation grows, because a larger prefix means more tokens re-billed at miss
rate every turn. Zone C is free in return: the trailing 128–255 tokens fall
outside the cached region on flash regardless, since the hit is computed as
`128 * floor(pt/128) - 128`, leaving `(pt mod 128) + 128` uncached. The
sub-quantum remainder is never cacheable, so you may as well spend it on state
the model actually needs.

`Session.account()` closes the loop at runtime. It compares each turn's miss
tokens against the size of the tail that was just appended; a miss much larger
than the new tail means something above Zone C changed bytes, and it warns and
records a cache-break row. Without that check a broken prefix is invisible until
the bill arrives.

One more guard lives in `Session.init()`: a **cache canary**. Two byte-identical
minimal requests go out at boot, and if the second reports a zero hit, px aborts
rather than running an hour at 50x. The canary buys no latency — a hit and a
miss return in the same time — and costs about $0.0001. Its entire value is the
assertion.

---

## 3. Lanes: reasoning effort is a namespace, not a dial

The thinking marker sits at serialized position 0 of the prefix, and the KV
cache is not shared across SKUs. Reasoning effort is therefore **not a parameter
you tune per call** — it is a cache namespace. Changing it mid-session forfeits
the entire prefix. On a 200K-token context that is 200,000 × $0.66/M = **$0.132
of re-prefill** before a single token comes back, which is roughly nine times
the whole reference session, spent on nothing. ($0.66/M is `v4-pro`'s miss rate,
the worst case — the same forfeit on a flash session re-prefills at $0.15/M, so
$0.030, still twice the reference session.)

So a px session pins exactly one lane, and `assertLanePinned` fails loudly if
anything tries to change it. Three lanes exist (`src/lanes/policy.ts`):

| Lane | Model | Effort | temp | max_tokens | Share of calls |
|---|---|---|---|---|---|
| **E** | `deepseek-flash` | `"none"` | 0 | 16,384 | ~97% |
| **R** | `deepseek-flash` | `"low"` | omitted | 32,768 | consult only |
| **R-pro** | `deepseek-v4-pro` | `"low"` | omitted | 32,768 | second escalation only |

Lane E turns thinking **off**, which buys four things at once:

1. No hidden input preamble. Thinking-on adds +26 tokens on flash and +79 on
   pro to *every single request*.
2. No reasoning tokens billed at full output rate.
3. Legal forced `tool_choice`. Forcing a tool is a hard 400 whenever thinking is
   enabled — so the whole verification gate below depends on thinking being off.
4. A working `temperature`. The server ignores it when thinking is on. At
   temperature 0, tool arguments come back byte-identical, which is what makes
   golden tests of the wire format possible at all.

"omitted" in the temp column is `temperature: null`, and `LaneConfig` allows the
same `null` for `reasoningEffort` — in both cases the field is left out of the
body entirely rather than sent with a default. An omitted `reasoning_effort` is a
**different prefix** from `"minimal"`: not the same namespace, not the same
cache. No lane currently uses it, and adding one that does would be a fourth
namespace, not a variant of an existing one.

### consult() bridges; it does not escalate in place

When the loop needs more depth, it does not raise its own effort. It calls
`consult(question, evidence, depth)`, which opens a **separate, ephemeral
conversation** on Lane R (or R-pro), carrying only the question and the evidence
fragments it was handed. The answer comes back as an ordinary tool result
appended to Zone B.

The session's own prefix never moves. The expensive lane never sees the full
conversation, so it is billed on a few thousand tokens rather than two hundred
thousand. And because the answer arrives as a tool result in the append-only
tail, everything above it stays cached. The alternative — bumping effort on the
live session — pays the full re-prefill *and* keeps paying it, because the
session is now in the other namespace.

Lane R-pro is pinned to `"low"` permanently, and this is a measurement rather
than caution: at medium and above, `deepseek-v4-pro` ran **84–315 seconds per
call and produced 2.5–3x less content** than flash with thinking off. It is a
depth tool for a specific hard question, not a quality dial to turn up.

`max_tokens` on both reasoning lanes is deliberately large. See section 7 on the
truncation trap — this is the single most expensive way to misconfigure a
DeepSeek harness.

---

## 4. The verification contract

**The model's "I'm done" is a request. The machine owns the verdict.**

This is the part that is not about cost. A coding agent that decides for itself
whether it succeeded will report success, because reporting success is the
cheapest available token sequence. px never asks.

The contract, in order:

1. **Worktree isolation.** Every `px run` gets a dedicated git worktree under
   `PX_WORKTREE_ROOT`, on its own branch. The agent's `root` is that directory,
   and `confinePath` resolves symlinks before checking containment, so a symlink
   inside the worktree pointing at `~/.ssh` does not pass a naive prefix test.
   Your working tree is never touched.

2. **Baseline before the first edit.** The verify command runs once against the
   unmodified worktree, before the agent is allowed to change anything, and the
   set of failing tests is recorded. Without this you cannot distinguish "the
   agent broke the build" from "the build was already broken," and an agent that
   can't distinguish those will claim credit for the second.

3. **Exit code AND failing-set delta.** `passed` requires both: the command
   exits 0, and nothing that passed at baseline fails now. The second half is
   what an exit-code check misses — a change that fixes the target test while
   breaking two others exits 0 on a narrow command and would be certified as
   success. A test failing in both runs is noise; a newly failing test is a
   regression and blocks regardless of what the agent claims it fixed.

   A repo that was already red and is still red after three attempts reports
   **`partial`**, not `passed`, and names how many baseline failures went away.
   That distinction exists because a red baseline is the normal case for this
   tool, and "removed two failures, introduced none, suite still red" is real
   information. It is still not success: only `passed` means exit 0. The full
   outcome set is `passed`, `partial`, `blocked`, `budget`, `error`, and every
   one but `passed` exits non-zero.

4. **The gate replaces the finish.** When the model calls its finish tool, the
   verify command runs. If the delta is not clean, px does not send a new user
   message scolding it — it **replaces the finish tool's result in place** with
   the failing output (`Session.replaceLastToolResult`). The conversation stays
   append-only, the prefix stays cached, and from the model's side its own
   attempt to stop simply returned "not yet, here is what broke." Rejections are
   counted into `RunResult.verifyRejects`, so a run that needed four attempts is
   visibly different from one that needed none.

### px run refuses to start without a verify command

`resolveVerifyCommand` looks for `.px/verify.toml` first (see
`.px/verify.toml.example`), then infers from the file tree: `package.json`
`scripts.test`, a `test_*.py`/`*_test.py` within two levels, `Cargo.toml`,
`go.mod`, a `Makefile` with a `test:` target. Explicit beats inferred, and the
resolved source is printed so you can see which one fired.

The pytest rung wants a collectable *file*, not a `tests/` directory, and that
narrowing is load-bearing: `tests/` is also where Cargo puts integration tests,
so the directory heuristic resolved every idiomatic Rust crate to `pytest`,
which exits 5 — "no tests ran" — identically before and after the edit. Matching
failing sets, empty delta, real suite never run. An inference that cannot fail
is worse than none.

If none match it returns **null rather than a default**, and `px run` **exits
before the first API call**. This is not a warning. A guessed command that exits
0 for the wrong reason is worse than no verification at all, and an unattended
agent with no verifier is a text generator that edits your files. The contract
above is the only thing that makes autonomy defensible.

One honest limit: `regressed()` compares *named* failures, so if the post-edit
run fails to build, its failing set is empty and the delta is empty too. Empty
means "no new named failures", never "safe to land" — the exit code is a
separate field on `VerifyResult` for exactly this reason, and a non-zero exit
blocks regardless. A runner px cannot parse degrades the gate to an exit-code
check; `.px/verify.toml.example` lists the line shapes it recognizes.

**`px chat` carries no such guarantee.** It is interactive, there is a human
reading the output, and that human is the verifier. Nothing in chat mode
enforces a baseline, a delta, or a gate. Do not read a clean `px chat` session as
having passed anything — it has not been checked. If you want the contract, use
`px run`.

---

## 5. Cost

The reference session: 30 turns on Lane E, a context growing from roughly 6K to
30K tokens, 86% measured hit rate, thinking off so zero reasoning tokens.

**Per turn**, at 18,000 mean prompt tokens and 120 output tokens:

| | tokens | rate | cost |
|---|---:|---:|---:|
| cache hit | 15,480 | $0.003/M | $0.0000464 |
| cache miss | 2,520 | $0.15/M | $0.0003780 |
| output | 120 | $0.60/M | $0.0000720 |
| | | **per turn** | **$0.000496** |

**30 turns off-peak: $0.0149** (30 × $0.00049644).

Peak is exactly **2x** — Monday through Friday, 01:00–04:00 and 06:00–10:00 UTC.
That is 35 of 168 hours a week. The same session inside those windows costs
**$0.0298**. In UTC+8 peak lands on 09:00–12:00 and 14:00–18:00, i.e.
squarely on the working day, so deferrable work (repo indexing, doc sweeps,
nightly review) is literally half price if it waits. `src/schedule/offpeak.ts`
computes this, and the current multiplier is rendered into Zone C every turn so
the model can see it too.

### Comparison

Identical token counts throughout — this is a comparison of **rates and cache
behaviour**, not of model capability, and it says nothing about how many turns
each system would actually need.

| | 30-turn session | vs px | what drives it |
|---|---:|---:|---|
| **px, Lane E, off-peak** | **$0.0149** | 1x | 86% hit rate, thinking off |
| px, Lane E, peak | $0.0298 | 2x | the 2x multiplier, nothing else |
| Unconfigured harness on the same SKU | ~$0.075 | ~5x | cache collapse + thinking left on |
| Claude-class rates *(unverified)* | ~$0.48 | ~32x | list price, warm cache |

**The unconfigured row** is two effects stacked. The cache half is measured: one
volatile value in Zone A took the hit rate from 86.0% to 25.3%, which is 4.8x on
input and brings the session to $0.063 on its own. The rest is thinking left at
its default effort, which adds reasoning tokens billed at the full $0.60/M
output rate; at a few hundred per turn that lands the total near $0.075. The
cache figure is measured, the reasoning-token component is an estimate — it
depends entirely on how much the model chooses to think.

**The Claude-class row is UNVERIFIED.** It uses commonly cited Sonnet-class list
prices ($3/M input, $15/M output, $0.30/M cache read, $3.75/M cache write)
applied to the same token counts, assuming a perfectly warm cache: 15,480 tokens
cache-read at $0.30/M, the 2,520 new prefix tokens cache-*written* at $3.75/M,
120 output at $15/M — $0.015894 a turn, **$0.4768** over 30, or 32x. The $3/M
uncached-input rate never applies under that assumption, which is what "perfectly
warm" buys. Treat the ratio as an order of magnitude, not a quote. Two
caveats push it the other way and are worth naming: the default cache TTL there
is around five minutes, so an interactive session with human pauses re-writes
the prefix at $3.75/M rather than reading it at $0.30/M — real sessions land
worse than this row, not better. Re-derive it from current published prices
before citing it anywhere.

Every call px makes is written to a SQLite ledger with its hit/miss/output
split, the peak flag, the Zone A hash, and the cost. The ledger is the claim;
your account balance on a dedicated key is the audit.

---

## 6. Safety model

The containment boundary is **the worktree**, not a permission prompt per
action.

A prompt-per-action model has a well-known failure: the human approves the first
forty prompts, learns that approval is a formality, and approves the forty-first
without reading it. The prompts train the operator to click yes. px takes the
other route — the agent works inside a git worktree it owns, ordinary edits need
no approval at all, and the blast radius of any mistake is one
`git worktree remove --force`. Your branch, your working tree, and your
uncommitted changes are never in reach.

What `src/agent/safety.ts` denies is therefore a short list: the actions that
*escape* that containment.

- `confinePath` resolves every model-supplied path, following symlinks first,
  and refuses anything that lands outside the worktree root.
- `checkCommand` refuses: `sudo`; `rm -rf /`; every `git push` (pushing is the
  user's call, not the agent's) and force-push specifically; `git reset --hard`
  and `git clean -f` (they destroy work that isn't committed yet);
  `git worktree remove` (px owns worktree lifecycle); `curl | sh`;
  `shutdown`/`reboot`; `launchctl`/`systemctl`; `dd if=`; `mkfs`; `chmod 777`;
  and redirects onto raw block devices.
- `truncateOutput` caps tool output at 400 lines, head and tail with an explicit
  marker. This is a cost control as much as a safety one — tool output is the
  second-largest token sink after the conversation — and the marker matters
  because a model that knows material was dropped will narrow its own command
  instead of hallucinating the middle.

Two things this model does **not** claim. It is not a sandbox: a command inside
the worktree can still reach the network and still read files it is not supposed
to want. And the deny list is a set of regexes over command strings, which is a
speed bump against an agent doing something dumb, not a defence against one
deliberately trying to get out. The security property px actually provides is
that *your repository state is unreachable*, and that property comes from git,
not from pattern matching.

---

## 7. Appendix: measured facts, with dates

Everything below was probed live against the API on the date shown. None of it
is a documented guarantee, and the design depends on all of it. Re-probe with
`px doctor` before assuming any of it still holds.

**Measured 2026-09-11:**

| Fact | Value | Where it bites |
|---|---|---|
| SKUs | `deepseek-flash`, `deepseek-v4-pro` | `provider/models.ts` |
| Context window | 1,048,576 tokens, both SKUs | not the binding constraint |
| `max_tokens` ceiling | 393,216, both SKUs | lane config |
| Prefix cache | automatic, byte-exact, 128-token quantum | the entire zone design |
| Cache hit formula | flash: `max(0, 128*floor(pt/128) - 128)`; pro has no `-128` | `predictedHit`, drift alarms |
| Cache hit price | 2% of a miss on flash ($0.003/M vs $0.15/M) | why the prefix is sacred |
| Per-request cache-write cap | 128,000 tokens | sets compaction at 120,000, *not* the 1M window |
| Peak multiplier | exactly 2x, Mon–Fri 01:00–04:00 and 06:00–10:00 UTC | `schedule/offpeak.ts` |
| Thinking default | ON, effort `high` | the trap below |
| **Truncation trap** | reasoning tokens precede content and consume `max_tokens` first. 18/18 trials at `max_tokens` 256/1024/4096 returned `finish_reason=length`, `completion_tokens == reasoning_tokens`, **empty content, fully billed** | `classifyResponse` names it `TRUNCATED_EMPTY`; a blind retry doubles a bill already spent |
| Thinking-on input preamble | +26 tokens (flash), +79 (pro), every request | part of why Lane E is `"none"` |
| Forced `tool_choice` + thinking | hard 400 | the verify gate requires thinking off |
| `temperature` with thinking on | silently ignored | golden tests need thinking off |
| Tool-result invariant | **bidirectional**: ids in the last assistant message must exactly equal the ids of the tool messages after it. Missing 400s, extra 400s | `assertToolResultInvariant`; a timeout or Ctrl-C must still synthesize a result |
| Tool-name charset | `^[a-zA-Z0-9_-]+$`; dots and colons 400 | `canonTools` validates before sending |
| Model-id aliasing | silent, and inconsistent between endpoints — `deepseek-reasoner` returns **Flash**, not Pro | `assertModelEcho`; a silent downgrade looks exactly like success |
| Images on `deepseek-v4-pro` | accepted with **HTTP 200**, silently discarded, answered confidently about an image never seen (green PNG → "Red"). Token accounting proves the drop: 11 prompt tokens for 64×64 and 1024×1024 alike, vs flash's 190 and 658 | `supportsVision: false`; client-side refusal is the only defence |
| `v4-pro` at effort ≥ medium | 84–315s per call, 2.5–3x **less** content than flash with thinking off | R-pro pinned to `"low"` |
| Usage payload semantics | `prompt_tokens` is **inclusive** of the hit, and `prompt_cache_hit_tokens` duplicates it. Summing all three overstates input ~2.5x | `readUsage` reads exactly three fields |
| `cache_creation_input_tokens` | always 0 — there is no cache-write premium to optimize | nothing to tune |
| Inert request fields | `cache_control`, `prompt_cache_key`, `prompt_cache_retention` accepted and ignored; `strict: true` ignored on production tool defs; `parallel_tool_calls` accepted and ignored | gate parallelism client-side; documented in `wire/body.ts` |
| Pre-inference stall | server may hold a connection **up to 10 minutes**, padding with blank lines and `:` comment frames | a total-request timeout kills a request that was about to succeed; px uses a 120s *inactivity* timeout |
| Tool-call argument fragmentation | arguments arrive across deltas, keyed by index | accumulated as a string, never parsed until complete |
| Tool-markup leakage | raw tool tags appeared in user-visible content in **2 of 90** trials, across three tag families | `scrubToolTags`, unconditional |
| Tool-argument whitespace drift | ~80% of calls, zero semantic change | edit anchors must match on normalized whitespace |
| Unified diff as an edit format | **disqualified**: applied cleanly but edited the *wrong duplicate* in **7 of 44** trials | px does not use diff-based edits |
| Free server-exact token counter | `POST /anthropic/v1/messages/count_tokens` | px carries no local tokenizer; a drifting local estimate is worse than none |

**OPEN — not measured, do not assume:**

- **Cache TTL beyond ~45 minutes.** Hits were confirmed at 45 minutes. Anything
  longer is unknown. If the real TTL is short, resuming a session after a lunch
  break costs a full re-prefill and the reference cost number does not apply to
  resumed work.
- **Peak-hour hit rates.** All cache measurements were taken off-peak. Whether
  the hit rate itself (as opposed to the price) changes under peak load has not
  been tested. If it degrades, the peak penalty is worse than 2x.
- **429 behaviour.** No rate limit was ever triggered during probing, so the
  headers, the `retry-after` semantics, and the actual thresholds are all
  unverified. `client.ts` retries 429 five times with exponential backoff and
  honours `retry-after` if present — that policy is a guess against an untested
  surface.

---

## 8. Layout

| File | What it owns |
|---|---|
| `src/types.ts` | Shared types. `ToolDef`, `ToolContext`, `Usage`, `StreamResult`, `PxError`/`ErrorClass`, `RunResult`. Source of truth; imported, never redeclared. |
| `src/config.ts` | `loadConfig()`. Env only, no config DSL. `~/.px/env` < project `.px/env` < process env. |
| `src/wire/canon.ts` | The byte authority. `cjson` (recursive key sort, no whitespace), `canonTools` (name-sorted, charset-validated), the per-role canonicalizers, `sha256`. |
| `src/wire/frag.ts` | `Frag`: an immutable message, bytes only, no parsed accessor. `assertToolResultInvariant`. |
| `src/wire/body.ts` | `buildBody` by string concatenation with a frozen key order. `freezeZoneA` / `assertZoneAIntact`. `buildTail` renders all of Zone C. |
| `src/wire/sse.ts` | Stream parsing. Survives blank-line and `:` keep-alives, accumulates fragmented tool arguments, `readUsage` (exactly three fields), `scrubToolTags`. |
| `src/lanes/policy.ts` | `LANE_E` / `LANE_R` / `LANE_R_PRO` and `assertLanePinned`. Effort as a cache namespace. |
| `src/provider/models.ts` | `MODELS` facts table, `costUsd`, `predictedHit`, `assertModelEcho` against the alias map. |
| `src/provider/client.ts` | HTTP, no SDK (an SDK would re-serialize the body). Error taxonomy, retry policy, `classifyResponse`'s `TRUNCATED_EMPTY`, free `countTokens`. |
| `src/schedule/offpeak.ts` | `isPeak` / `nextOffPeak` / `priceMultiplier`, and local wall-clock rendering for the status line. |
| `src/agent/safety.ts` | `confinePath` (symlink-resolving), `checkCommand` deny list, `truncateOutput`. |
| `src/agent/session.ts` | One pinned lane, one frozen Zone A, one append-only Zone B. Cache canary at boot, telescoping cache-anomaly check per turn, half-at-once compaction, `replaceLastToolResult` for the verify gate. |
| `src/agent/prompt.ts` | The Zone A system prompt, as frozen bytes. Editing it invalidates the prefix for every existing session — which is fine, as long as it is not done per-session or per-repo. |
| `src/agent/loop.ts` | `runTask`. Flat ReAct with verification as a terminal precondition rather than a stage — a stage machine would split one prefix into several, each re-paying its own cold prefill (~11% more per attempt). |
| `src/agent/chat.ts` | `runChat`. Same loop, same tools, same worktree; a human supplies the next instruction and there is no verdict. One session means one prefix, which is why chat is the cheapest way to work. |
| `src/agent/dispatch.ts` | One turn's tool calls. Every `tool_call_id` gets a result even on crash, timeout or refusal; reads run concurrently, mutations in order (the API ignores `parallel_tool_calls`, so the gate lives here). |
| `src/agent/consult.ts` | The escalation bridge. Opens a small side conversation on Lane R / R-pro with its own prefix; R-pro only when the flash answer fails a structural check. |
| `src/agent/guards.ts` | Three independent stops: no-progress detection, a step ceiling, a spend ceiling. Hashes tool calls through `cjson` so the ~80% whitespace drift doesn't defeat repeat detection. |
| `src/verify/verify.ts` | `resolveVerifyCommand` (explicit over inferred, null over guessed), `runVerify` (CI=1, NO_COLOR=1, 300s hang timeout, bounded output), `parseFailing` per runner, `regressed` set difference. |
| `src/worktree/worktree.ts` | One `git worktree` on a `px/<taskId>` branch per task. `land` is fast-forward only — never a merge commit, never a rebase. |
| `src/tools/registry.ts` | `buildRegistry()`: no arguments, no branches. The serialized tools array is inside the frozen prefix, so a set that varies by turn changes bytes at a fixed offset and destroys everything behind it. Membership matters; order does not, because `canonTools` sorts. |
| `src/tools/read.ts` | `read`, taking a *list* of paths. N single-file reads cost N turns and N cache appends, all re-sent forever; one call with a list is strictly fewer bytes. |
| `src/tools/edit.ts` | Anchored replacement with a three-rung matching ladder (exact → trailing whitespace → leading indent). No similarity fuzzing: a fuzzy match landing one line off is worse than a clean failure, because the model cannot see it happened. |
| `src/tools/write.ts` | New files and full rewrites, refused past 400 lines — a full rewrite of a large file is how a model quietly deletes code it never read, and the diff looks intentional. |
| `src/tools/grep.ts` | ripgrep with flag translation and a result cap. An uncapped search result is a four-figure token spend the model then reads twice. |
| `src/tools/ls.ts` | `git ls-files` first, plain walk only outside a repo. Listing `node_modules` into the context window is the cheapest way to waste five figures of tokens. |
| `src/tools/bash.ts` | The escape hatch. Named `bash` because across 180 trials that was the *only* tool name the model ever hallucinated — so the guess is a hit. A non-zero exit is not an error: the model needs to read failing test output. |
| `src/tools/finish.ts` | `finish`. Records the model's claim and hands it to the loop; it decides nothing. Named `finish` rather than `done` so the asymmetry is legible in the transcript — the model asks, the harness answers with section 4. |
| `src/tools/todo.ts` | The agent's own plan, held in a module store rather than the prompt. It changes almost every turn, so it is rendered into Zone C; splicing it into the system prompt would put a mutating span at serialized position 0. |
| `src/ledger/ledger.ts` | The falsifiability layer. Writes every call unconditionally and never summarizes at write time — aggregation is a query, because a number you cannot re-derive from raw rows is one you cannot audit. |
| `src/ledger/schema.sql` | Ledger tables: per-call rows with hit/miss/output split, peak flag, Zone A hash, cost; plus cache-break records. |
| `scripts/doctor.ts` | Re-measures the assumptions that would break px *silently*. A moved cache quantum doesn't error, it triples the bill; a forced `tool_choice` that starts working under thinking doesn't error, it just means the lane pin stopped being load-bearing. |
| `src/ui/render.ts` | Terminal output. A streaming log, not a differential TUI — the artifact is a scrollable trace. `quiet` for scripts. |
| `bin/px.ts` | CLI entry. Warns when you start a run inside a peak window, and prints the `px land` line on success. |
| `test/wire.test.ts` | Golden tests over the canonical bytes — possible only because Lane E's temperature 0 makes tool arguments reproducible. |
| `test/guards.test.ts` | Loop-guard behaviour, including whitespace-invariant call hashing. |
| `test/verify.test.ts` | Command resolution, the runner (hang → exit 124, `CI=1`), `parseFailing` per runner, and the worktree round trip including `land`'s refusals on a dirty or diverged parent. |
| `test/edit.test.ts` | The three matching rungs, duplicate-anchor refusal, atomicity, and the structured not-found error the model has to act on. |
| `test/tools.test.ts` | Every registered tool end to end, plus registry membership and the sequential/concurrent execution modes `dispatch.ts` gates on. |
| `test/ledger.test.ts` | Schema, `sessionTotals`, `expectedMiss`, cache anomalies, and the `px cost` summary. |
| `test/doctor.test.ts` | `runDoctor`'s offline path: every check states an expectation, and nothing on the output path echoes the API key. |

---

## 9. Not built yet

`bunx tsc --noEmit` is the authority on what is actually wired — any module it
reports as unresolved is one the layout table above describes but that has not
landed. At the time of writing that is `eval/run.ts` alone, so `px eval` is
specified in `bin/px.ts` and not yet runnable. Everything else the CLI advertises
resolves.

Genuine feature gaps, independent of the build state:

- **No eval *runner*.** The golden tasks exist — `eval/tasks/` holds
  `t01-single-fail`, `t02-multi-rename` and `t05-vacuous-assert`, each a fixture
  repo, a reference solution, and a `task.json` stating the defect and the
  plausible wrong answers it discriminates against. What is missing is
  `eval/run.ts`, the harness that drives them. So none of the cost figures in
  section 5 come from a suite you can re-run; they are development probes. Treat
  the reference session as a well-founded estimate, not a benchmark result — and
  note that it says nothing about *how many turns* px needs versus anything
  else, which is the number that would actually decide a bake-off.
- **No session resume.** A session is one process. This is also why the cache
  TTL question in section 7 stays open: without resume there is no way to
  observe what a cold-ish prefix costs after a lunch break, and the reference
  cost number therefore applies only to uninterrupted work.
- **No sandbox.** Section 6 is explicit about this. Containment is the worktree
  and nothing else — a command px runs still has the network and still has your
  filesystem outside the deny list.
- **No multi-repo or multi-worktree concurrency.** One task, one worktree, one
  process. Two `px run`s against the same repo have not been thought about.
- **No cost prediction.** px reports what a run *did* cost. It will not tell you
  what a task is going to cost before you start it, and given how much that
  depends on turn count, it probably shouldn't pretend to.
- **Vision is refused, not routed.** `deepseek-v4-pro` silently discards images
  (section 7), so px refuses them client-side on that SKU. It does not
  transparently re-route an image-bearing request to flash.
