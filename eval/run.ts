#!/usr/bin/env bun
/**
 * The regression eval.
 *
 * One number decides anything here: dollars per COMPLETED task. Pass rate on
 * its own is a vanity metric (a harness with no step limit passes eventually),
 * and mean cost on its own is a vanity metric pointing the other way (a harness
 * that gives up on turn two is very cheap). Only the ratio moves when the
 * harness actually improves, so it is the column everything else supports.
 *
 * Three rules this file exists to enforce, each one a bug it has to be immune to:
 *
 *  1. The eval re-runs verification itself, after the agent has stopped, and
 *     scores THAT exit code. RunResult.outcome is recorded but never believed.
 *     t05 is in the suite specifically because a harness can report success on
 *     a repo whose tests were already green before it touched anything.
 *  2. Every task's baseline is measured before any trial runs. A verify_cmd
 *     that already exits 0 on the pristine fixture cannot discriminate between
 *     anything, so the task is refused loudly instead of quietly contributing a
 *     100% pass rate.
 *  3. Every trial gets its own copy of fixture/ with its own git init and
 *     commit. Trials never share a directory, so one that leaves the tree
 *     wrecked cannot contaminate its successor.
 *
 * Usage:
 *   bun run eval/run.ts --self-test                 # no API key needed
 *   bun run eval/run.ts --tasks t01,t02 --trials 3 --config lane-e
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, type PxConfig } from "../src/config.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { isPeak } from "../src/schedule/offpeak.ts";
import { Ui } from "../src/ui/render.ts";
import { sha256 } from "../src/wire/canon.ts";
import type { RunResult } from "../src/types.ts";
import type { RunTaskOpts } from "../src/agent/loop.ts";

const EVAL_DIR = import.meta.dir;
const TASKS_DIR = join(EVAL_DIR, "tasks");
const RESULTS_DIR = join(EVAL_DIR, "results");

/** A suite that has not finished in five minutes is a hang, not a suite. */
const VERIFY_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

interface GroundTruth {
  kind: string;
  detail: string;
}

interface TaskSpec {
  id: string;
  prompt: string;
  verifyCmd: string;
  groundTruth: GroundTruth;
  /**
   * Files the agent is told not to touch and that the eval hashes before and
   * after. Without this, t01 is solvable by editing the expected value in the
   * test — which is the single most common way a cheap model "passes" a fix
   * task, and exactly the behaviour the eval exists to price.
   */
  immutablePaths: string[];
  dir: string;
}

/**
 * px resolves a repo's verdict from .px/verify.toml before anything it can
 * infer, so the trial repo carries the task's command there. It is written
 * before the initial commit: a trial must start on a clean tree, or the diff
 * the loop reports at the end is meaningless.
 */
const VERIFY_TOML_PATH = ".px/verify.toml";

function loadTask(dir: string): TaskSpec {
  const path = join(dir, "task.json");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw)) throw new Error(`${path}: not a JSON object`);

  const id = str(raw["id"], path, "id");
  const prompt = str(raw["prompt"], path, "prompt");
  const verifyCmd = str(raw["verify_cmd"], path, "verify_cmd");

  const gt = raw["ground_truth"];
  if (!isRecord(gt)) throw new Error(`${path}: ground_truth must be an object`);
  const groundTruth: GroundTruth = {
    kind: str(gt["kind"], path, "ground_truth.kind"),
    detail: str(gt["detail"], path, "ground_truth.detail"),
  };

  // px's .px/verify.toml reader is one line of regex, not a TOML parser: it
  // takes everything up to the next quote (src/verify/verify.ts). A command
  // containing a quote or a newline would therefore be silently TRUNCATED, and
  // the loop would verify with a different command than the eval scores with —
  // two verdicts that look like one. Refuse the task instead.
  if (/["\n]/.test(verifyCmd)) {
    throw new Error(
      `${path}: verify_cmd must not contain a quote or a newline — .px/verify.toml ` +
        `holds it on one line and px's reader would truncate it there.`,
    );
  }

  const imm = raw["immutable_paths"] ?? [];
  if (!Array.isArray(imm)) throw new Error(`${path}: immutable_paths must be an array`);
  const immutablePaths = imm.map((p, i) => {
    const rel = str(p, path, `immutable_paths[${i}]`);
    // These are join()ed onto the trial repo and hashed. A path that climbs out
    // of it would hash a file no trial can touch and so could never register a
    // violation — an immutability guarantee that silently guarantees nothing.
    if (rel.startsWith("/") || rel.split("/").includes("..")) {
      throw new Error(`${path}: immutable_paths[${i}] must be relative to the fixture root and stay inside it`);
    }
    return rel;
  });

  if (!existsSync(join(dir, "fixture"))) throw new Error(`${dir}: no fixture/ directory`);
  // The eval's own verification plumbing is always protected, whatever the task says.
  immutablePaths.push(VERIFY_TOML_PATH);

  return { id, prompt, verifyCmd, groundTruth, immutablePaths, dir };
}

