# px on DeepSeek Harness

px is a standalone harness: its own loop, its own guards, its own verification.
DeepSeek Harness (dsh) is a Cordis composition where everything is a plugin and
the machine publishes named extension points. This directory is px moving onto
that machine, one guarantee at a time.

The strategy is deliberately not "port the loop". px's loop is replaceable; its
*guarantees* are not. Each one moves across on its own, as a plugin mounted on
the dsh extension point that already has the right shape — no adapter layer, no
shim, no px runtime running underneath. When the last guarantee has moved, the
px loop has nothing left to do.

## Step 1 — [`px-verify`](./px-verify)

The verification gate. **The machine owns the verdict, not the model.**

When the harness decides a turn is over, `px-verify` runs the repository's own
test command in the session workspace. Fail and the turn does not close: the
model is steered back with the failing output, the exit code, and the names of
the tests that went red. It carries px's real discipline across, not a
reimplementation of it:

- resolution is explicit-over-inferred (`.px/verify.toml` wins; an unguessable
  repo gets no gate rather than a guessed one);
- the verdict is a **set difference against a baseline**, not an exit code, so a
  change that fixes the target test and breaks two others is rejected;
- a hang, a user Stop, or a sandbox denial is `inconclusive` — never reported to
  the model as "your tests fail";
- and the forced-continuation loop is **capped in the first version**, because
  the upstream Stop-hook seam carries an explicit TODO saying hooks must
  self-limit, and an uncapped steer loop against a permanently red suite spends
  real money for as long as you let it.

One extension point: `agent/turn-stopping`. One supporting listener on
`agent/session-start` for the baseline. No adapter.

Read [`px-verify/README.md`](./px-verify/README.md) for the decision table, the
cap's keying, what the baseline does and does not prove, and the mount recipe.

## Mounted, and proven

`px-verify` is mounted in the live web profile
(`~/dsh/profiles/web/px-verify/`, one `insert` row in that profile's
`cordis.patch.yml`) and has been driven through a real session. The decisive
lines, verbatim:

```
[WARN] px-verify …: bun test exit 1 — 0 regression(s), 1 still failing, evidence pre-existing; steering back, 1 continuation(s) left
[WARN] px-verify …: bun test exit 1 — 0 regression(s), 1 still failing, evidence pre-existing; steering back, 0 continuation(s) left
[WARN] px-verify …: 2/2 forced continuations spent and still red — yielding so a human sees the failure
```

Reproduce with `bash dsh/proof/run.sh` (three model calls). Restart any dsh
already running before you expect the gate: `~/dsh/start.sh <repo>`.

## Two supporting pieces

- [`px-log-stderr`](./px-log-stderr) — dsh ships **no console log exporter at
  all**; the only built-in one appends to a 1000-message in-memory ring buffer,
  so every log line in the harness is invisible from a terminal. This is a
  zero-import overlay plugin that prints them to stderr for one run:
  `~/dsh/start.sh ~/repo --patch ~/personal/px/dsh/px-log-stderr/patch.yml`.
  Useful for any dsh plugin, not just this one.
- [`proof/run.sh`](./proof/run.sh) — builds the fixture repo, composes the
  overlay, and drives one headless session end to end.

## What has not moved yet

- **Loop guards** (`px/src/agent/guards.ts`) — the turn-signature hash, the
  no-progress / oscillation detector, the step and spend ceilings. `px-verify`
  has its own narrow continuation cap because it needed one immediately; the
  general guards are a separate plugin and a separate decision about which dsh
  seam owns them.
- **Consultation / escalation** — px's `note` → `force_consult` → `block` ladder.
- **ZONE C context assembly** — dsh has its own context seam
  (`agent/pre-step`) and a different assembly model; this is a redesign, not a
  port.

## Layout

```
dsh/
  README.md            this file
  px-verify/           step 1: the verification gate
    package.json       peerDependencies only — never `dependencies`
    src/index.ts       the plugin
    README.md          seam, guarantees, cap, config, mounting, proof, limits
  px-log-stderr/       a log sink, because dsh has none
    index.js           zero imports on purpose: see its header
    patch.yml          the --patch overlay that mounts it
  proof/run.sh         the end-to-end reproduction
```

Nothing here modifies px itself. `px-verify` is a standalone plugin that happens
to be maintained beside the source it was ported from, so the two can be fixed
together when they share a bug — and they do share at least one; the
`px-verify` README names it.
