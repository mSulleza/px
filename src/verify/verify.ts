/**
 * Verification. The machine owns the verdict.
 *
 * The model is not allowed to say "done". It is allowed to produce a diff; a
 * real test command decides whether that diff lands. Two things here make that
 * verdict trustworthy:
 *
 *  1. `regressed()`. An exit-code-only check certifies a change that fixes the
 *     target test and breaks two others, because it only ever sees "0 before,
 *     0 after" on the test it was pointed at. Comparing failing-test *sets*
 *     against a baseline taken before the edit is what catches that.
 *  2. Environment. Runners are spawned with CI=1 and NO_COLOR=1. CI stops
 *     vitest/jest from dropping into watch mode and hanging until the timeout
 *     kills them; NO_COLOR stops ANSI escapes from landing in the middle of the
 *     "(fail) name" lines this file has to parse.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface VerifyResult {
  exitCode: number;
  /** Combined stdout then stderr. Runners disagree on which they use: pytest
   *  writes results to stdout, `bun test` writes all of them to stderr.
   *
   *  Capped at 4 MiB, which is an OOM bound, not a context bound — 4 MiB is
   *  more than the whole window. Anything putting this in front of the model
   *  runs it through truncateOutput() first. */
  output: string;
  failing: string[];
  timedOut: boolean;
}

export interface VerifyCommand {
  cmd: string;
  /** Where the command came from, for the status line: ".px/verify.toml" etc. */
  source: string;
}

/** A test suite that has not finished in five minutes is a hang, not a suite. */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** Captured output is bounded; a runner that streams forever must not OOM px. */
const OUTPUT_CAP_BYTES = 4 * 1024 * 1024;

/** Grace given to the pipes after a kill before we report what we already have. */
const DRAIN_GRACE_MS = 300;

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

/**
 * Find the command that decides this repo's verdict.
 *
 * Order is explicit-over-inferred: a `.px/verify.toml` the user wrote beats
 * anything px can guess from the file tree. Returns null rather than a default,
 * because a guessed command that exits 0 for the wrong reason is worse than no
 * verification at all — the caller must decide to refuse the task loudly.
 */
export function resolveVerifyCommand(root: string): VerifyCommand | null {
  const declared = readVerifyToml(root);
  if (declared) return { cmd: declared, source: ".px/verify.toml" };

  const pkg = readJson(join(root, "package.json"));
  if (pkg) {
    const scripts = pkg["scripts"];
    const test = isRecord(scripts) ? scripts["test"] : undefined;
    if (typeof test === "string" && test.trim() !== "") {
      const bun = existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"));
      return { cmd: bun ? "bun test" : "npm test", source: "package.json scripts.test" };
    }
  }

  if (hasPythonTests(root)) return { cmd: "pytest", source: "pytest layout" };
  if (existsSync(join(root, "Cargo.toml"))) return { cmd: "cargo test", source: "Cargo.toml" };
  if (existsSync(join(root, "go.mod"))) return { cmd: "go test ./...", source: "go.mod" };

  const mk = makefileWithTestTarget(root);
  if (mk) return { cmd: "make test", source: `${mk} test target` };

  return null;
}

/**
 * Read the single key px cares about out of .px/verify.toml.
 *
 * Deliberately not a TOML parser: one key, one line, no dependency. Anything
 * fancier in that file is ignored rather than half-understood.
 */
function readVerifyToml(root: string): string | null {
  const path = join(root, ".px", "verify.toml");
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    // The file exists, so the repo has declared its contract. Falling back to an
    // inferred command here would silently verify with a DIFFERENT runner than
    // the one the repo committed — a wrong verdict that looks like a right one.
    throw new Error(
      `${path} exists but could not be read (${e instanceof Error ? e.message : String(e)}). ` +
        `Fix or remove it; px will not guess a verify command around a declared one.`,
    );
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^cmd\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    const rhs = m[1]!.trim();
    const q = rhs[0];
    let value: string;
    if (q === '"' || q === "'") {
      const end = rhs.indexOf(q, 1);
      if (end === -1) throw new Error(`${path}: unterminated quote on cmd = ...`);
      value = rhs.slice(1, end);
    } else {
      const hash = rhs.indexOf("#");
      value = (hash === -1 ? rhs : rhs.slice(0, hash)).trim();
    }
    if (value !== "") return value;
  }
  return null;
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "dist",
  "build",
  "target",
  ".px",
]);

/** pytest's own default collection names, so `tests/utils.py` is not evidence. */
const PYTEST_FILE = /^(?:test_.*|.*_test)\.py$/;

/**
 * A test_*.py / *_test.py within two levels. Bounded on purpose.
 *
 * Deliberately NOT "a `tests/` directory exists": `tests/` is where Cargo puts
 * integration tests, so that shortcut resolved every idiomatic Rust crate — and
 * any Go repo with a tests/ dir — to `pytest`, which exits 5 ("no tests ran")
 * identically on the baseline and on the edited tree. The delta is empty both
 * times and the repo's real suite never runs, which is the exact failure this
 * module exists to prevent.
 */
function hasPythonTests(root: string, depth = 2): boolean {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return false;
  }
  const dirs: string[] = [];
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(root, name);
    if (isDir(full)) {
      dirs.push(full);
      continue;
    }
    if (PYTEST_FILE.test(name)) return true;
  }
  if (depth <= 0) return false;
  for (const d of dirs) if (hasPythonTests(d, depth - 1)) return true;
  return false;
}

function makefileWithTestTarget(root: string): string | null {
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    // A target definition: not `.PHONY: test` (that line starts with .PHONY) and
    // not `test := ...` (a variable named test, which `make test` cannot run).
    // `test::` double-colon rules still count.
    if (/^test\s*:(?!=)/m.test(text)) return name;
  }
  return null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------

