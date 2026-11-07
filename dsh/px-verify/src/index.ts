/**
 * px's verification gate, as a DeepSeek Harness plugin.
 *
 * The machine owns the verdict. When the loop decides a turn is over, this runs
 * the repository's own test command in the session workspace; a failure steers
 * the model back instead of letting the turn close. The model never gets to say
 * "done" — it gets to produce a diff, and a real command decides.
 *
 * Three things make that verdict trustworthy, and all three are ported from
 * px's `src/verify/verify.ts`:
 *
 *  1. RESOLUTION is explicit-over-inferred. A `.px/verify.toml` the repo wrote
 *     beats anything guessed from the file tree, and a repo with no discoverable
 *     command gets NO verification rather than a guessed one — a wrong command
 *     that exits 0 is worse than no gate at all.
 *  2. The verdict is a SET DIFFERENCE, not an exit code. A change that fixes the
 *     target test and breaks two others exits non-zero on both the baseline run
 *     and the after run, so exit codes cannot tell those runs apart. Comparing
 *     failing-test *sets* against a baseline captured at session start can.
 *  3. ENVIRONMENT. Runners get CI=1 and NO_COLOR=1. CI stops vitest/jest from
 *     dropping into watch mode and hanging until the timeout kills them; NO_COLOR
 *     stops ANSI escapes from landing in the middle of the "(fail) name" lines
 *     {@link parseFailing} has to read.
 *
 * And one thing the harness makes this plugin's job rather than the loop's.
 * `agent/turn-stopping` steering lands in the next-step inbox, so the loop runs
 * ANOTHER step inside the SAME turn number (agent-loop/src/agent.ts:314-320) —
 * there is no turn boundary to count. The upstream Stop-hook bridge carries an
 * explicit `TODO(stop-loop-guard): cap consecutive forced continuations; hooks
 * must self-limit meanwhile`. {@link Config.maxAttempts} and
 * {@link Config.timeoutMs} are that self-limit, and they ship in v1 because an
 * unbounded steer loop against a permanently red suite is not a hypothetical
 * spend bug — it is a real one, measured in dollars per hour.
 *
 * Function-plugin namespace: `name` / `inject` / `Config` / `apply`, and NO
 * default export. The Loader does `exports = exports.default ?? exports`
 * (vendor/loader/src/index.ts:191-199), so a default export here would silently
 * erase the injections and the config schema.
 *
 * @module px-verify
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, SessionStartSource } from '@deepseek-ai/dsh-agent'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import type { ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'

/** Cordis plugin name: loader diagnostics, fiber errors, and the logger prefix. */
export const name = 'px-verify'

/**
 * The verify command runs through the shell seam. Declaring it here keeps the
 * fiber pending until `ctx.shell` exists; the listener still reads it through
 * `ctx.get('shell')`, because an executor can be reloaded out from under us.
 */
export const inject = ['shell']

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/** Gate configuration. Invalid values fail plugin load, not the first turn. */
export interface Config {
  /**
   * Verify command override. Set it and resolution is skipped entirely — this
   * is the escape hatch for a repo whose real command px cannot infer. Empty
   * means "resolve it from the workspace".
   */
  cmd?: string
  /**
   * Forced continuations allowed before the gate yields and lets a red turn
   * end. The budget is per session and renews on a passing run or on a genuine
   * new human turn — never on a continuation the gate itself forced.
   */
  maxAttempts: number
  /**
   * Wall-clock ceiling for ONE verify run. A suite that has not finished in
   * five minutes is a hang, not a suite. The bash executor caps at 600_000 and
   * the base bundle's own default is 60_000 — which kills real suites — so this
   * is always passed explicitly.
   */
  timeoutMs: number
  /** Master switch. `false` loads the plugin and registers nothing. */
  enabled: boolean
}

/** Schemastery validation for {@link Config}. Pure: no filesystem probing here,
 *  because cordis rejects async config validation outright (fiber.ts:53-56) and
 *  the workspace is not even known until a session exists. */
export const Config: z<Config> = z.object({
  cmd: z.string(),
  maxAttempts: z.number().default(3),
  timeoutMs: z.number().default(300_000),
  enabled: z.boolean().default(true),
})

