/**
 * Doctor tests.
 *
 * These never touch the network, on purpose: a unit test that fails when the
 * vendor is down teaches nothing, and doctor's whole job is to be the thing
 * that fails when the vendor changes. What is tested here is the scaffolding —
 * that the check list is complete, that the formatter renders both outcomes,
 * and that nothing on the output path can carry the API key.
 */

import { describe, expect, test } from "bun:test";
import { formatChecks, runDoctor, type DoctorCheck } from "../scripts/doctor.ts";

/** The ten contract assumptions px is built on, in probe order. */
const EXPECTED_CHECKS = [
  "model-inventory",
  "max-tokens-ceiling",
  "cache-quantum",
  "cache-namespace",
  "thinking-default",
  "forced-tool-choice",
  "model-echo-alias",
  "count-tokens-exact",
  "pro-image-drop",
  "truncation-determinism",
];

describe("runDoctor(skipLive)", () => {
  test("builds the complete check list with no live call", async () => {
    const report = await runDoctor("", { skipLive: true });
    expect(report.checks.map((c) => c.name)).toEqual(EXPECTED_CHECKS);
    expect(report.ok).toBe(true);
    expect(report.spentUsd).toBe(0);
  });

  test("every check states an expectation and admits it measured nothing", async () => {
    const { checks } = await runDoctor("", { skipLive: true });
    for (const c of checks) {
      expect(c.expected.length).toBeGreaterThan(0);
      expect(c.actual).toContain("skipped");
      expect(c.note).toBeTruthy();
    }
  });

  test("streams each check to onCheck exactly once", async () => {
    const seen: string[] = [];
    const { checks } = await runDoctor("", { skipLive: true, onCheck: (c) => seen.push(c.name) });
    expect(seen).toEqual(checks.map((c) => c.name));
  });

  test("refuses to run live without a key, before any request", async () => {
    // No fetch can happen: the guard precedes client construction.
    await expect(runDoctor("")).rejects.toThrow(/needs an API key/);
  });

  test("nothing on the output path echoes the key", async () => {
    const sentinel = "sk-doctor-must-never-print-this";
    const { checks } = await runDoctor(sentinel, { skipLive: true });
    expect(formatChecks(checks)).not.toContain(sentinel);
  });
});

describe("formatChecks", () => {
  const sample: DoctorCheck[] = [
    { name: "cache-quantum", expected: "hit % 128 == 0", actual: "hit=768", ok: true },
    { name: "pro-image-drop", expected: "pt unchanged", actual: "pt 11 -> 190", ok: false, note: "pro now bills images" },
  ];

  test("renders one labelled line per check, plus notes", () => {
    const out = formatChecks(sample);
    expect(out).toContain("PASS  cache-quantum");
    expect(out).toContain("FAIL  pro-image-drop");
    expect(out).toContain("expect hit % 128 == 0");
    expect(out).toContain("actual pt 11 -> 190");
    expect(out).toContain("note   pro now bills images");
    // A passing check has no note line to render.
    expect(out.split("\n").filter((l) => l.includes("note   ")).length).toBe(1);
  });

  test("aligns names into one column", () => {
    const out = formatChecks(sample).split("\n");
    const cols = out.filter((l) => l.includes("expect ")).map((l) => l.indexOf("expect "));
    expect(new Set(cols).size).toBe(1);
  });

  test("renders the real skipLive list end to end", async () => {
    const { checks } = await runDoctor("", { skipLive: true });
    const out = formatChecks(checks);
    for (const name of EXPECTED_CHECKS) expect(out).toContain(name);
    expect(out.split("\n").filter((l) => l.startsWith("PASS ")).length).toBe(EXPECTED_CHECKS.length);
  });

  test("keeps one line per field when a note carries a raw error body", () => {
    const noisy: DoctorCheck[] = [
      { name: "max-tokens-ceiling", expected: "400", actual: "threw", ok: false, note: '400: {\n  "error": {\n    "message": "out of range"\n  }\n}' },
    ];
    const out = formatChecks(noisy);
    expect(out.split("\n").length).toBe(3);
    expect(out).toContain('note   400: { "error": { "message": "out of range" } }');
  });

  test("scrubs a credential the API echoed back into an error body", () => {
    // Verbatim shape of a real DeepSeek 401 body.
    const leaky: DoctorCheck[] = [
      {
        name: "model-echo-alias",
        expected: "flash spelling",
        actual: "threw",
        ok: false,
        note: 'BAD_REQUEST: 401: {"message":"Authentication Fails, Your api key: sk-9f3a2b1c4d5e is invalid"}',
      },
    ];
    const out = formatChecks(leaky);
    expect(out).not.toContain("sk-9f3a2b1c4d5e");
    expect(out).toContain("Authentication Fails");
  });

  test("survives an empty list", () => {
    expect(formatChecks([])).toBe("");
  });

  test("caps a pathological field instead of emitting one enormous line", () => {
    // The check that forgets to bound its capture will be the one reporting an
    // unfamiliar vendor response, which is exactly when the table must stay read.
    const huge: DoctorCheck[] = [
      { name: "model-inventory", expected: "e", actual: "a", ok: false, note: "x".repeat(5000) },
    ];
    const lines = formatChecks(huge).split("\n");
    expect(lines.length).toBe(3);
    expect(lines[2]!.length).toBeLessThan(600);
    expect(lines[2]).toContain("+4600 chars");
  });
});

describe("the standalone entry point", () => {
  const script = new URL("../scripts/doctor.ts", import.meta.url).pathname;

  test("--offline reports that it measured nothing, never a passing score", async () => {
    const proc = Bun.spawn(["bun", "run", script, "--offline"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;

    expect(code).toBe(0);
    // A score here would read as a verified contract; it verified nothing.
    expect(out).not.toMatch(/\d+\/\d+ passed/);
    expect(out).toContain("0 measured");
    expect(out).toContain("model-inventory");
  }, 30_000);
});
