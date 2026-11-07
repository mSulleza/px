# px-verify

px's verification gate, as a DeepSeek Harness plugin.

When the harness decides a turn is over, this runs the repository's own test
command in the session workspace. If it fails, the turn does not close: the
model is steered back with the failing output. The machine owns the verdict.

The model is never allowed to say "done". It is allowed to produce a diff, and a
real command decides whether that diff stands.

---

## The seam

One listener, on `agent/turn-stopping` — the harness's own "the model owes no
response, the turn is about to close" extension point:

```ts
ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => { … })
```

It is dispatched with `await dispatch.serial(...)`, so the turn boundary does not
commit until the suite finishes. Steering lands in the next-step inbox, the loop
sees a non-empty inbox, and it runs another step.

Two properties of that dispatch shape decide how this plugin is written:

- **`serial` does not contain listener failures** the way `emit` does. A thrown
  listener becomes the turn's error. So the entire listener body is wrapped in
  `try`/`catch` and every failure path degrades to *"the gate did not run"*,
  logged, never to *"the turn crashed"*.
- **`serial` bails on any truthy return** (`isBailed` counts everything but
  `null`, `false`, `undefined`). A stray `return true` here would silently
  suppress every later listener on the event — the Claude Code Stop-hook bridge
  among them. Every path out of the listener returns `undefined`.

A second listener, on `agent/session-start`, captures the baseline (below).

---

## What it guarantees, and what it does not

### Resolution: explicit beats inferred

Ported from `px/src/verify/verify.ts`. In order:

| source | command |
| --- | --- |
| `.px/verify.toml` (`cmd = "..."`) | whatever it says — **always wins** |
| `package.json` `scripts.test` | `bun test` if a bun lockfile is present, else `npm test` |
| a `test_*.py` / `*_test.py` within two levels | `pytest` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| a Makefile with a runnable `test:` target | `make test` |

If none match, there is **no command and no gate**, and that is deliberate: a
guessed command that exits 0 for the wrong reason is worse than no verification
at all. The plugin logs a warning naming the workspace and lets the turn close.

`config.cmd`, if set, skips resolution entirely.

The pytest rule is *not* "a `tests/` directory exists" — `tests/` is where Cargo
puts integration tests, so that shortcut resolved every idiomatic Rust crate to
`pytest`, which exits 5 ("no tests ran") identically before and after any edit.
The delta is empty both times and the repo's real suite never runs.

A `.px/verify.toml` that exists but cannot be read is an **error**, not a
fallback: the repo declared its contract, and silently verifying with a
different runner is a wrong verdict that looks like a right one. px throws
there; this plugin catches that throw at the listener boundary (a throw would
kill the turn), logs it at error level, and runs no gate.

### The verdict is a set difference, not an exit code

A change that fixes the target test and breaks two others exits non-zero on both
the baseline run and the after run. Exit codes cannot tell those two runs apart.
Failing-test *sets* can.

`parseFailing` reads failing identifiers out of pytest, cargo, go, bun, jest and
vitest output (ANSI stripped, trailing `[1.23ms]` / `(5 ms)` timings stripped so
an identifier does not drift between runs). `regressed(baseline, after)` is the
set difference.

The full decision, in order:

| after | baseline | verdict |
| --- | --- | --- |
| timed out / cancelled / sandbox-denied | — | **inconclusive** — log, no steer |
| exit 0 | — | **pass** — budget resets |
| exit ≠ 0 | none, or unusable | **fail**, evidence `exit-code-only` |
| exit ≠ 0 | exit 0 | **fail** — it was green, this turn broke it |
| exit ≠ 0 | exit ≠ 0, new names appeared | **fail**, evidence `regression` |
| exit ≠ 0 | exit ≠ 0, no new names, baseline named ≥1 | **fail**, evidence `pre-existing` |
| exit ≠ 0 | exit ≠ 0, no new names, baseline named none | **fail**, evidence `exit-code-only` |

**Every nonzero exit is a failure. The baseline chooses how the steer describes
it, never whether there is one.**