/**
 * Lines of captured output pasted into the steer message.
 *
 * Bounded on purpose: every forced continuation re-sends this text into the
 * context window, so an unbounded suite log is a spend bug wearing a helpful
 * face. The named failing tests are extracted separately and in full, so the
 * load-bearing signal does not depend on which 40 lines these are.
 */
const FEEDBACK_LINES = 40

/**
 * Captured stdout budget. An OOM bound, not a context bound — {@link parseFailing}
 * wants the whole stream, and 1 MiB of test output is already far more than any
 * window. The executor hands back the TAIL when it truncates, which for a test
 * runner is the lucky half.
 */
const STDOUT_MAX_BYTES = 1024 * 1024

// ---------------------------------------------------------------------------
// resolution — ported from px src/verify/verify.ts
// ---------------------------------------------------------------------------

/** A resolved verify command and where it came from, for the log line. */
export interface VerifyCommand {
  cmd: string
  source: string
}

/**
 * Find the command that decides this repo's verdict.
 *
 * Order is explicit-over-inferred: a `.px/verify.toml` the user wrote beats
 * anything inferable from the file tree. Returns null rather than a default,
 * because a guessed command that exits 0 for the wrong reason is worse than no
 * verification at all — the caller must decide what to do about that, loudly.
 *
 * Reads happen in the harness process, NOT through the sandboxed shell, so they
 * see the real session workspace even when the sandbox is rooted elsewhere.
 */
export function resolveVerifyCommand(root: string): VerifyCommand | null {
  const declared = readVerifyToml(root)
  if (declared) return { cmd: declared, source: '.px/verify.toml' }

  const pkg = readJson(join(root, 'package.json'))
  if (pkg) {
    const scripts = pkg['scripts']
    const test = isRecord(scripts) ? scripts['test'] : undefined
    if (typeof test === 'string' && test.trim() !== '') {
      const bun = existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))
      return { cmd: bun ? 'bun test' : 'npm test', source: 'package.json scripts.test' }
    }
  }

  if (hasPythonTests(root)) return { cmd: 'pytest', source: 'pytest layout' }
  if (existsSync(join(root, 'Cargo.toml'))) return { cmd: 'cargo test', source: 'Cargo.toml' }
  if (existsSync(join(root, 'go.mod'))) return { cmd: 'go test ./...', source: 'go.mod' }

  const mk = makefileWithTestTarget(root)
  if (mk) return { cmd: 'make test', source: `${mk} test target` }

  return null
}

/**
 * Read the single key px cares about out of `.px/verify.toml`.
 *
 * Deliberately not a TOML parser: one key, one line, no dependency. Anything
 * fancier in that file is ignored rather than half-understood.
 *
 * @throws when the file exists but cannot be read. The repo declared its
 * contract; falling back to an inferred command would verify with a DIFFERENT
 * runner than the one the repo committed — a wrong verdict that looks right.
 * The caller contains this, because a thrown listener kills the user's turn.
 */
