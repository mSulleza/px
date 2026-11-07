/**
 * Verify + worktree.
 *
 * The parser cases are captured runner output rather than invented strings:
 * what breaks parseFailing is the stuff nobody would think to invent — cargo's
 * "test result: FAILED." summary and "---- name stdout ----" banner, go's
 * indented subtest, ANSI wrapped around "(fail)".
 *
 * The git cases run against a throwaway repo under /private/tmp. Nothing here
 * may touch the px checkout itself.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseFailing, regressed, resolveVerifyCommand, runVerify, type VerifyResult } from "../src/verify/verify.ts";
import {
  assertParentClean,
  createWorktree,
  diff,
  diffStat,
  gitRoot,
  land,
  removeWorktree,
} from "../src/worktree/worktree.ts";

// ---------------------------------------------------------------------------
// scratch space
// ---------------------------------------------------------------------------

const tmps: string[] = [];

function tmp(prefix: string): string {
  const d = mkdtempSync(join("/private/tmp", `px-${prefix}-`));
  tmps.push(d);
  return d;
}

function sh(cwd: string, cmd: string): string {
  const p = Bun.spawnSync({
    cmd: ["/bin/sh", "-c", cmd],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, LC_ALL: "C" },
  });
  const dec = new TextDecoder();
  const out = dec.decode(p.stdout) + dec.decode(p.stderr);
  if (p.exitCode !== 0) throw new Error(`setup command failed (${cmd}): ${out}`);
  return out.trim();
}

/** A repo with one commit on main. */
function makeRepo(): string {
  const dir = tmp("repo");
  sh(dir, "git init -q -b main");
  sh(dir, "git config user.email px@test.invalid && git config user.name px && git config commit.gpgsign false");
  writeFileSync(join(dir, "README.md"), "base\n");
  sh(dir, "git add -A && git commit -q -m initial");
  return dir;
}

afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseFailing
// ---------------------------------------------------------------------------

const PYTEST = `============================= test session starts ==============================
collected 4 items

tests/test_math.py::test_add PASSED                                      [ 25%]
tests/test_math.py::test_sub FAILED                                      [ 50%]

=================================== FAILURES ===================================
___________________________________ test_sub ___________________________________
E       assert 1 == 2
=========================== short test summary info ============================
FAILED tests/test_math.py::test_sub - assert 1 == 2
FAILED tests/test_pkg.py::TestThing::test_method - ValueError: nope
========================= 2 failed, 2 passed in 0.12s ==========================`;

const BUN = `bun test v1.2.13

test/frag.test.ts:
(pass) frag > freezes the fragment [0.52ms]
(fail) frag > rejects duplicate ids [1.23ms]
(fail) frag > replays the id verbatim [0.31ms]

 1 pass
 2 fail
Ran 3 tests across 1 file.`;

const JEST = `  math
    ✓ adds (2 ms)
    ✕ subtracts (5 ms)
    ✗ divides`;

const CARGO = `running 3 tests
test tests::adds ... ok
test tests::subtracts ... FAILED
test tests::divides ... FAILED

failures:

---- tests::subtracts stdout ----
thread 'tests::subtracts' panicked at src/lib.rs:12:9:
assertion failed: left == right

failures:
    tests::divides
    tests::subtracts

test result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured`;

const GO = `=== RUN   TestAdd
--- FAIL: TestAdd (0.00s)
    math_test.go:12: got 3 want 4
=== RUN   TestTable
=== RUN   TestTable/negative
    --- FAIL: TestTable/negative (0.00s)
--- FAIL: TestTable (0.00s)
FAIL
exit status 1
FAIL\texample.com/m\t0.152s`;

test("parseFailing: pytest short summary and -v lines", () => {
  expect(parseFailing(PYTEST)).toEqual(["tests/test_math.py::test_sub", "tests/test_pkg.py::TestThing::test_method"]);
});

test("parseFailing: bun (fail) lines, timings stripped", () => {
  expect(parseFailing(BUN)).toEqual(["frag > rejects duplicate ids", "frag > replays the id verbatim"]);
});

test("parseFailing: jest tick marks, both glyphs, timings stripped", () => {
  expect(parseFailing(JEST)).toEqual(["divides", "subtracts"]);
});

