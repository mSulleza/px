# eval

Makes "is this change actually better" answerable. One number decides anything:

**dollars per completed task.**

Pass rate alone is a vanity metric — a harness with no step limit passes
eventually. Mean cost alone is a vanity metric pointing the other way — a
harness that quits on turn two is very cheap. Only the ratio moves when the
harness genuinely improves, so every other column in the table exists to
explain a change in that one.

```
bun run eval/run.ts --self-test                      # offline, no API key
bun run eval/run.ts --tasks t01,t02 --trials 5 --config lane-e
bun run eval/run.ts --config short-leash --trials 5  # the other arm of an A/B
```

## The three rules

**The eval runs verification itself.** After the agent stops, the eval re-runs
the task's `verify_cmd` in the trial repo and scores that exit code.
`RunResult.outcome` is recorded in the JSONL as `claimed_outcome` and is never
scored. When the two disagree the run prints a loud footer, because a harness
reporting success on a repo that does not pass is a correctness bug in px, not
a model failure. t05 exists to produce exactly that disagreement in a harness
that skips its own baseline.

**Every task's baseline is measured before any money is spent.** A `verify_cmd`
that already exits 0 on the pristine fixture cannot discriminate between
anything. Such a task is skipped with a warning rather than quietly contributing
a 100% pass rate. This runs once per task per run, and its exit code lands in
every trial row.

**Every trial gets its own repo.** `fixture/` is copied to a fresh temp
directory, `.px/verify.toml` is written with the task's command, then `git init`
and a commit — so the agent starts on a clean tree it is allowed to dirty, and a
trial that wrecks the worktree cannot contaminate the next one. Failed trials'
repos are left on disk and printed; passing ones are removed unless `--keep`.

The loop is run with `inPlace: true`. The trial directory *is* the disposable
worktree; letting the loop cut a second one would put the edits under
`config.worktreeRoot`, where the eval's own verify run would never see them and
every trial would score as a no-op.

## Task anatomy

```
tasks/<id>/
  task.json     id, prompt, verify_cmd, immutable_paths, ground_truth
  fixture/      a tiny self-contained repo, copied fresh per trial
  solution/     the reference patch, overlaid onto fixture/ by --self-test
```

`immutable_paths` are files the prompt tells the agent not to touch. The eval
hashes them before and after and fails the trial if any changed. Without this,
t01 is solvable by editing the expected value in the test — the most common way
a cheap model "passes" a fix task, and precisely the behaviour worth pricing.
`.px/verify.toml` is added to the list automatically.

`ground_truth` is `{kind, detail}`. It is documentation for whoever audits a
trial that passed for a suspicious reason; nothing executes it. Each one names
the plausible wrong answer the task is built to reject.

`--self-test` is the eval's own verification and needs no API key: for each task
it asserts the baseline is **red** (or the task measures nothing) and the
reference solution is **green** (or the task is unwinnable and every dollar
spent on it is wasted), and that `solution/` does not itself touch an immutable
path. Run it after editing any fixture.

## The tasks

| id | discriminates | the wrong answer it rejects |
|----|---------------|-----------------------------|
| `t01-single-fail` | baseline sanity: locate one wrong operator | editing `tests/` to match the buggy output; flipping `over_budget`'s correct `>` to `>=` while pattern-matching for operators |
| `t02-multi-rename` | grep/read batching and edit-anchor reliability | a `*.py`-only grep that misses the symbol inside `pipeline.json` and leaves a config pointing at a dead attribute; a substring replace of `surcharge` that also renames `surcharge_rate` and `surcharge_table` |
| `t05-vacuous-assert` | a harness that trusts the model instead of running verification | stopping because `pytest -q` is already green; fixing the code but leaving `assert ... or True` intact; "fixing" the assertion to match the buggy output |

t05's `guard.py` runs in two phases, both required, because the two halves of
that defect fail independently. The **spec** phase calls `split_cents` directly
and checks the invariants its docstring promises — that catches a fix that never
happened. The **mutation** phase copies the repo, wraps `split_cents` with a
mutant that shorts the first share by one cent, and re-runs the repo's *own*
suite against it; the suite must go red. A vacuous assertion survives the mutant
untouched, so that phase is the only thing that forces the test to be tightened
rather than merely left green. A control run of the unmutated suite happens in
the same copy first, so a collection error cannot masquerade as a test that
caught the mutant.

## Reading the table

```
task                n  pass  pass%   mean $  $/done  med s  turns  hit%  guard
```

- **$/done** — total spend across all trials divided by the number that
  *completed*. Failed trials are in the numerator and not the denominator, which
  is the point: a harness that burns three cheap failures before one success is
  not cheap. `—` means nothing completed, and the total spend bought nothing.
- **hit%** — mean prefix-cache hit rate. A drop here is the visible signature of
  a ZONE A break; it moves `mean $` without touching pass rate.
- **guard** — protective interventions: px's verify guard rejecting a
  claimed-done turn, plus the eval catching an edit to a file the prompt froze.
  Both mean the agent tried to finish without finishing. Rising guard trips with
  a flat pass rate means the guards are carrying the harness.

## Results

One JSON row per trial, appended to `results/<run-id>.jsonl` as each trial
lands, so a crash or a Ctrl-C halfway through still leaves every completed trial
on disk. `results/` is scratch output, not source.

The run id is passed with `--run-id` or derived from the ledger path and the
shape of the run — never from `Math.random`, because it is the join key back
into the ledger. Each trial runs with `taskId = <run-id>-<task>-t<n>`, so the
call-level cost of any trial is recoverable independently of this directory:

```sql
SELECT task_id, SUM(cost_usd), SUM(hit_tok), SUM(miss_tok)
FROM calls WHERE task_id LIKE 'ev-20260911T%' GROUP BY task_id;
```

## Caveats that invalidate a comparison

**Peak pricing is exactly 2x**, Mon–Fri 01:00–04:00 and 06:00–10:00 UTC. A run
that straddled a boundary is not comparable to one that did not. Every trial row
records `peak` as measured at its start; check it before believing a cost delta.

**Three trials is a smoke test, not a measurement.** Tool-argument whitespace
drifts in ~80% of calls and edit anchors do not always land in the same place
twice. Use `--trials 5` or more before calling a `$/done` difference real.

**`--config` patches `PxConfig`, not the lane.** The loop pins Lane E for the
life of a session on purpose: reasoning effort is a cache namespace, not a
quality dial (`src/lanes/policy.ts`), so an A/B that switched lanes would be
comparing two prefix caches rather than two harnesses. Available: `lane-e`
(the shipped default), `tight-budget`, `short-leash`, `no-compact`.

**Exit codes.** 0 every trial passed, 1 something failed or was skipped, 2 the
eval itself is broken. A caller scripting an A/B needs to tell "the eval is
wrong" from "the harness is worse".