function readVerifyToml(root: string): string | null {
  const path = join(root, '.px', 'verify.toml')
  if (!existsSync(path)) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${path} exists but could not be read (${message}). `
      + `Fix or remove it; px will not guess a verify command around a declared one.`,
    )
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^cmd\s*=\s*(.+)$/.exec(line)
    if (!m) continue
    const rhs = (m[1] as string).trim()
    const q = rhs[0]
    let value: string
    if (q === '"' || q === '\'') {
      const end = rhs.indexOf(q, 1)
      if (end === -1) throw new Error(`${path}: unterminated quote on cmd = ...`)
      value = rhs.slice(1, end)
    } else {
      const hash = rhs.indexOf('#')
      value = (hash === -1 ? rhs : rhs.slice(0, hash)).trim()
    }
    if (value !== '') return value
  }
  return null
}

/** Directories that never hold evidence of a repo's test layout. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'dist',
  'build',
  'target',
  '.px',
])

/** pytest's own default collection names, so `tests/utils.py` is not evidence. */
const PYTEST_FILE = /^(?:test_.*|.*_test)\.py$/

/**
 * A `test_*.py` / `*_test.py` within two levels. Bounded on purpose.
 *
 * Deliberately NOT "a `tests/` directory exists": `tests/` is where Cargo puts
 * integration tests, so that shortcut resolved every idiomatic Rust crate — and
 * any Go repo with a tests/ dir — to `pytest`, which exits 5 ("no tests ran")
 * identically on the baseline and on the edited tree. The delta is empty both
 * times and the repo's real suite never runs, which is the exact failure this
 * module exists to prevent.
 */
function hasPythonTests(root: string, depth = 2): boolean {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return false
  }
  const dirs: string[] = []
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(root, entry)
    if (isDir(full)) {
      dirs.push(full)
      continue
    }
    if (PYTEST_FILE.test(entry)) return true
  }
  if (depth <= 0) return false
  for (const dir of dirs) if (hasPythonTests(dir, depth - 1)) return true
  return false
}

/** The makefile name carrying a runnable `test` target, or null. */
function makefileWithTestTarget(root: string): string | null {
  for (const entry of ['Makefile', 'makefile', 'GNUmakefile']) {
    const path = join(root, entry)
    if (!existsSync(path)) continue
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    // A target definition: not `.PHONY: test` (that line starts with .PHONY) and
    // not `test := ...` (a variable named test, which `make test` cannot run).
    // `test::` double-colon rules still count.
    if (/^test\s*:(?!=)/m.test(text)) return entry
  }
  return null
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------

/** One completed (or killed) verify run. */
export interface VerifyResult {
  /** Null when the process died from a signal — which is why every failure test
   *  here is `exitCode !== 0` and never the falsy check. */
  exitCode: number | null
  /** stdout then stderr. Runners disagree on which they use: pytest writes
   *  results to stdout, `bun test` writes all of them to stderr. */
  output: string
  /** Test identifiers parsed out of {@link output}. Empty means NO EVIDENCE. */
  failing: string[]
  /** The executor's own deadline fired first. NOT a test failure. */
  timedOut: boolean
  /** The caller's signal fired first — a user Stop, not a verdict. */
  aborted: boolean
  /** The sandbox denied a file operation. Also not a test failure. */
  sandboxDenied: boolean
}

/**
 * Run one verify command through the shell seam.
 *
 * Two different failure shapes have to be caught together: `resolve()` may
 * reject the command on policy grounds, and `run()` only promises to RESOLVE
 * for nonzero exits, timeouts, and aborts — it rejects for infrastructure
 * failures. Both are contained here and reported as `undefined`, never thrown,
 * because `agent/turn-stopping` is dispatched via `serial`, which does not
 * contain listener failures: a rejection there becomes the turn's error.
 *
 * @param shell - the executor service.
 * @param cmd - the resolved verify command.
 * @param cwd - the session workspace the command runs in.
 * @param timeoutMs - explicit wall-clock ceiling; never left to the default.
 * @param signal - the turn's abort signal, so a user Stop kills the suite.
 * @returns the run, or `undefined` when the executor refused or broke.
 */
export async function runVerify(
  shell: ShellExecutor,
  cmd: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<VerifyResult | undefined> {
  let result: ShellRunResult
  try {
    result = await shell.run(shell.resolve({
      command: cmd,
      workdir: cwd,
      timeoutMs,
      stdoutMaxBytes: STDOUT_MAX_BYTES,
      // CI stops watch-mode runners (vitest, jest --watch) from waiting on a TTY
      // that will never answer; without it every such repo "times out". NO_COLOR
      // keeps ANSI escapes out of the middle of the lines parseFailing reads.
      env: { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
      ...(signal ? { signal } : {}),
    }))
  } catch {
    return undefined
  }
  const output = joinStreams(result)
  return {
    exitCode: result.exitCode,
    output,
    failing: parseFailing(output),
    timedOut: result.timedOut,
    aborted: result.aborted,
    sandboxDenied: result.sandbox?.denied ?? false,
  }
}

/** stdout then stderr, each flagged where the executor's cap dropped its head. */
function joinStreams(result: ShellRunResult): string {
  const parts: string[] = []
  if (result.stdout.text) parts.push(result.stdout.text)
  if (result.stderr.text) parts.push(result.stderr.text)
  if (result.stdout.truncated || result.stderr.truncated) {
    parts.push('... [output truncated by the executor; the text above is the tail] ...')
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// parsing — ported from px src/verify/verify.ts
// ---------------------------------------------------------------------------

// Timings differ run to run. Leaving "[1.23ms]" on an identifier would make
// every failure look new to regressed(), which is the one thing it must not do.
const BRACKET_TIMING = /\s*\[\s*[\d.]+\s*(?:ns|µs|us|ms|s)\s*\]\s*$/
const PAREN_TIMING = /\s*\(\s*[\d.]+\s*(?:ns|µs|us|ms|s)\s*\)\s*$/
// eslint-disable-next-line no-control-regex -- matching escapes is the point
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/**
 * Failing test identifiers, per runner. Unknown output yields `[]`, which the
 * caller must read as "no evidence", never as "nothing failed" — which is why
 * {@link VerifyResult} keeps `exitCode` and `failing` as separate fields and
 * {@link verdictOf} consults both.
 */
export function parseFailing(output: string): string[] {
  const found = new Set<string>()
  for (const rawLine of output.replace(ANSI, '').split('\n')) {
    const trimmed = rawLine.replace(/\r/g, '').trim()

    // pytest short summary: FAILED tests/test_a.py::test_b - AssertionError
    let m = /^FAILED\s+(\S+)/.exec(trimmed)
    if (m) {
      found.add(m[1] as string)
      continue
    }
    // pytest -v: tests/test_a.py::test_b FAILED  [ 50%]
    m = /^(\S+::\S+)\s+FAILED\b/.exec(trimmed)
    if (m) {
      found.add(m[1] as string)
      continue
    }
    // cargo: test tests::adds ... FAILED
    m = /^test\s+(\S+)\s+\.\.\.\s+FAILED\b/.exec(trimmed)
    if (m) {
      found.add(m[1] as string)
      continue
    }
    // go: --- FAIL: TestAdd (0.00s), including indented subtests
    m = /^---\s+FAIL:\s+(\S+)/.exec(trimmed)
    if (m) {
      found.add(m[1] as string)
      continue
    }
    // bun: (fail) math > adds [1.23ms]
    m = /^\(fail\)\s+(.+)$/.exec(trimmed)
    if (m) {
      const cleaned = cleanName(m[1] as string)
      if (cleaned) found.add(cleaned)
      continue
    }
    // jest/vitest tick marks: ✗ adds (5 ms) / ✕ adds / × adds 3ms.
    // U+00D7 is what vitest's default reporter actually prints; without it the
    // most common npm-test runner parses to [] and the gate silently degrades
    // to an exit-code check.
    m = /^[✗✕×]\s+(.+)$/.exec(trimmed)
    if (m) {
      const cleaned = cleanName(m[1] as string)
      if (cleaned) found.add(cleaned)
    }
  }
  return [...found].sort()
}

function cleanName(raw: string): string {
  return raw.replace(BRACKET_TIMING, '').replace(PAREN_TIMING, '').trim()
}

/**
 * Tests failing now that were not failing before.
 *
 * This is the gate. A fix that repairs the target test and breaks two others
 * exits non-zero on both runs, so exit codes cannot tell the two runs apart;
 * the set difference can.
 *
 * A caveat the caller owns: if `after` failed to build, its failing set is
 * empty and this returns `[]`. Empty here means "no new NAMED failures", not
 * "safe to land" — {@link verdictOf} checks the exit codes too.
 */
export function regressed(baseline: VerifyResult, after: VerifyResult): string[] {
  const before = new Set(baseline.failing)
  return after.failing.filter((test) => !before.has(test)).sort()
}

// ---------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------

/**
 * What the machine decided about one after-run.
 *
 * `inconclusive` exists so a hung suite, a user Stop, or a sandbox denial can
 * never be reported to the model as "your tests fail" — the model would then
 * spend the whole budget "fixing" code that is already correct.
 *
 * There is deliberately NO "the suite was already red, let it close" verdict.
 * px's own loop rejects a finish on `after.exitCode !== 0`, full stop
 * (px/src/agent/loop.ts:249: `after.exitCode === 0 && newlyFailing.length === 0`),
 * and `regressed()`'s own doc comment says an empty delta means "no new NAMED
 * failures", never "safe to land". A gate that stays quiet on a still-red suite
 * is silent in the single most common situation there is — "a test is failing,
 * fix it" — where the model stops, the suite is still red, and nothing objects.
 * The baseline's job is to make the steer ACCURATE about blame, not to excuse
 * the red.
 */
export type FailEvidence =
  /** Named tests that were green at the baseline and are red now. Strongest. */
  | 'regression'
  /** Still red with nothing new named, and the baseline named failures too. */
  | 'pre-existing'
  /** Named failures parsed, but no usable baseline to compare them against. */
  | 'named'
  /** Nothing parsed. The nonzero exit code is the only evidence there is. */
  | 'exit-code-only'

export type Verdict =
  | { kind: 'pass' }
  | { kind: 'fail'; regressions: string[]; stillFailing: string[]; evidence: FailEvidence }
  | { kind: 'inconclusive'; why: string }

/**
 * Decide, from the after-run and whatever baseline exists.
 *
 * The ordering is the whole point:
 *  - a hang, a cancel, or a sandbox denial is never a test verdict.
 *  - exit 0 is a pass, full stop.
 *  - every other exit is a failure, full stop. The baseline only chooses HOW
 *    the steer describes it, never whether there is one.
 *  - a green baseline turned red, or new names against a red one, is a
 *    regression — this turn's fault, and said so.
 *  - no new names against a baseline that DID name failures is `pre-existing`:
 *    still red, but the steer tells the model it did not cause this, so it
 *    does not go hunting for a break it never made.
 *  - a baseline that named nothing (unknown runner) must NOT be read as "no
 *    new failures" — it parses to `[]` on both runs and would launder a broken
 *    build. That degrades to `named` / `exit-code-only`, and the steer says so.
 */
export function verdictOf(after: VerifyResult, baseline: VerifyResult | undefined): Verdict {
  if (after.timedOut) return { kind: 'inconclusive', why: 'the verify command hit its wall-clock ceiling' }
  if (after.aborted) return { kind: 'inconclusive', why: 'the verify command was cancelled' }
  if (after.exitCode === 0) return { kind: 'pass' }
  if (after.sandboxDenied) {
    return { kind: 'inconclusive', why: 'the sandbox denied a file operation, so the exit code is a policy verdict, not a test verdict' }
  }

  const usable = baseline !== undefined && !baseline.timedOut && !baseline.aborted
  if (!usable) {
    return {
      kind: 'fail',
      regressions: [],
      stillFailing: after.failing,
      evidence: after.failing.length > 0 ? 'named' : 'exit-code-only',
    }
  }
  if (baseline.exitCode === 0) {
    // Green before, red now. Whatever parsed (or did not), this turn broke it.
    return {
      kind: 'fail',
      regressions: after.failing,
      stillFailing: after.failing,
      evidence: after.failing.length > 0 ? 'regression' : 'exit-code-only',
    }
  }
  const regressions = regressed(baseline, after)
  if (regressions.length > 0) {
    return { kind: 'fail', regressions, stillFailing: after.failing, evidence: 'regression' }
  }
  // No new names. Only callable "pre-existing" if the baseline actually named
  // some: an unknown runner parses to [] on BOTH runs, and calling that
  // "nothing new" would launder a broken build into a clean bill of health.
  if (baseline.failing.length > 0) {
    return { kind: 'fail', regressions: [], stillFailing: after.failing, evidence: 'pre-existing' }
  }
  return {
    kind: 'fail',
    regressions: [],
    stillFailing: after.failing,
    evidence: after.failing.length > 0 ? 'named' : 'exit-code-only',
  }
}

// ---------------------------------------------------------------------------
// per-session state
// ---------------------------------------------------------------------------

/** The reference run this session's after-runs are compared against. */
interface Baseline {
  result: VerifyResult | undefined
  command: VerifyCommand
  /** Why the session started. Only `startup` is a genuinely pre-edit baseline. */
  source: SessionStartSource
}

/**
 * One session's gate state.
 *
 * A WeakMap keyed on the Agent, not a durable projection, and deliberately so:
 * one agent drives one session, and the continuation budget MUST NOT survive a
 * restart. A fresh process is a fresh budget, and a leaked entry cannot outlive
 * the agent it is keyed on.
 */
interface GateState {
  readonly sessionId: string
  /** Settles to the session-start reference run. Never rejects. */
  readonly baseline: Promise<Baseline | undefined>
  /** Forced continuations spent since the last pass or the last human turn. */
  attempts: number
  /** Highest turn the gate has seen, to detect a genuine new human wake. */
  lastTurn: number
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

/**
 * Register the gate for the lifetime of `ctx`.
 *
 * @param ctx - plugin context; both listeners unwind with the fiber.
 * @param config - validated and defaulted by cordis before this runs.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) {
    ctx.logger(name).info('disabled by config; no verification gate is armed')
    return
  }

  const log = ctx.logger(name)
  const states = new WeakMap<Agent, GateState>()

  // cordis's severity ladder is a VERBOSITY ladder, not an urgency one:
  // ERROR 0 < INFO 1 < WARN 2 < DEBUG 3, and an exporter with no explicit
  // `levels` falls back to the logger's own `level ?? INFO`
  // (vendor/cordis/src/logger.ts:152-155, `if (targetLevel < level) continue`).
  // At the default that silently DROPS every `log.warn` — which here is the
  // gate's entire verdict stream: the steer, the cap, the missing runner. Two
  // forced continuations against a red suite produced exactly zero visible
  // lines before this. Raising this logger's own level to WARN keeps the
  // severities honest and still loses to any exporter that sets `levels`.
  log.level = 2

  // A gate that loads silently is a gate nobody can prove is armed. One line at
  // apply time is the difference between "it is mounted" and "I believe it is
  // mounted" — and the fiber only reaches here once `ctx.shell` exists, so this
  // line is also proof the injection resolved.
  log.info(
    'armed: %s continuation(s) per turn, %sms per run, command %s',
    String(config.maxAttempts),
    String(config.timeoutMs),
    config.cmd !== undefined && config.cmd.trim() !== '' ? config.cmd : 'resolved per workspace',
  )

  // Baseline runs have no turn signal of their own, so they hang off the
  // plugin's lifetime instead: a reload or shutdown kills a suite still running.
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort() })

  /** The workspace this session was opened on. */
  const workspaceOf = (agent: Agent): string => agent.session.header.cwd ?? process.cwd()

  /**
   * Resolve the command for a workspace, containing px's deliberate throw on an
   * unreadable `.px/verify.toml`: that throw is the honest signal, but it must
   * never reach a `serial` dispatch, where it would take the turn down.
   */
  const commandFor = (cwd: string): VerifyCommand | null => {
    if (config.cmd !== undefined && config.cmd.trim() !== '') {
      return { cmd: config.cmd, source: 'px-verify config.cmd' }
    }
    try {
      return resolveVerifyCommand(cwd)
    } catch (error: unknown) {
      log.error(`%s`, error instanceof Error ? error.message : String(error))
      return null
    }
  }

  /**
   * A subagent's turn is not the session a human is watching, and an unscoped
   * root listener is admitted for every agent. Without this, every Task child
   * runs the whole suite — multiplying wall time and, worse, giving each child
   * its own continuation budget to burn.
   */
  const isTopLevel = (agent: Agent): boolean => {
    const header = agent.session.header
    return header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0
  }

  // -- baseline ------------------------------------------------------------
  //
  // The session-start seam is the ONLY point in the loop that is reliably
  // before the model has touched anything, so it is where the reference run
  // has to happen. It fires once, before the first turn.
  ctx.on('agent/session-start', ({ agent, source }): void => {
    if (!isTopLevel(agent)) return
    if (states.has(agent)) return
    const sessionId = agent.session.header.id
    const cwd = workspaceOf(agent)
    const command = commandFor(cwd)
    if (!command) {
      log.warn(
        'no verify command for %C — the gate will not run this session (write .px/verify.toml or set config.cmd)',
        cwd,
      )
      // Still record state: the turn-stopping listener re-resolves and will say
      // the same thing once, rather than re-walking the tree every turn.
      states.set(agent, { sessionId, baseline: Promise.resolve(undefined), attempts: 0, lastTurn: 0 })
      return
    }

    log.info(
      'session %C: baseline run of %C (from %s, source %s)',
      sessionId,
      command.cmd,
      command.source,
      source,
    )
    // Started, not awaited: session-start is an emit seam and blocking it would
    // hold the first turn behind a full test suite. turn-stopping awaits this
    // promise, which is the first moment the answer is actually needed.
    const baseline = (async (): Promise<Baseline | undefined> => {
      const shell = ctx.get('shell')
      if (shell === undefined) return undefined
      const result = await runVerify(shell, command.cmd, cwd, config.timeoutMs, lifetime.signal)
      if (!result) {
        log.warn('session %C: baseline run was refused by the executor; falling back to exit-code-only', sessionId)
        return { result: undefined, command, source }
      }
      log.info(
        'session %C: baseline exit %s, %s failing test(s) named%s',
        sessionId,
        String(result.exitCode),
        String(result.failing.length),
        result.timedOut ? ' (TIMED OUT — not a usable baseline)' : '',
      )
      return { result, command, source }
    })().catch((error: unknown) => {
      log.warn('session %C: baseline run failed: %s', sessionId, error instanceof Error ? error.message : String(error))
      return undefined
    })

    states.set(agent, { sessionId, baseline, attempts: 0, lastTurn: 0 })
  })

  // -- the gate ------------------------------------------------------------
  //
  // EVERY path out of this listener returns undefined and nothing throws.
  // `serial` bails on any truthy return (isBailed counts everything but null /
  // false / undefined), which would silently suppress every later listener —
  // the Claude Code Stop-hook bridge among them. And `serial` does not contain
  // listener rejections the way `emit` does: a throw here lands in the turn's
  // catch and becomes the turn's error. A missing test runner must degrade to
  // "the gate did not run", never to "the turn crashed".
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    try {
      if (!isTopLevel(agent)) return

      const cwd = workspaceOf(agent)
      const state = states.get(agent) ?? {
        sessionId: agent.session.header.id,
        baseline: Promise.resolve(undefined),
        attempts: 0,
        lastTurn: 0,
      }
      states.set(agent, state)

      // A forced continuation re-enters the SAME turn number, so a higher turn
      // is proof a human (or another plugin) woke the agent — the checkpoint
      // the cap exists to reach. That, and a passing run, are the only two
      // things that renew the budget; the gate can never renew its own.
      if (turn > state.lastTurn) {
        if (state.attempts > 0) {
          log.info('session %C: turn %s is a fresh wake; continuation budget reset', state.sessionId, String(turn))
        }
        state.attempts = 0
        state.lastTurn = turn
      }

      if (state.attempts >= config.maxAttempts) {
        // Deliberately does not re-run the suite: the last steer already
        // reported the red state, and the only thing another run could buy is
        // more wall clock before the human sees it.
        log.warn(
          'session %C: %s/%s forced continuations spent and still red — yielding so a human sees the failure',
          state.sessionId,
          String(state.attempts),
          String(config.maxAttempts),
        )
        return
      }

      const command = commandFor(cwd)
      if (!command) {
        log.warn('session %C: no verify command for %C; turn closes unverified', state.sessionId, cwd)
        return
      }

      const shell = ctx.get('shell')
      if (shell === undefined) {
        log.warn('session %C: no shell executor; turn closes unverified', state.sessionId)
        return
      }

      const baseline = await state.baseline
      log.info('session %C: turn %s stopping — running %C (from %s) in %C', state.sessionId, String(turn), command.cmd, command.source, cwd)
      const after = await runVerify(shell, command.cmd, cwd, config.timeoutMs, signal)
      if (!after) {
        log.warn('session %C: the executor refused or broke on %C; turn closes unverified', state.sessionId, command.cmd)
        return
      }
      // The turn may have been cancelled while the suite ran. agent.ts calls
      // signal.throwIfAborted() the moment this dispatch returns anyway, so a
      // steer here would be parked work nobody asked for.
      if (signal.aborted) {
        log.info('session %C: turn cancelled during verify; no steer', state.sessionId)
        return
      }

      const verdict = verdictOf(after, baseline?.result)
      const remaining = config.maxAttempts - state.attempts - 1

      switch (verdict.kind) {
        case 'pass':
          log.info('session %C: %C exit 0 — turn may close (budget reset)', state.sessionId, command.cmd)
          state.attempts = 0
          return
        case 'inconclusive':
          log.warn('session %C: verdict inconclusive — %s; turn closes unverified', state.sessionId, verdict.why)
          return
        case 'fail': {
          state.attempts += 1
          log.warn(
            'session %C: %C exit %s — %s regression(s), %s still failing, evidence %s; steering back, %s continuation(s) left',
            state.sessionId,
            command.cmd,
            String(after.exitCode),
            String(verdict.regressions.length),
            String(verdict.stillFailing.length),
            verdict.evidence,
            String(remaining),
          )
          agent.steer(createUserMessage({
            content: [{ type: 'text', text: steerText(command, after, verdict, baseline, state.attempts, config.maxAttempts) }],
            source: {
              kind: 'plugin',
              plugin: name,
              // A notice supersedes nothing: each forced continuation is its own
              // account of a run that just happened, not a replacement snapshot.
              form: 'notice',
              summary: boundContextSummary(`px-verify: ${command.cmd} exited ${String(after.exitCode)}`),
            },
          }))
          return
        }
      }
    } catch (error: unknown) {
      log.warn('gate failed, turn closes unverified: %s', error instanceof Error ? error.message : String(error))
    }
  })
}

// ---------------------------------------------------------------------------
// steer text
// ---------------------------------------------------------------------------

/**
 * The message the model reads instead of stopping.
 *
 * Phrased to point at the CAUSE. A model told only "tests fail" reliably
 * reaches for the cheapest green: deleting the assertion, skipping the case,
 * or editing the verify command. Naming those moves as out of bounds, and
 * naming the exact tests that went red, is what keeps the steer honest.
 */
function steerText(
  command: VerifyCommand,
  after: VerifyResult,
  verdict: Extract<Verdict, { kind: 'fail' }>,
  baseline: Baseline | undefined,
  attempt: number,
  maxAttempts: number,
): string {
  const lines = after.output.split('\n')
  const head = lines.slice(0, FEEDBACK_LINES).join('\n')
  const rest = lines.length - FEEDBACK_LINES

  const parts: string[] = [
    'px-verify: this turn is not over. The repository\'s own test command failed.',
    '',
    `  command:  ${command.cmd}   (resolved from ${command.source})`,
    `  exit:     ${String(after.exitCode)}`,
    `  attempt:  ${String(attempt)} of ${String(maxAttempts)}`,
  ]

  if (verdict.regressions.length > 0) {
    parts.push('', '  failing now, and NOT failing at the session baseline — this turn broke them:')
    for (const test of verdict.regressions) parts.push(`    - ${test}`)
    const collateral = verdict.stillFailing.filter((test) => !verdict.regressions.includes(test))
    if (collateral.length > 0) {
      parts.push('', '  also failing, and already failing at the session baseline:')
      for (const test of collateral) parts.push(`    - ${test}`)
    }
  } else if (verdict.stillFailing.length > 0) {
    parts.push('', '  failing now:')
    for (const test of verdict.stillFailing) parts.push(`    - ${test}`)
  }

  if (verdict.evidence === 'pre-existing') {
    parts.push(
      '',
      '  note: none of these are new — every one of them was already failing at the',
      '  session baseline, so you did not break them. That is not a reason to stop.',
      '  The suite is still red and the turn does not close on a red suite. Either',
      '  fix them, or say plainly that they are out of scope and why.',
    )
  }

  if (verdict.evidence === 'exit-code-only') {
    parts.push(
      '',
      '  note: no test identifiers could be parsed from this runner\'s output, so',
      '  the nonzero exit code is the only evidence. Read the output below yourself',
      '  rather than trusting any list above to be complete.',
    )
  } else if (verdict.evidence === 'named') {
    parts.push(
      '',
      '  note: there is no usable session baseline, so this list is "failing now",',
      '  not "newly failing" — it cannot tell a break you made from one you found.',
    )
  }

  if (baseline === undefined) {
    parts.push(
      '',
      '  note: no baseline run was captured for this session, so this is an',
      '  exit-code check only — it cannot tell a new break from a pre-existing one.',
    )
  } else if (baseline.source !== 'startup') {
    parts.push(
      '',
      `  note: the baseline was captured at session ${baseline.source}, not before`,
      '  the first edit, so "not failing at the session baseline" means "not failing',
      '  at that point", which may already include earlier changes.',
    )
  }

  parts.push(
    '',
    `--- first ${String(Math.min(FEEDBACK_LINES, lines.length))} line(s) of output ---`,
    head,
  )
  if (rest > 0) parts.push(`... [${String(rest)} more line(s) not shown] ...`)
  parts.push(
    '--- end of output ---',
    '',
    'Fix the cause in the code under test. Do not weaken, skip, delete, or rewrite',
    'a test to make this pass, and do not change the verify command — the same',
    'command runs again when you next stop, and it decides. If you believe the test',
    'itself is wrong, say so explicitly and explain why rather than editing it',
    'quietly. If you are genuinely stuck, say that too and stop; a human is watching.',
  )
  return parts.join('\n')
}