An earlier draft of this plugin had a `pre-existing red` verdict that logged and
let the turn close. That was wrong, and it was wrong in the most common
situation there is: a repo arrives red, a human says "a test is failing, fix it",
the model stops without fixing it, and the gate — whose entire job is to refuse
that — says nothing, because the failure was already there at session start. It
also contradicted both px and its own source. px's loop passes a finish only on
`after.exitCode === 0 && newlyFailing.length === 0` (`px/src/agent/loop.ts:249`),
and `regressed()`'s own doc comment says an empty delta means "no new *named*
failures", not "safe to land". Proven live: the fixture run below is exactly this
case, and it now steers twice and then caps. Under the old code it steered zero
times.

`evidence` is what the steer tells the model, in descending strength:

| evidence | means | the steer says |
| --- | --- | --- |
| `regression` | green at baseline, or a name that is new | "this turn broke them" |
| `pre-existing` | still red, nothing new, baseline named failures | "you did not break these — that is not a reason to stop" |
| `named` | names parsed, no usable baseline | "failing now, not necessarily newly failing" |
| `exit-code-only` | nothing parsed | "read the output yourself" |

The last row of the decision table is the subtle one. An unknown runner parses to
`[]` on both runs, so "no new names" there would launder a broken build into
"nothing new". Empty means *no evidence*, never *nothing failed* — which is why
`pre-existing` requires the baseline to have actually named something.

`inconclusive` exists so a hung suite, a user Stop, or a sandbox denial can never
be reported to the model as "your tests fail". A model told that will spend the
whole budget "fixing" code that is already correct.

### The baseline — read this part

**The baseline is captured on `agent/session-start`**, which fires exactly once,
before the first turn. For a session started fresh (`source: 'startup'`) that is
a **genuine pre-edit baseline**: the model has not run a single step yet.

It is **not** pre-edit in three cases, and the plugin says so rather than
pretending otherwise:

1. `source` is `resume`, `clear`, or `compact`. The session is continuing;
   earlier edits are already on disk. The baseline is still the most useful
   reference point available, but it is a reference point, not a clean tree —
   and the steer message states which one it was.
2. The workspace was already dirty before dsh started. Nothing at this seam can
   see that, and the plugin does not claim to.
3. The baseline run itself was refused by the executor, timed out, or was
   aborted. Then there is no baseline, the gate falls back to **exit code
   alone**, and the steer message says exactly that.

The baseline run is *started* at session-start and *awaited* at the first
`turn-stopping`. Blocking session-start on a full test suite would hold the
user's first turn behind it; awaiting the promise at the gate is the first
moment the answer is actually needed.

---

## The cap

The upstream Stop-hook bridge carries this, verbatim:

> `TODO(stop-loop-guard): cap consecutive forced continuations; hooks must
> self-limit meanwhile.`

This is that self-limit, and it ships in v1 rather than as a follow-up, because
an unbounded steer loop against a permanently red suite is not a hypothetical
spend bug.

Three independent stops:

1. **`maxAttempts` forced continuations** (default 3). Spent one per steer.
   On exhaustion the gate stops steering, logs at warn level, and lets the turn
   end red so a human sees it. It deliberately does **not** re-run the suite at
   that point: the previous steer already reported the red state, and another
   run only buys wall clock before the human sees it.
2. **`timeoutMs` per run** (default 300 000). A suite that has not finished in
   five minutes is a hang, not a suite. It is always passed explicitly, because
   the base bundle configures the bash executor at 60 000 — low enough to kill a
   real suite and report it as a timeout. The executor's hard ceiling is
   600 000; anything larger is clamped.
3. **The turn's `signal`** is passed into the executor, so a user Stop kills the
   running suite. After the await, `signal.aborted` is re-checked before
   steering.

### Why the budget is keyed the way it is

A forced continuation **re-enters the same turn number** — the steer goes to the
next-step inbox and the loop runs another step inside the open turn. There is no
turn boundary to count, which is exactly why the loop cannot cap this itself.

So the counter is per session (a `WeakMap` keyed on the `Agent`; one agent drives
one session), and exactly two things reset it:

- **a passing run**, and
- **a genuine new wake** — a `turn` strictly greater than the highest the gate
  has seen. Since a forced continuation cannot advance `turn`, this can only be
  a human (or another plugin) putting new work in the inbox. That is precisely
  the "a human sees a red result" checkpoint the cap exists to reach, so the
  budget renews there and nowhere else.

The gate can never renew its own budget.

Process-local on purpose: a `WeakMap` dies with the agent and the counter dies
with the process. A fresh process is a fresh budget; a restart must not inherit
a half-spent one, and an exhausted one must not be resurrected from disk.

### Cost per continuation

Each forced continuation is one more model call on a context that grew by the
steer message. The steer is bounded: the first 40 lines of captured output plus
the parsed failing names. Captured stdout itself is bounded at 1 MiB (an OOM
bound — `parseFailing` wants the whole stream).

The 40 lines are the *first* 40, as specified. For a runner that prints its
failure summary last (`bun test`, `pytest`), those are mostly passing-test
noise — which is why the **parsed failing identifiers are listed separately and
in full**, above the output sample. The load-bearing signal does not depend on
which 40 lines these are.

---

## Config

Validated by schemastery before `apply` runs; invalid values fail plugin load,
not the first turn.

| key | type | default | meaning |
| --- | --- | --- | --- |
| `cmd` | string | *(unset)* | Override. Set it and resolution is skipped entirely. |
| `maxAttempts` | number | `3` | Forced continuations before the gate yields. |
| `timeoutMs` | number | `300000` | Wall-clock ceiling for one verify run. |
| `enabled` | boolean | `true` | `false` loads the plugin and registers nothing. |

Config validation is deliberately pure — no filesystem probing. cordis rejects
async config validation outright, and the workspace is not even known until a
session exists. Command resolution happens inside the listener, where it belongs.

---

## Build and mount

```sh
cd /Users/msulleza/personal/px/dsh/px-verify
DSH_HOME=$HOME/dsh npm run typecheck   # tsc --noEmit, strict
DSH_HOME=$HOME/dsh npm run mount       # build + copy into the profile
```

`DSH_HOME` is not optional. There is no `dependencies` block and no local
install: `link-types` symlinks `node_modules` here to
`$DSH_HOME/profiles/node_modules`, so the plugin typechecks against the exact
`@deepseek-ai/*` builds the running harness loads. Without it `tsc` reports five
`TS2307 Cannot find module` errors and then, because the payload types are gone,
silently stops checking the two listener signatures.

`mount` copies `lib/index.js` into `$DSH_HOME/profiles/web/px-verify/index.js`
and writes the two-line package.json beside it. The plugin must live **inside
the profile directory**, because that is what puts
`$DSH_HOME/profiles/node_modules` (189 symlinks into the npx cache, re-healed on
every launch) on its resolution path. Every `@deepseek-ai/*` import resolves from
there, and an `@latest` bump repoints the symlinks automatically.

Then add **one** block to `$DSH_HOME/profiles/web/cordis.patch.yml`, below the
existing patches — do not replace them:

```yaml
# px-verify: on agent/turn-stopping, run the repo's own test command in the
# session workspace; a failure steers the model back instead of letting the
# turn close. maxAttempts caps forced continuations per session.
#
# `insert` with no `id` APPENDS to the profile root entry list — it is the only
# patch form that adds a row. An id-targeted patch REPLACES the matched row's
# config and cannot create one.
#
# The relative `name` is resolved against THIS FILE's directory and rewritten
# to an absolute file:// URL at load.
- insert:
    - id: px-verify
      name: ./px-verify/index.js
      config:
        maxAttempts: 3
        timeoutMs: 300000
        enabled: true
```

Verify the composition **without booting and without a single model call**:

```sh
DSH_HOME=$HOME/dsh npx -y @deepseek-ai/dsh@latest web --dump-config
```

The row must appear at the bottom with `name:` rewritten to
`file:///Users/msulleza/dsh/profiles/web/px-verify/index.js`. If it is missing,
or the name did not become a `file://` URL, the patch is wrong — a patch that
matches nothing warns and is skipped silently, so a typo does not fail the boot,
it just does nothing.