function discoverTasks(filter: string[]): TaskSpec[] {
  const all = readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(TASKS_DIR, e.name, "task.json")))
    .map((e) => loadTask(join(TASKS_DIR, e.name)))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  if (filter.length === 0) return all;
  const picked = all.filter((t) => filter.some((f) => t.id === f || t.id.startsWith(f)));
  const missed = filter.filter((f) => !all.some((t) => t.id === f || t.id.startsWith(f)));
  if (missed.length > 0) {
    throw new Error(`unknown task(s): ${missed.join(", ")}. Available: ${all.map((t) => t.id).join(", ")}`);
  }
  return picked;
}

// ---------------------------------------------------------------------------
// configurations under test
// ---------------------------------------------------------------------------

/**
 * A "config" is a patch to PxConfig, which is the only knob the loop actually
 * reads. The lane is NOT one of them: the loop pins LANE_E for the life of a
 * session on purpose, because reasoning effort is a cache namespace rather
 * than a quality dial (src/lanes/policy.ts). An A/B that switched lanes would
 * be comparing two different prefix caches, not two harnesses.
 */
const CONFIGS: Record<string, (c: PxConfig) => PxConfig> = {
  "lane-e": (c) => c,
  "tight-budget": (c) => ({ ...c, budgetUsd: 0.05 }),
  "short-leash": (c) => ({ ...c, maxSteps: 12 }),
  "no-compact": (c) => ({ ...c, compactAtTokens: 1_000_000 }),
};

// ---------------------------------------------------------------------------
// the loop, loaded late
// ---------------------------------------------------------------------------

type RunTaskInDir = (
  dir: string,
  task: string,
  opts: Omit<RunTaskOpts, "task" | "cwd">,
) => Promise<RunResult>;

let cachedRunner: RunTaskInDir | null = null;

/**
 * Imported through a computed URL rather than a literal specifier, so a loop
 * that is missing or broken cannot stop `--self-test` from exercising the
 * tasks and fixtures. That separation is worth one ugly line: the fixtures are
 * the part of this directory that has to be trusted, and they must be
 * reviewable on their own.
 */
async function loadRunner(): Promise<RunTaskInDir> {
  if (cachedRunner) return cachedRunner;
  const url = new URL("../src/agent/loop.ts", import.meta.url).href;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `eval needs src/agent/loop.ts and it did not load: ${(e as Error).message}\n` +
        `Run \`bun run eval/run.ts --self-test\` to exercise the tasks without it.`,
    );
  }
  const fn = mod["runTaskInDir"];
  if (typeof fn !== "function") {
    throw new Error(
      "src/agent/loop.ts loaded but exports no runTaskInDir. The eval expects:\n" +
        "  export function runTaskInDir(dir: string, task: string, opts): Promise<RunResult>\n" +
        `Exports found: ${Object.keys(mod).join(", ") || "(none)"}`,
    );
  }
  cachedRunner = fn as RunTaskInDir;
  return cachedRunner;
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

interface ShellResult {
  code: number;
  output: string;
  ms: number;
}

/** Exit code `timeout(1)` uses. Only its non-zeroness matters: a verify run
 *  that had to be killed must score as a failure, never as a pass. */
const TIMEOUT_EXIT = 124;

