/**
 * The ladder is the part of px most likely to corrupt a file while reporting
 * success, so every rung, and every refusal, is pinned here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { editLadderStats, editTool } from "../src/tools/edit.ts";
import type { ToolContext } from "../src/types.ts";

let root: string;

function ctx(): ToolContext {
  return { root, budgetUsd: 1, spentUsd: () => 0, consult: async () => "", log: () => {} };
}

function put(name: string, body: string): string {
  const p = join(root, name);
  writeFileSync(p, body);
  return p;
}

function read(name: string): string {
  return readFileSync(join(root, name), "utf8");
}

interface Edit {
  old: string;
  new: string;
  count?: number;
}

function run(path: string, edits: Edit[]) {
  return editTool.run({ path, edits }, ctx());
}

beforeEach(() => {
  root = mkdtempSync("/private/tmp/px-edit-");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ladder rung 1 — exact", () => {
  test("replaces an exact substring and counts the rung", async () => {
    put("a.ts", "const a = 1;\nconst b = 2;\n");
    const before = editLadderStats().exact;

    const out = await run("a.ts", [{ old: "const b = 2;", new: "const b = 3;" }]);

    expect(out.isError).toBeFalsy();
    expect(read("a.ts")).toBe("const a = 1;\nconst b = 3;\n");
    expect(out.changedPaths).toEqual(["a.ts"]);
    expect(editLadderStats().exact).toBe(before + 1);
  });
});

describe("ladder rung 2 — trailing whitespace", () => {
  test("matches through trailing whitespace and absorbs it into the replaced span", async () => {
    // Trailing spaces on both lines: rung 1 cannot match, and the spaces after
    // the final anchor line must not survive the replacement.
    put("a.ts", "a();  \nb();  \nc();\n");
    const before = editLadderStats().trailing;

    const out = await run("a.ts", [{ old: "a();\nb();", new: "z();" }]);

    expect(out.isError).toBeFalsy();
    expect(read("a.ts")).toBe("z();\nc();\n");
    expect(editLadderStats().trailing).toBe(before + 1);
  });
});

describe("ladder rung 3 — leading indent", () => {
  test("matches a dedented block and re-indents the replacement to the file's column", async () => {
    put("a.ts", "function f() {\n    if (x) {\n        go();\n    }\n}\n");
    const before = editLadderStats().indent;

    const out = await run("a.ts", [{ old: "if (x) {\n    go();\n}", new: "if (x) {\n    go2();\n}" }]);

    expect(out.isError).toBeFalsy();
    expect(read("a.ts")).toBe("function f() {\n    if (x) {\n        go2();\n    }\n}\n");
    expect(editLadderStats().indent).toBe(before + 1);
  });
});

describe("duplicate anchors", () => {
  test("refuses when the anchor matches more times than count says, and writes nothing", async () => {
    const body = "x = 1;\ny = 0;\nx = 1;\n";
    put("a.ts", body);

    const out = await run("a.ts", [{ old: "x = 1;", new: "x = 2;" }]);

    expect(out.isError).toBe(true);
    expect(out.content).toContain("matched 2 times");
    expect(out.content).toContain("count=1");
    expect(out.content).toContain("lines 1, 3");
    expect(out.content).toContain("count=2");
    expect(read("a.ts")).toBe(body);
  });

  test("a count refusal is charged to failed, not to the rung that found the spans", async () => {
    // The ledger records `failed` as edit_retries. A count refusal costs the
    // model the same re-read a miss does, and charging it to `exact` would both
    // hide the retry and overstate how often rung 1 actually applies.
    put("a.ts", "q();\nq();\n");
    const before = editLadderStats();

    const out = await run("a.ts", [{ old: "q();", new: "r();" }]);

    expect(out.isError).toBe(true);
    const after = editLadderStats();
    expect(after.exact).toBe(before.exact);
    expect(after.failed).toBe(before.failed + 1);
  });

  test("an explicit count makes the multi-edit legal", async () => {
    put("a.ts", "x = 1;\ny = 0;\nx = 1;\n");

    const out = await run("a.ts", [{ old: "x = 1;", new: "x = 2;", count: 2 }]);

    expect(out.isError).toBeFalsy();
    expect(read("a.ts")).toBe("x = 2;\ny = 0;\nx = 2;\n");
  });

  test("refuses when fewer occurrences exist than count claims", async () => {
    const body = "x = 1;\n";
    put("a.ts", body);

    const out = await run("a.ts", [{ old: "x = 1;", new: "x = 2;", count: 3 }]);

    expect(out.isError).toBe(true);
    expect(out.content).toContain("matched 1 time");
    expect(read("a.ts")).toBe(body);
  });
});

describe("atomicity", () => {
  test("one bad anchor in a batch of three applies none of them", async () => {
    const body = "one();\ntwo();\nthree();\n";
    put("a.ts", body);

    const out = await run("a.ts", [
      { old: "one();", new: "1();" },
      { old: "MISSING();", new: "nope();" },
      { old: "three();", new: "3();" },
    ]);

    expect(out.isError).toBe(true);
    expect(read("a.ts")).toBe(body);
    expect(out.content).toContain("no edits applied to a.ts");
    expect(out.content).toContain("1 of 3 anchors failed");
    expect(out.content).toContain("edits[1]:");
    expect(out.changedPaths).toBeUndefined();
  });

  test("every failure in the batch is reported, not just the first", async () => {
    put("a.ts", "one();\ntwo();\n");

    const out = await run("a.ts", [
      { old: "GONE_A();", new: "a();" },
      { old: "GONE_B();", new: "b();" },
    ]);

    expect(out.content).toContain("edits[0]:");
    expect(out.content).toContain("edits[1]:");
    expect(out.content).toContain("2 of 2 anchors failed");
  });
});

describe("structured not-found error", () => {
  test("names the file, the nearest candidate lines, and the exact next call", async () => {
    const lines: string[] = [];
    for (let n = 1; n <= 60; n++) lines.push(`// filler ${n}`);
    lines[19] = "const alpha = compute(1);";
    lines[20] = "const beta = compute(2);";
    lines[21] = "const gamma = compute(3);";
    put("src.ts", lines.join("\n") + "\n");
    const before = editLadderStats().failed;

    const out = await run("src.ts", [
      { old: "const alpha = compute(9);\nconst beta = compute(9);\nconst gamma = compute(9);", new: "// gone\n" },
    ]);

    expect(out.isError).toBe(true);
    expect(out.content).toStartWith("ERROR: anchor not found in src.ts.");
    expect(out.content).toContain("Nearest candidates at lines 20-22");
    expect(out.content).toContain('Call read(paths=["src.ts"], ranges=[[14,28]]) then retry edit.');
    expect(editLadderStats().failed).toBe(before + 1);
  });

  test("says so plainly when nothing in the file resembles the anchor", async () => {
    put("a.ts", "alpha\nbeta\ngamma\n");

    const out = await run("a.ts", [{ old: "zzzzzzzzzz", new: "x" }]);

    expect(out.isError).toBe(true);
    expect(out.content).toContain("nothing there resembles it");
    expect(out.content).toContain('Call read(paths=["a.ts"])');
  });
});

describe("guards", () => {
  test("refuses a path outside the worktree", async () => {
    const out = await run("../escape.ts", [{ old: "a", new: "b" }]);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("outside the worktree");
  });

  test("points at write when the file does not exist", async () => {
    const out = await run("nope.ts", [{ old: "a", new: "b" }]);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Use write to create it");
  });

  test("the ladder stops at the first rung that hits", async () => {
    // The exact text is present, so rung 1 wins even though rung 3 would also
    // match after dedenting. First hit wins, always.
    put("a.ts", "    go();\n");
    const before = editLadderStats();

    await run("a.ts", [{ old: "go();", new: "stop();" }]);

    const after = editLadderStats();
    expect(after.exact).toBe(before.exact + 1);
    expect(after.indent).toBe(before.indent);
  });

  test("total accounts for every resolved anchor", () => {
    const s = editLadderStats();
    expect(s.total).toBe(s.exact + s.trailing + s.indent + s.failed);
  });
});