`cordis.patch.yml` edits hot-reload (`patchReload: live`). **`index.js` edits do
not** — module HMR is off by default. Restart dsh after every rebuild.

### Why not `dsh plugin add`

`reconcilePlugins` only appends a package to `dsh.profile.bundles` when its
manifest declares `dsh.bundle.patch`. A plain plugin has none, so pnpm installs
it, prints "declares no dsh.bundle — installed as a plain dependency, not a
profile layer", and you write the `insert` patch by hand anyway. Same work, plus
a second package manager writing into the directory the launcher's symlink
healer maintains — and, if any `@deepseek-ai/*` ever lands in `dependencies`
instead of `peerDependencies`, a second copy of Cordis in
`profiles/web/node_modules` shadowing the shared one. Two Cordis realms means
`ctx.on` registers against a registry the agent loop never dispatches through,
and the gate simply never fires, with no error. Every `@deepseek-ai/*` in this
package's `package.json` is a `peerDependency`, only.

---

## Plugin shape

Function-plugin namespace: `name` / `inject` / `Config` / `apply`, and **no
default export**. The Loader does `exports = exports.default ?? exports`, so a
default export would replace the whole namespace and silently drop the
injections and the config schema. The plugin would load as a bare function with
no `ctx.shell` and no validation, and would appear to work until it didn't.

`inject = ['shell']` keeps the fiber pending until `ctx.shell` exists; the
listener still reads it through `ctx.get('shell')` each time, because an
executor can be reloaded out from under a long-lived listener.

---

## Proven, and how to reprove it

Mounted in the live web profile at `$DSH_HOME/profiles/web/` and driven through
one real headless session against a fixture repo whose suite cannot be made
green. Verbatim from the run:

```
[INFO] px-verify armed: 2 continuation(s) per turn, 120000ms per run, command resolved per workspace
[INFO] px-verify session session-ec1eddcd…: baseline run of bun test (from package.json scripts.test, source startup)
[INFO] px-verify session session-ec1eddcd…: baseline exit 1, 1 failing test(s) named
[INFO] px-verify session session-ec1eddcd…: turn 1 stopping — running bun test (from package.json scripts.test) in /private/tmp/px-gate-proof
[WARN] px-verify session session-ec1eddcd…: bun test exit 1 — 0 regression(s), 1 still failing, evidence pre-existing; steering back, 1 continuation(s) left
[INFO] px-verify session session-ec1eddcd…: turn 1 stopping — running bun test (from package.json scripts.test) in /private/tmp/px-gate-proof
[WARN] px-verify session session-ec1eddcd…: bun test exit 1 — 0 regression(s), 1 still failing, evidence pre-existing; steering back, 0 continuation(s) left
[WARN] px-verify session session-ec1eddcd…: 2/2 forced continuations spent and still red — yielding so a human sees the failure
```

Note the turn number: all three stops are `turn 1`. A forced continuation
re-enters the same turn, which is exactly why the budget is keyed on
`(agent, turn)` and not on a turn boundary that never arrives.

The model's final answer quoted the steer text back ("attempt 2 of 2", "the only
ways to green the suite are to edit the test, skip it, delete it, or change the
verify command, all of which I am explicitly forbidden from doing") and left the
test untouched. The steer landed, it was read, and its prohibitions held.

To reproduce, from `/Users/msulleza/personal/px`:

```sh
bash dsh/proof/run.sh
```

That script builds the fixture, mounts nothing, and drives one headless session
with the same build the web profile has. It costs three model calls.

---

## You cannot see any of this by default

dsh ships **no console log exporter**. `LoggerService`'s constructor registers
exactly one built-in exporter and it only appends to a 1000-message in-memory
ring buffer (`vendor/cordis/src/logger.ts:216-226`); nothing anywhere in
`packages/` or `apps/` writes log messages to a stream. Every `ctx.logger(…)`
call in the entire harness is invisible from a terminal.

[`../px-log-stderr`](../px-log-stderr) is a five-line overlay plugin that fixes
that for one run:

```sh
~/dsh/start.sh ~/some/repo --patch ~/personal/px/dsh/px-log-stderr/patch.yml --no-open
```

Two things about cordis logging that cost a live run to discover, both now fixed
here and worth knowing before you add a log line to any dsh plugin:

1. **`%c` swallows its argument.** `defaultFormatters.c` returns `''`
   (`logger.ts:57`). `%C` is the highlighted one. The first version of this
   plugin logged the session id, the command and the workspace with `%c` and
   printed `session : baseline run of  (from …) in ` — three blanks.
2. **`warn` is *below* `info`.** cordis's ladder is verbosity, not urgency:
   `ERROR 0 < INFO 1 < WARN 2 < DEBUG 3`, and an exporter with no explicit
   `levels` compares against `logger.level ?? INFO` and `continue`s
   (`logger.ts:152-155`). At the default that drops every `log.warn` — here,
   the entire verdict stream. This plugin sets `log.level = 2` on its own logger
   so its severities can stay honest and still be seen.

---

## Known limitations

- **Subagents are skipped.** An unscoped root listener is admitted for every
  agent, so without a guard every `Task` child would run the whole suite —
  multiplying wall time and, worse, handing each child its own continuation
  budget. The gate runs only where `origin !== 'subagent'` and
  `delegationDepth` is 0. Subagent work is verified when the parent stops.
- **The sandbox root is the launch cwd, not the session workspace.** On macOS
  `ctx.shell` is the bash sandbox, and the base bundle sets `workspace-write`
  with `workspaceRoot: process.cwd()` — wherever `start.sh` was run. A session
  opened on a different workspace in the web UI runs its tests under a sandbox
  rooted somewhere else, and writes outside that root (and network, so a
  first-run dependency install) are denied. `result.sandbox.denied` is read and
  reported as **inconclusive**, not as a test failure, so the model is not sent
  to "fix" passing tests. Command *resolution* reads the filesystem in-process
  and is unaffected.
- **`turn-stopping` also fires after a `max-tokens` stop**, and the payload
  carries no `TurnEndReason` to distinguish it. Steering after a token-ceiling
  stop buys another equally truncated call. This is a concrete argument for
  keeping `maxAttempts` at 2–3, not raising it.
- **stderr is not bounded by `stdoutMaxBytes`.** The executor exposes a stdout
  budget only; stderr keeps the executor's own cap. `bun test` writes results to
  stderr, so that stream matters — the joined output notes when either stream
  was truncated, and what is kept is the tail.
- **`parseFailing` keeps an unparenthesised trailing timing.** Carried over from
  px verbatim: `× adds 3ms` parses to `adds 3ms`, timing included, because only
  bracketed and parenthesised timings are stripped. vitest prints that form for
  slow tests, and a drifting duration makes the same failure look new to
  `regressed()` on the next run — reported as a regression that isn't one. It is
  a live hole in px and it is a live hole here; fix both together or neither.
- **Only one verify command per session.** Resolution runs per turn (cheap, and
  it picks up a `.px/verify.toml` the agent just wrote), but the baseline was
  captured with whatever command resolved at session start. If the command
  changes mid-session, the set comparison is across two different runners; the
  `command.source` in the log line is what tells you that happened.
- **`node --test` parses to nothing.** Node's own built-in runner prints `✖ adds
  (1.2ms)` (U+2716) and TAP `not ok 1 - adds`; `parseFailing` knows neither, so
  the zero-dependency runner most likely to be reached for degrades to
  `exit-code-only`. The gate still fires — the exit code is still load-bearing —
  but it cannot name what broke, and it cannot tell a new break from an old one.
  Fixing it means adding U+2716 and a TAP branch to px's `parseFailing` too.
- **Every turn pays for a full suite run, not just turns that edited code.** px
  verified only when the model called `finish`; dsh has no finish tool, and
  `agent/turn-stopping` is the closest honest analogue, so a turn that only
  answered a question still runs the suite before it can close. On a slow suite
  that is dead wall-clock time on every exchange. A cheap improvement would be
  to skip the run when nothing in the workspace changed since the last one.