test("parseFailing: cargo, ignoring the failures banner and the result line", () => {
  expect(parseFailing(CARGO)).toEqual(["tests::divides", "tests::subtracts"]);
});

test("parseFailing: go, including indented subtests", () => {
  expect(parseFailing(GO)).toEqual(["TestAdd", "TestTable", "TestTable/negative"]);
});

test("parseFailing: colour codes do not hide a failure", () => {
  const esc = String.fromCharCode(27); // ESC, as every runner emits it before a colour code
  const coloured = `${esc}[31m(fail)${esc}[0m frag > rejects duplicate ids ${esc}[2m[1.23ms]${esc}[0m`;
  expect(parseFailing(coloured)).toEqual(["frag > rejects duplicate ids"]);
});

test("parseFailing: vitest's default reporter glyph", () => {
  // U+00D7, not the U+2715/U+2717 jest uses. vitest is what `npm test` runs in
  // most JS repos, so missing it degrades the gate to an exit-code check.
  expect(parseFailing(" \u00d7 src/a.test.ts > adds 3ms\n \u2713 src/a.test.ts > subs 1ms")).toEqual([
    "src/a.test.ts > adds 3ms",
  ]);
});

test("parseFailing: unknown format yields no evidence, not a false pass", () => {
  expect(parseFailing("everything is fine\nmaybe\n")).toEqual([]);
  expect(parseFailing("")).toEqual([]);
});

test("parseFailing: duplicates collapse and order is stable", () => {
  expect(parseFailing(`${GO}\n${GO}`)).toEqual(["TestAdd", "TestTable", "TestTable/negative"]);
});

test("parseFailing: the same test at a different speed is the same identifier", () => {
  expect(parseFailing("(fail) frag > freezes [1.23ms]")).toEqual(parseFailing("(fail) frag > freezes [8.90ms]"));
});

// ---------------------------------------------------------------------------
// regressed
// ---------------------------------------------------------------------------

function vr(failing: string[], exitCode = 1): VerifyResult {
  return { exitCode, output: "", failing, timedOut: false };
}

test("regressed: a failure that was already there is not a regression", () => {
  expect(regressed(vr(["tests/test_math.py::test_sub"]), vr(["tests/test_math.py::test_sub"]))).toEqual([]);
});

test("regressed: fixing the target while breaking two others is caught", () => {
  // Both runs exit non-zero, so exit codes cannot tell them apart. The set
  // difference can. This case is the reason this function exists.
  const baseline = vr(["tests/test_math.py::test_sub"]);
  const after = vr(["tests/test_str.py::test_upper", "tests/test_io.py::test_read"]);
  expect(regressed(baseline, after)).toEqual(["tests/test_io.py::test_read", "tests/test_str.py::test_upper"]);
});

test("regressed: a clean run against a dirty baseline regresses nothing", () => {
  expect(regressed(vr(["a", "b"]), vr([], 0))).toEqual([]);
});

// ---------------------------------------------------------------------------
// resolveVerifyCommand
// ---------------------------------------------------------------------------

test("resolveVerifyCommand: nothing to run", () => {
  expect(resolveVerifyCommand(tmp("empty"))).toBeNull();
});

test("resolveVerifyCommand: .px/verify.toml wins over everything inferred", () => {
  const d = tmp("toml");
  mkdirSync(join(d, ".px"));
  writeFileSync(join(d, ".px", "verify.toml"), '# px\n[verify]\ncmd = "pytest -x tests/unit"  # fast lane\n');
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
  writeFileSync(join(d, "Cargo.toml"), "[package]\n");
  expect(resolveVerifyCommand(d)).toEqual({ cmd: "pytest -x tests/unit", source: ".px/verify.toml" });
});

test("resolveVerifyCommand: single-quoted and bare toml values", () => {
  const a = tmp("toml2");
  mkdirSync(join(a, ".px"));
  writeFileSync(join(a, ".px", "verify.toml"), "cmd = 'make check'\n");
  expect(resolveVerifyCommand(a)?.cmd).toBe("make check");

  const b = tmp("toml3");
  mkdirSync(join(b, ".px"));
  writeFileSync(join(b, ".px", "verify.toml"), "cmd = go test ./...  # bare\n");
  expect(resolveVerifyCommand(b)?.cmd).toBe("go test ./...");
});