async function drain(stream: ReadableStream<Uint8Array>, into: string[]): Promise<void> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) into.push(dec.decode(value, { stream: true }));
  }
  into.push(dec.decode());
}

/**
 * Run a command, capture both streams, and enforce a deadline that is real.
 *
 * The output is drained into arrays rather than through `new Response(s).text()`
 * because SIGKILL on /bin/sh does not kill a grandchild that inherited the pipe,
 * and while that grandchild lives the read side never sees EOF. Measured: a
 * `sleep 30 &` under a shell killed at 1s leaves `.text()` unsettled
 * indefinitely — so the old code's timeout killed the shell and then hung
 * forever waiting to read it, which is precisely the failure VERIFY_TIMEOUT_MS
 * exists to prevent. Draining into shared arrays keeps the partial output in
 * hand, so the deadline can simply be raced and the un-settleable read dropped.
 */
async function sh(cmd: string, cwd: string, timeoutMs = VERIFY_TIMEOUT_MS): Promise<ShellResult> {
  const t0 = Date.now();
  const proc = Bun.spawn(["/bin/sh", "-c", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      // Keeps __pycache__ out of the tree, so the residual-symbol grep in t02
      // never has to reason about whether a .pyc counts as an occurrence.
      PYTHONDONTWRITEBYTECODE: "1",
      PYTEST_ADDOPTS: "",
      GIT_TERMINAL_PROMPT: "0",
    },
  });

  const out: string[] = [];
  const err: string[] = [];
  const finished = Promise.all([drain(proc.stdout, out), drain(proc.stderr, err), proc.exited]);

  let killer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((r) => {
    killer = setTimeout(() => r("timeout"), timeoutMs);
  });
  const verdict = await Promise.race([finished.then(() => "done" as const), deadline]);
  clearTimeout(killer);

  const output = out.join("") + err.join("");
  if (verdict === "timeout") {
    proc.kill("SIGKILL");
    // Abandoning `finished` is the point of the race — it may never settle.
    // The catch is so that a read which errors out after the kill cannot
    // resurface as an unhandled rejection in the middle of the next trial.
    finished.catch(() => {});
    return {
      code: TIMEOUT_EXIT,
      output: `${output}\n[px eval] killed after ${(timeoutMs / 1000).toFixed(0)}s`,
      ms: Date.now() - t0,
    };
  }
  return { code: await proc.exited, output, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// trial repos
// ---------------------------------------------------------------------------

/**
 * Fresh repo per trial: copy fixture/, drop in the verify command, then git
 * init and commit so the agent starts from a clean tree it is allowed to dirty.
 * `-c` flags rather than `git config` calls, so the host's global identity,
 * hooks and gpg settings cannot change what the trial does.
 */
async function makeTrialRepo(task: TaskSpec, dest: string, overlay?: string): Promise<void> {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(join(task.dir, "fixture"), dest, { recursive: true });
  if (overlay) cpSync(overlay, dest, { recursive: true });

  mkdirSync(join(dest, ".px"), { recursive: true });
  await Bun.write(join(dest, VERIFY_TOML_PATH), `cmd = ${JSON.stringify(task.verifyCmd)}\n`);

  const git =
    "git init -q -b main && git add -A && " +
    "git -c user.email=eval@px.local -c user.name=px-eval -c commit.gpgsign=false " +
    'commit -q -m "fixture"';
  const r = await sh(git, dest, 60_000);
  if (r.code !== 0) throw new Error(`git setup failed in ${dest} (exit ${r.code}):\n${r.output}`);
}

async function hashPaths(root: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const p of paths) {
    const abs = join(root, p);
    out.set(p, existsSync(abs) ? await sha256(readFileSync(abs)) : "<missing>");
  }
  return out;
}

function diffHashes(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [p, h] of before) if (after.get(p) !== h) changed.push(p);
  return changed;
}

// ---------------------------------------------------------------------------
// run identity
// ---------------------------------------------------------------------------

/**
 * Never Math.random. A run id is the join key between this directory's JSONL
 * and the ledger rows the loop writes for the same work, so every character of
 * it has to be explicable after the fact. Explicit --run-id wins and is the
 * only way to get a byte-identical id twice; otherwise it is the UTC start
 * instant (which is what makes it unique, and what the `task_id LIKE 'ev-…'`
 * query in README.md keys off) plus a digest over the ledger the run will be
 * reconciled against and the shape of the run.
 */