export async function runVerify(root: string, cmd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<VerifyResult> {
  const proc = Bun.spawn({
    cmd: ["/bin/sh", "-c", cmd],
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // CI stops watch-mode runners (vitest, jest --watch) from waiting on a TTY
      // that will never answer; without it every such repo "times out".
      CI: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });

  const out: Buf = { text: "", bytes: 0, dropped: 0 };
  const err: Buf = { text: "", bytes: 0, dropped: 0 };
  const drains = Promise.all([drain(proc.stdout, out), drain(proc.stderr, err)]);

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  await Promise.race([proc.exited, deadline]);
  if (timer) clearTimeout(timer);

  if (timedOut) {
    proc.kill("SIGKILL");
    // The shell dies immediately; a grandchild holding the pipe open may not,
    // so the drains are raced rather than awaited. Whatever arrived is enough
    // to tell the model its suite hung.
    await Promise.race([drains, sleep(DRAIN_GRACE_MS)]);
  } else {
    await drains;
  }

  const exitCode = timedOut ? 124 : await proc.exited;
  const output = joinStreams(out, err);
  return { exitCode, output, failing: parseFailing(output), timedOut };
}

interface Buf {
  text: string;
  /** Decoded bytes kept. Counted in bytes, not UTF-16 units, so the cap and the
   *  "N bytes dropped" marker are the same unit. */
  bytes: number;
  dropped: number;
}

async function drain(stream: ReadableStream<Uint8Array> | undefined | null, buf: Buf): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (buf.bytes >= OUTPUT_CAP_BYTES) {
        buf.dropped += value.byteLength;
        continue;
      }
      buf.bytes += value.byteLength;
      buf.text += dec.decode(value, { stream: true });
    }
    buf.text += dec.decode();
  } catch {
    // Reader torn down by the kill. Keep what we have.
  } finally {
    reader.releaseLock();
  }
}

function joinStreams(out: Buf, err: Buf): string {
  const parts: string[] = [];
  if (out.text) parts.push(out.text);
  if (err.text) parts.push(err.text);
  const dropped = out.dropped + err.dropped;
  if (dropped > 0) parts.push(`... [${dropped} bytes dropped: verify output exceeded ${OUTPUT_CAP_BYTES} bytes] ...`);
  return parts.join(parts.length > 1 ? "\n" : "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

// Timings differ run to run. Leaving "[1.23ms]" on an identifier would make
// every failure look new to regressed(), which is the one thing it must not do.
const BRACKET_TIMING = /\s*\[\s*[\d.]+\s*(?:ns|µs|us|ms|s)\s*\]\s*$/;
const PAREN_TIMING = /\s*\(\s*[\d.]+\s*(?:ns|µs|us|ms|s)\s*\)\s*$/;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Failing test identifiers, per runner. Unknown output yields [], which the
 * caller must read as "no evidence", never as "nothing failed" — that is why
 * exit code and `failing` are separate fields on VerifyResult.
 */
export function parseFailing(output: string): string[] {
  const found = new Set<string>();
  for (const rawLine of output.replace(ANSI, "").split("\n")) {
    const line = rawLine.replace(/\r/g, "");
    const trimmed = line.trim();

    // pytest short summary: FAILED tests/test_a.py::test_b - AssertionError
    let m = /^FAILED\s+(\S+)/.exec(trimmed);
    if (m) {
      found.add(m[1]!);
      continue;
    }
    // pytest -v: tests/test_a.py::test_b FAILED  [ 50%]
    m = /^(\S+::\S+)\s+FAILED\b/.exec(trimmed);
    if (m) {
      found.add(m[1]!);
      continue;
    }
    // cargo: test tests::adds ... FAILED
    m = /^test\s+(\S+)\s+\.\.\.\s+FAILED\b/.exec(trimmed);
    if (m) {
      found.add(m[1]!);
      continue;
    }
    // go: --- FAIL: TestAdd (0.00s), including indented subtests
    m = /^---\s+FAIL:\s+(\S+)/.exec(trimmed);
    if (m) {
      found.add(m[1]!);
      continue;
    }
    // bun: (fail) math > adds [1.23ms]
    m = /^\(fail\)\s+(.+)$/.exec(trimmed);
    if (m) {
      const name = cleanName(m[1]!);
      if (name) found.add(name);
      continue;
    }
    // jest/vitest tick marks: ✗ adds (5 ms) / ✕ adds / × adds 3ms.
    // U+00D7 is what vitest's default reporter actually prints; without it the
    // most common npm-test runner parses to [] and the gate silently degrades
    // to an exit-code check.
    m = /^[✗✕×]\s+(.+)$/.exec(trimmed);
    if (m) {
      const name = cleanName(m[1]!);
      if (name) found.add(name);
    }
  }
  return [...found].sort();
}

function cleanName(s: string): string {
  return s.replace(BRACKET_TIMING, "").replace(PAREN_TIMING, "").trim();
}

/**
 * Tests failing now that were not failing before the change.
 *
 * This is the gate. A fix that repairs the target test and breaks two others
 * exits non-zero on both runs, so exit codes cannot tell the two runs apart;
 * the set difference can.
 *
 * A caveat the caller owns: if `after` failed to build, its failing set is
 * empty and this returns []. Empty here means "no new named failures", not
 * "safe to land" — check exitCode too.
 */
export function regressed(baseline: VerifyResult, after: VerifyResult): string[] {
  const before = new Set(baseline.failing);
  return after.failing.filter((t) => !before.has(t)).sort();
}
