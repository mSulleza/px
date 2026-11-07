-- px cost ledger.
--
-- The DDL lives in its own file so that a schema change is a reviewable diff
-- rather than a string literal buried in a method. ledger.ts reads it at open
-- and applies it whole; every statement is IF NOT EXISTS, so applying it to an
-- existing database is a no-op and there is no migration machinery to get wrong.
--
-- Append-only by construction. Nothing in this schema is ever UPDATEd except a
-- run row, which is written once at start and once at finish under the same id.

CREATE TABLE IF NOT EXISTS calls (
  id                INTEGER PRIMARY KEY,
  ts_utc            TEXT    NOT NULL,
  session_id        TEXT    NOT NULL,
  task_id           TEXT    NOT NULL,
  lane              TEXT    NOT NULL,
  model_requested   TEXT    NOT NULL,
  -- Stored separately from model_requested because the API aliases SKUs and a
  -- silent downgrade to a cheaper model is indistinguishable from success
  -- unless both halves are on the record. See provider/models.ts.
  model_echoed      TEXT    NOT NULL,
  hit_tok           INTEGER NOT NULL,
  miss_tok          INTEGER NOT NULL,
  out_tok           INTEGER NOT NULL,
  reasoning_tok     INTEGER NOT NULL,
  -- What miss_tok should have been given the previous turn's prompt size and
  -- the measured 128-token quantum. Computed by the ledger, not the caller:
  -- it is the only column here that is a prediction rather than a measurement,
  -- and the gap between it and miss_tok is the cache-break signal.
  expected_miss_tok INTEGER NOT NULL,
  peak              INTEGER NOT NULL,
  cost_usd          REAL    NOT NULL,
  -- ZONE A hash at the time of the call, so a break can be attributed.
  prefix_sha        TEXT    NOT NULL,
  finish_reason     TEXT    NOT NULL,
  error_class       TEXT,
  ttfb_ms           INTEGER NOT NULL,
  wall_ms           INTEGER NOT NULL,
  n_tool_calls      INTEGER NOT NULL
);

-- (session_id, lane, id) is the prefix lineage: recordCall walks back along it
-- to find the turn this one inherited its cached prefix from. Lane is part of
-- the key because the KV cache is not shared across SKUs or effort settings.
CREATE INDEX IF NOT EXISTS idx_calls_lineage ON calls (session_id, lane, id);
CREATE INDEX IF NOT EXISTS idx_calls_ts      ON calls (ts_utc);
CREATE INDEX IF NOT EXISTS idx_calls_task    ON calls (task_id);

-- A detected ZONE A/B/C byte drift. Distinct from an anomaly in calls: this is
-- a hash comparison px made itself, that one is inferred from billing.
CREATE TABLE IF NOT EXISTS cache_breaks (
  id           INTEGER PRIMARY KEY,
  ts_utc       TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  zone         TEXT NOT NULL,
  expected_sha TEXT NOT NULL,
  actual_sha   TEXT NOT NULL,
  detail       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cache_breaks_session ON cache_breaks (session_id);

-- A guardrail that fired: path confinement, command denylist, budget ceiling,
-- tool-result invariant, lane drift. Counting these is how "the harness stopped
-- it" stops being an anecdote.
CREATE TABLE IF NOT EXISTS guard_trips (
  id         INTEGER PRIMARY KEY,
  ts_utc     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  guard      TEXT NOT NULL,
  detail     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_guard_trips_session ON guard_trips (session_id);
CREATE INDEX IF NOT EXISTS idx_guard_trips_guard   ON guard_trips (guard);

-- One row per evaluated task attempt. baseline_exit and final_exit are the
-- machine's verdict; outcome is px's. They are stored side by side so a claim
-- of "passed" can be checked against the exit code that was supposed to prove it.
CREATE TABLE IF NOT EXISTS runs (
  run_id         TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  config         TEXT NOT NULL,
  ts_utc         TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  baseline_exit  INTEGER,
  final_exit     INTEGER,
  failing_delta  TEXT NOT NULL,
  turns          INTEGER NOT NULL,
  verify_rejects INTEGER NOT NULL,
  consults       INTEGER NOT NULL,
  edit_retries   INTEGER NOT NULL,
  total_cost_usd REAL    NOT NULL,
  wall_s         REAL    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_task ON runs (task_id, ts_utc);