async function deriveRunId(explicit: string | undefined, ledgerPath: string, seed: string): Promise<string> {
  if (explicit) return explicit;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const digest = (await sha256(`${ledgerPath}\n${seed}`)).slice(0, 8);
  return `ev-${stamp}-${digest}`;
}

// ---------------------------------------------------------------------------
// trials
// ---------------------------------------------------------------------------

interface TrialRow {
  run_id: string;
  task: string;
  trial: number;
  config: string;
  started_utc: string;
  peak: boolean;
  baseline_exit: number;
  /** The eval's verdict, from its own verify run. This is what scores. */
  passed: boolean;
  verify_exit: number;
  /** The harness's verdict. Recorded for the disagreement counter, never scored. */
  claimed_outcome: string;
  claimed_summary: string;
  cost_usd: number;
  turns: number;
  hit_rate: number;
  verify_rejects: number;
  immutable_violations: string[];
  changed_files: string[];
  agent_wall_ms: number;
  verify_wall_ms: number;
  error: string | null;
  repo: string | null;
}

interface TrialDeps {
  runner: RunTaskInDir;
  config: PxConfig;
  configName: string;
  ledger: Ledger;
  ui: Ui;
  runId: string;
  keep: boolean;
}

async function runTrial(task: TaskSpec, trial: number, baselineExit: number, d: TrialDeps): Promise<TrialRow> {
  const repo = join(tmpdir(), "px-eval", d.runId, `${task.id}-t${trial}`);
  await makeTrialRepo(task, repo);

  const before = await hashPaths(repo, task.immutablePaths);
  const startedUtc = new Date().toISOString();
  const peak = isPeak(new Date());

  let result: RunResult | null = null;
  let error: string | null = null;
  const t0 = Date.now();
  try {
    // inPlace, because the trial directory IS the disposable worktree. Letting
    // the loop cut a second one would put the edits under config.worktreeRoot,
    // where the eval's own verify run — which happens right here, in `repo` —
    // would never see them, and every trial would score as a no-op.
    result = await d.runner(repo, task.prompt, {
      config: d.config,
      ui: d.ui,
      ledger: d.ledger,
      inPlace: true,
      requireVerify: true,
      taskId: `${d.runId}-${task.id}-t${trial}`,
    });
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  const agentWallMs = Date.now() - t0;

  const violations = diffHashes(before, await hashPaths(repo, task.immutablePaths));
  const v = await sh(task.verifyCmd, repo);
  const passed = v.code === 0 && violations.length === 0;

  const kept = d.keep || !passed;
  if (!kept) rmSync(repo, { recursive: true, force: true });

  return {
    run_id: d.runId,
    task: task.id,
    trial,
    config: d.configName,
    started_utc: startedUtc,
    peak,
    baseline_exit: baselineExit,
    passed,
    verify_exit: v.code,
    claimed_outcome: result?.outcome ?? "error",
    claimed_summary: (result?.summary ?? error ?? "").slice(0, 400),
    cost_usd: result?.costUsd ?? 0,
    turns: result?.turns ?? 0,
    hit_rate: result?.hitRate ?? 0,
    verify_rejects: result?.verifyRejects ?? 0,
    immutable_violations: violations,
    changed_files: result?.changedFiles ?? [],
    agent_wall_ms: agentWallMs,
    verify_wall_ms: v.ms,
    error,
    repo: kept ? repo : null,
  };
}

// ---------------------------------------------------------------------------
// aggregation
// ---------------------------------------------------------------------------

interface Agg {
  task: string;
  trials: number;
  passes: number;
  totalCost: number;
  meanCost: number;
  costPerCompleted: number | null;
  medianWallS: number;
  /** Kept so the TOTAL row medians over every trial, not over per-task medians. */
  wallsS: number[];
  meanTurns: number;
  meanHit: number;
  guardTrips: number;
  disagreements: number;
}

function aggregate(task: string, rows: TrialRow[]): Agg {
  const n = rows.length;
  const passes = rows.filter((r) => r.passed).length;
  const totalCost = sum(rows.map((r) => r.cost_usd));
  return {
    task,
    trials: n,
    passes,
    totalCost,
    meanCost: n === 0 ? 0 : totalCost / n,
    // Total spend divided by tasks actually completed. Trials that failed are
    // in the numerator and not the denominator, which is the point: a harness
    // that burns three cheap failures before one success is not cheap.
    costPerCompleted: passes === 0 ? null : totalCost / passes,
    medianWallS: median(rows.map((r) => r.agent_wall_ms)) / 1000,
    wallsS: rows.map((r) => r.agent_wall_ms / 1000),
    meanTurns: n === 0 ? 0 : sum(rows.map((r) => r.turns)) / n,
    meanHit: n === 0 ? 0 : sum(rows.map((r) => r.hit_rate)) / n,
    // Protective interventions: px's verify guard rejecting a claimed-done
    // turn, plus the eval catching an edit to a file the prompt declared
    // off-limits. Both mean the agent tried to finish without finishing.
    guardTrips: sum(rows.map((r) => r.verify_rejects + (r.immutable_violations.length > 0 ? 1 : 0))),
    // The harness said passed; the eval's own verify run disagreed. Any value
    // above zero is a correctness bug in the harness, not a model failure.
    disagreements: rows.filter((r) => r.claimed_outcome === "passed" && !r.passed).length,
  };
}

function renderTable(aggs: Agg[]): string {
  const header = ["task", "n", "pass", "pass%", "mean $", "$/done", "med s", "turns", "hit%", "guard"];
  const body = aggs.map((a) => [
    a.task,
    String(a.trials),
    String(a.passes),
    pct(a.trials === 0 ? 0 : a.passes / a.trials),
    money(a.meanCost),
    a.costPerCompleted === null ? "  —" : money(a.costPerCompleted),
    a.medianWallS.toFixed(1),
    a.meanTurns.toFixed(1),
    pct(a.meanHit),
    String(a.guardTrips),
  ]);

  const trials = sum(aggs.map((a) => a.trials));
  const passes = sum(aggs.map((a) => a.passes));
  const cost = sum(aggs.map((a) => a.totalCost));
  body.push([
    "TOTAL",
    String(trials),
    String(passes),
    pct(trials === 0 ? 0 : passes / trials),
    money(trials === 0 ? 0 : cost / trials),
    passes === 0 ? "  —" : money(cost / passes),
    median(aggs.flatMap((a) => a.wallsS)).toFixed(1),
    aggs.length === 0 ? "0.0" : (sum(aggs.map((a) => a.meanTurns * a.trials)) / Math.max(1, trials)).toFixed(1),
    pct(aggs.length === 0 ? 0 : sum(aggs.map((a) => a.meanHit * a.trials)) / Math.max(1, trials)),
    String(sum(aggs.map((a) => a.guardTrips))),
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("  ");

  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  const out = [line(header), rule];
  for (const r of body.slice(0, -1)) out.push(line(r));
  out.push(rule);
  out.push(line(body[body.length - 1] ?? []));
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// self-test: the eval's own verification, no API key required
// ---------------------------------------------------------------------------

/**
 * A task is only worth scoring if two things are true, and neither is obvious
 * by inspection once a verify_cmd grows past one word:
 *
 *   baseline red    the pristine fixture must FAIL verification, or the task
 *                   measures nothing
 *   solution green  the reference patch in solution/ must PASS it, or the task
 *                   is unwinnable and every dollar spent on it is wasted
 *
 * Both run here, offline, in a few seconds.
 */
async function selfTest(tasks: TaskSpec[]): Promise<number> {
  let bad = 0;
  const scratch = join(tmpdir(), "px-eval", "selftest");

  for (const task of tasks) {
    const problems: string[] = [];

    const baseRepo = join(scratch, `${task.id}-baseline`);
    await makeTrialRepo(task, baseRepo);
    const base = await sh(task.verifyCmd, baseRepo);
    if (base.code === 0) {
      problems.push("baseline verify exits 0: the pristine fixture already passes, so this task discriminates nothing");
    }

    const solDir = join(task.dir, "solution");
    let sol: ShellResult | null = null;
    if (!existsSync(solDir)) {
      problems.push("no solution/ directory: the task has no proof it is winnable");
    } else {
      const solRepo = join(scratch, `${task.id}-solution`);
      await makeTrialRepo(task, solRepo, solDir);
      sol = await sh(task.verifyCmd, solRepo);
      if (sol.code !== 0) {
        problems.push(`reference solution fails verify (exit ${sol.code}):\n${indent(tail(sol.output, 20))}`);
      }
      // The reference patch must not touch anything the prompt froze, or the
      // task is asking the agent to do something it also forbids.
      const violated = diffHashes(
        await hashPaths(baseRepo, task.immutablePaths),
        await hashPaths(solRepo, task.immutablePaths),
      ).filter((p) => task.immutablePaths.includes(p));
      if (violated.length > 0) {
        problems.push(`solution/ modifies immutable path(s): ${violated.join(", ")}`);
      }
    }

    const ok = problems.length === 0;
    if (!ok) bad++;
    console.log(
      `${ok ? "ok  " : "FAIL"}  ${task.id.padEnd(20)} baseline exit ${base.code}` +
        (sol ? `, solution exit ${sol.code}` : "") +
        `  (${((base.ms + (sol?.ms ?? 0)) / 1000).toFixed(1)}s)`,
    );
    for (const p of problems) console.log(indent(p, "        "));
  }

  rmSync(scratch, { recursive: true, force: true });
  console.log(bad === 0 ? `\n${tasks.length} task(s) sound.` : `\n${bad} task(s) unsound.`);
  return bad === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

interface Args {
  tasks: string[];
  trials: number;
  config: string;
  runId?: string;
  budget?: number;
  keep: boolean;
  selfTest: boolean;
  verbose: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    tasks: [],
    trials: 3,
    config: "lane-e",
    keep: false,
    selfTest: false,
    verbose: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    switch (k) {
      case "--tasks": a.tasks = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--trials": a.trials = Number(next()); break;
      case "--config": a.config = next(); break;
      case "--run-id": a.runId = next(); break;
      case "--budget": a.budget = Number(next()); break;
      case "--keep": a.keep = true; break;
      case "--self-test": a.selfTest = true; break;
      case "--verbose": a.verbose = true; break;
      case "-h": case "--help": a.help = true; break;
      default: throw new Error(`unknown flag ${k} (try --help)`);
    }
  }
  if (!Number.isInteger(a.trials) || a.trials < 1) throw new Error("--trials must be a positive integer");
  // Unchecked, `--budget nonsense` becomes a NaN budgetUsd that every
  // comparison against it reads as false, so the ceiling never fires and the
  // run reports "budget $NaN" while spending without a limit.
  if (a.budget !== undefined && (!Number.isFinite(a.budget) || a.budget <= 0)) {
    throw new Error("--budget must be a positive number of dollars");
  }
  if (!(a.config in CONFIGS)) {
    throw new Error(`unknown --config ${a.config}. Known: ${Object.keys(CONFIGS).join(", ")}`);
  }
  return a;
}

const USAGE = `px eval — dollars per completed task

  bun run eval/run.ts [--tasks t01,t02] [--trials 3] [--config lane-e]

  --tasks    comma-separated task ids or prefixes (default: all)
  --trials   repetitions per task (default: 3)
  --config   ${Object.keys(CONFIGS).join(" | ")}
  --run-id   explicit run id; otherwise derived from the ledger path and the
             run's shape. Never random — it is the join key into the ledger.
  --budget   per-trial budget in USD, overriding PX_BUDGET_USD
  --keep     keep every trial repo, not just the failures
  --self-test  check that each task's baseline is red and its solution green,
               offline, without an API key. Run this after editing a fixture.
`;

/**
 * Exit 2 for a broken harness, 1 for a run where some task failed, 0 for a
 * clean sweep. A caller scripting an A/B has to be able to tell "the eval is
 * wrong" from "the harness is worse", so a bad flag and a losing harness must
 * not share a code.
 */
export async function main(argv: string[] = Bun.argv.slice(2)): Promise<number> {
  try {
    return await run(argv);
  } catch (e) {
    console.error(`\npx eval: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const tasks = discoverTasks(args.tasks);
  if (tasks.length === 0) throw new Error("no tasks selected");
  if (args.selfTest) return selfTest(tasks);

  const baseConfig = loadConfig();
  const patched = CONFIGS[args.config]!(baseConfig);
  const config: PxConfig = args.budget === undefined ? patched : { ...patched, budgetUsd: args.budget };

  const runId = await deriveRunId(
    args.runId,
    config.ledgerPath,
    `${args.config}|${args.trials}|${tasks.map((t) => t.id).join(",")}`,
  );

  const runner = await loadRunner();
  const ledger = new Ledger(config.ledgerPath);
  const ui = new Ui({ quiet: !args.verbose, verbose: args.verbose, color: false });

  mkdirSync(RESULTS_DIR, { recursive: true });
  const jsonl = join(RESULTS_DIR, `${runId}.jsonl`);

  console.log(`run ${runId}  config ${args.config}  trials ${args.trials}  budget $${config.budgetUsd.toFixed(2)}`);
  console.log(`results ${jsonl}\n`);

  const deps: TrialDeps = { runner, config, configName: args.config, ledger, ui, runId, keep: args.keep };
  const aggs: Agg[] = [];
  const skipped: string[] = [];
  const kept: string[] = [];

  try {
    for (const task of tasks) {
      // Rule 2: baseline once per task per run, before spending anything.
      const baseRepo = join(tmpdir(), "px-eval", runId, `${task.id}-baseline`);
      await makeTrialRepo(task, baseRepo);
      const baseline = await sh(task.verifyCmd, baseRepo);
      rmSync(baseRepo, { recursive: true, force: true });

      if (baseline.code === 0) {
        skipped.push(`${task.id}: baseline verify exits 0, so a pass proves nothing. Fix the fixture.`);
        continue;
      }

      const rows: TrialRow[] = [];
      for (let trial = 1; trial <= args.trials; trial++) {
        process.stdout.write(`${task.id} trial ${trial}/${args.trials} ... `);
        const row = await runTrial(task, trial, baseline.code, deps);
        // Appended as each trial lands, so a crash or a Ctrl-C halfway through
        // still leaves every completed trial on disk.
        appendFileSync(jsonl, JSON.stringify(row) + "\n");
        rows.push(row);
        if (row.repo) kept.push(row.repo);
        console.log(
          `${row.passed ? "pass" : "fail"}  $${row.cost_usd.toFixed(4)}  ` +
            `${row.turns} turns  ${(row.agent_wall_ms / 1000).toFixed(1)}s` +
            (row.immutable_violations.length > 0 ? `  [touched ${row.immutable_violations.join(", ")}]` : "") +
            (row.error ? `  [${row.error.slice(0, 80)}]` : ""),
        );
      }
      aggs.push(aggregate(task.id, rows));
    }
  } finally {
    ledger.close();
  }

  console.log(`\n${renderTable(aggs)}`);

  const disagreements = sum(aggs.map((a) => a.disagreements));
  if (disagreements > 0) {
    console.log(
      `\n!! ${disagreements} trial(s) the harness reported as passed but the eval's own verify run failed.\n` +
        `   That is a harness correctness bug, not a model failure. Start there.`,
    );
  }
  for (const s of skipped) console.log(`\n!! skipped ${s}`);
  if (kept.length > 0) console.log(`\nkept ${kept.length} trial repo(s):\n  ${kept.join("\n  ")}`);

  return aggs.every((a) => a.passes === a.trials) && skipped.length === 0 && disagreements === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, path: string, field: string): string {
  if (typeof v !== "string" || v === "") throw new Error(`${path}: ${field} must be a non-empty string`);
  return v;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function money(x: number): string {
  return `$${x.toFixed(4)}`;
}

function tail(text: string, lines: number): string {
  return text.split("\n").slice(-lines).join("\n");
}

function indent(text: string, prefix = "        "): string {
  return text.split("\n").map((l) => prefix + l).join("\n");
}

// `px eval` imports main() and owns its own exit; only the direct
// `bun run eval/run.ts` entry point ends the process here.
if (import.meta.main) process.exit(await main());