test("resolveVerifyCommand: package.json, and the bun lockfile picks the runner", () => {
  const npm = tmp("npm");
  writeFileSync(join(npm, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  expect(resolveVerifyCommand(npm)).toEqual({ cmd: "npm test", source: "package.json scripts.test" });

  const bun = tmp("bun");
  writeFileSync(join(bun, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  writeFileSync(join(bun, "bun.lock"), "{}\n");
  expect(resolveVerifyCommand(bun)?.cmd).toBe("bun test");
});

test("resolveVerifyCommand: a package.json without a test script falls through", () => {
  const d = tmp("nopkgtest");
  writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
  writeFileSync(join(d, "go.mod"), "module example.com/m\n");
  expect(resolveVerifyCommand(d)?.cmd).toBe("go test ./...");
});

test("resolveVerifyCommand: python layouts", () => {
  const dir = tmp("py");
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "tests", "test_math.py"), "");
  expect(resolveVerifyCommand(dir)).toEqual({ cmd: "pytest", source: "pytest layout" });

  const flat = tmp("py2");
  writeFileSync(join(flat, "test_thing.py"), "");
  expect(resolveVerifyCommand(flat)?.cmd).toBe("pytest");

  const nested = tmp("py3");
  mkdirSync(join(nested, "pkg"));
  writeFileSync(join(nested, "pkg", "test_thing.py"), "");
  expect(resolveVerifyCommand(nested)?.cmd).toBe("pytest");

  // pytest's other default collection name.
  const suffix = tmp("py4");
  mkdirSync(join(suffix, "tests"));
  writeFileSync(join(suffix, "tests", "math_test.py"), "");
  expect(resolveVerifyCommand(suffix)?.cmd).toBe("pytest");
});

test("resolveVerifyCommand: a bare tests/ dir is not a python project", () => {
  // `tests/` is Cargo's integration-test directory, so "the directory exists"
  // sent every idiomatic Rust crate to pytest, which exits 5 on the baseline and
  // 5 after the edit — an empty delta both times, with the crate's real suite
  // never run. Evidence has to be an actual pytest-named file.
  const rust = tmp("rs-tests");
  writeFileSync(join(rust, "Cargo.toml"), '[package]\nname = "x"\n');
  mkdirSync(join(rust, "tests"));
  writeFileSync(join(rust, "tests", "integration.rs"), "#[test] fn t() {}\n");
  expect(resolveVerifyCommand(rust)).toEqual({ cmd: "cargo test", source: "Cargo.toml" });

  const go = tmp("go-tests");
  writeFileSync(join(go, "go.mod"), "module example.com/m\n");
  mkdirSync(join(go, "tests"));
  writeFileSync(join(go, "tests", "e2e_test.go"), "package tests\n");
  expect(resolveVerifyCommand(go)).toEqual({ cmd: "go test ./...", source: "go.mod" });

  const empty = tmp("bare-tests");
  mkdirSync(join(empty, "tests"));
  expect(resolveVerifyCommand(empty)).toBeNull();
});

test("resolveVerifyCommand: a test_*.py under node_modules is not a python project", () => {
  const d = tmp("nm");
  mkdirSync(join(d, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(d, "node_modules", "junk", "test_thing.py"), "");
  expect(resolveVerifyCommand(d)).toBeNull();
});

test("resolveVerifyCommand: cargo, go, make", () => {
  const rust = tmp("rs");
  writeFileSync(join(rust, "Cargo.toml"), '[package]\nname = "x"\n');
  expect(resolveVerifyCommand(rust)).toEqual({ cmd: "cargo test", source: "Cargo.toml" });

  const go = tmp("go");
  writeFileSync(join(go, "go.mod"), "module example.com/m\n");
  expect(resolveVerifyCommand(go)).toEqual({ cmd: "go test ./...", source: "go.mod" });

  const make = tmp("make");
  writeFileSync(join(make, "Makefile"), ".PHONY: test build\n\nbuild:\n\tcc x.c\n\ntest: build\n\t./a.out\n");
  expect(resolveVerifyCommand(make)).toEqual({ cmd: "make test", source: "Makefile test target" });

  const phonyOnly = tmp("make2");
  writeFileSync(join(phonyOnly, "Makefile"), ".PHONY: test\n\nbuild:\n\tcc x.c\n");
  expect(resolveVerifyCommand(phonyOnly)).toBeNull();

  // `test := ...` is a variable named test. `make test` would exit "no rule".
  const variable = tmp("make3");
  writeFileSync(join(variable, "Makefile"), "test := ./run.sh\n\nbuild:\n\tcc x.c\n");
  expect(resolveVerifyCommand(variable)).toBeNull();

  // Double-colon rules are still targets.
  const double = tmp("make4");
  writeFileSync(join(double, "Makefile"), "test::\n\t./run.sh\n");
  expect(resolveVerifyCommand(double)?.cmd).toBe("make test");
});

test("resolveVerifyCommand: a declared contract that cannot be read is loud, not guessed", () => {
  // Silently inferring `go test ./...` here would verify with a different runner
  // than the repo committed, and report the answer as if it were the real one.
  const d = tmp("badtoml");
  mkdirSync(join(d, ".px"));
  mkdirSync(join(d, ".px", "verify.toml")); // a directory where the file should be
  writeFileSync(join(d, "go.mod"), "module example.com/m\n");
  expect(() => resolveVerifyCommand(d)).toThrow(/could not be read/);
});

// ---------------------------------------------------------------------------
// runVerify
// ---------------------------------------------------------------------------

test("runVerify: exit code and both streams are captured", async () => {
  const d = tmp("run");
  const r = await runVerify(d, "echo to-stdout; echo to-stderr 1>&2; exit 3");
  expect(r.exitCode).toBe(3);
  expect(r.timedOut).toBe(false);
  expect(r.output).toContain("to-stdout");
  expect(r.output).toContain("to-stderr");
});

test("runVerify: runs in the given root", async () => {
  const d = tmp("cwd");
  writeFileSync(join(d, "marker.txt"), "x");
  const r = await runVerify(d, "ls");
  expect(r.exitCode).toBe(0);
  expect(r.output).toContain("marker.txt");
});

test("runVerify: failing output is parsed on the way out", async () => {
  const d = tmp("parse");
  const r = await runVerify(d, "printf '%s\\n' '--- FAIL: TestAdd (0.00s)'; exit 1");
  expect(r.failing).toEqual(["TestAdd"]);
});

test("runVerify: a hang is killed and reported, not awaited", async () => {
  const d = tmp("hang");
  const started = Date.now();
  const r = await runVerify(d, "echo starting; sleep 30", 400);
  expect(r.timedOut).toBe(true);
  expect(r.exitCode).not.toBe(0);
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("runVerify: CI and NO_COLOR are set for the runner", async () => {
  const d = tmp("ci");
  const r = await runVerify(d, "echo CI=$CI NO_COLOR=$NO_COLOR");
  expect(r.output).toContain("CI=1");
  expect(r.output).toContain("NO_COLOR=1");
});

// ---------------------------------------------------------------------------
// worktree
// ---------------------------------------------------------------------------

let repo = "";
let wtRoot = "";

beforeAll(() => {
  repo = makeRepo();
  wtRoot = tmp("worktrees");
});

test("gitRoot: finds the repo, and says so plainly when there is none", () => {
  expect(gitRoot(repo)).toBe(repo);
  mkdirSync(join(repo, "deep", "nested"), { recursive: true });
  expect(gitRoot(join(repo, "deep", "nested"))).toBe(repo);
  rmSync(join(repo, "deep"), { recursive: true, force: true });
  expect(() => gitRoot(tmp("norepo"))).toThrow(/not inside a git repository/);
});

test("createWorktree: a repo with no commits is named as the problem", async () => {
  const bare = tmp("fresh");
  sh(bare, "git init -q -b main");
  await expect(createWorktree(bare, "t0", join(bare, "wt"))).rejects.toThrow(/no commits yet/);
});

test("createWorktree: a task id that is not a safe path is refused", async () => {
  await expect(createWorktree(repo, "../escape", wtRoot)).rejects.toThrow(/not usable as a path/);
});

test(
  "worktree round trip: create, commit, diff, land, remove",
  async () => {
    const wt = await createWorktree(repo, "t1", wtRoot);
    expect(wt.branch).toBe("px/t1");
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);

    // The parent is untouched while px works. That is the whole point.
    await assertParentClean(repo);

    // Untracked: git diff would not mention it, so diffStat has to.
    writeFileSync(join(wt.path, "added.txt"), "hello\n");
    expect(await diffStat(wt.path)).toContain("added.txt");

    sh(wt.path, "git add -A && git commit -q -m 'add a file'");

    // And once committed, a diff against HEAD would show nothing — hence the
    // merge-base with the parent checkout.
    expect(await diffStat(wt.path)).toContain("added.txt");
    expect(await diff(wt.path)).toContain("+hello");

    const landed = await land(repo, wt.branch);
    expect(landed.merged).toBe(true);
    expect(existsSync(join(repo, "added.txt"))).toBe(true);
    await assertParentClean(repo);

    await removeWorktree(repo, wt.path);
    expect(existsSync(wt.path)).toBe(false);
    // Merged, so the branch holds nothing of its own and is cleaned up.
    expect(sh(repo, "git branch --list px/t1")).toBe("");
  },
  30_000,
);

test(
  "land: refuses a dirty parent rather than moving HEAD under it",
  async () => {
    const wt = await createWorktree(repo, "t2", wtRoot);
    writeFileSync(join(wt.path, "two.txt"), "two\n");
    sh(wt.path, "git add -A && git commit -q -m two");

    writeFileSync(join(repo, "user-edit.txt"), "the user was mid-thought\n");
    const refused = await land(repo, wt.branch);
    expect(refused.merged).toBe(false);
    expect(refused.message).toContain("not clean");
    expect(existsSync(join(repo, "two.txt"))).toBe(false);

    rmSync(join(repo, "user-edit.txt"));
    const ok = await land(repo, wt.branch);
    expect(ok.merged).toBe(true);
    await removeWorktree(repo, wt.path);
  },
  30_000,
);

test(
  "land: a diverged branch is refused, never merged or rebased",
  async () => {
    const wt = await createWorktree(repo, "t3", wtRoot);
    writeFileSync(join(wt.path, "three.txt"), "three\n");
    sh(wt.path, "git add -A && git commit -q -m three");

    // The parent moves on while px works: no longer a fast-forward.
    writeFileSync(join(repo, "parent.txt"), "parent moved\n");
    sh(repo, "git add -A && git commit -q -m 'parent moved'");

    const r = await land(repo, wt.branch);
    expect(r.merged).toBe(false);
    expect(r.message).toContain("fast-forward");
    expect(existsSync(join(repo, "three.txt"))).toBe(false);

    // Unmerged commits survive removal: the branch is kept for the user.
    await removeWorktree(repo, wt.path);
    expect(sh(repo, "git branch --list px/t3")).toContain("px/t3");
    sh(repo, "git branch -D px/t3");
  },
  30_000,
);

test(
  "diffStat: an untracked path is reported as its real name, not git's C-quoting",
  async () => {
    // git quotes any path with a space or a non-ASCII byte unless asked not to.
    // The model reads this list as "files I created" and then opens one of them.
    const wt = await createWorktree(repo, "t5", wtRoot);
    writeFileSync(join(wt.path, "two words.txt"), "hi\n");
    writeFileSync(join(wt.path, "na\u00efve.txt"), "hi\n");
    const stat = await diffStat(wt.path);
    expect(stat).toContain("two words.txt");
    expect(stat).toContain("na\u00efve.txt");
    expect(stat).not.toContain("\\303");
    await removeWorktree(repo, wt.path);
  },
  30_000,
);

test("assertParentClean: fails loudly and names the offending paths", async () => {
  writeFileSync(join(repo, "stray.txt"), "px should never write here\n");
  await expect(assertParentClean(repo)).rejects.toThrow(/stray\.txt/);
  rmSync(join(repo, "stray.txt"));
  await assertParentClean(repo);
});

test(
  "removeWorktree: cleaning up a path that is already gone is not an error",
  async () => {
    const wt = await createWorktree(repo, "t4", wtRoot);
    rmSync(wt.path, { recursive: true, force: true });
    await removeWorktree(repo, wt.path);
    expect(sh(repo, "git branch --list px/t4")).toBe("");
  },
  30_000,
);
