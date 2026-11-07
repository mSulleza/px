/**
 * The other seven tools. The cases here are the ones whose regressions are
 * silent: a line-number prefix that drifts by one breaks every edit anchor the
 * model builds from it, and a bash tool that reports a failing exit as a tool
 * error turns a fixable test failure into a retry loop.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { bashTool } from "../src/tools/bash.ts";
import { finishTool } from "../src/tools/finish.ts";
import { grepTool, toPosixEre } from "../src/tools/grep.ts";
import { lsTool } from "../src/tools/ls.ts";
import { readTool } from "../src/tools/read.ts";
import { buildRegistry } from "../src/tools/registry.ts";
import { getTodos, todoTool } from "../src/tools/todo.ts";
import { writeTool } from "../src/tools/write.ts";
import { canonTools } from "../src/wire/canon.ts";
import type { ToolContext } from "../src/types.ts";

let root: string;

function ctx(): ToolContext {
  return { root, budgetUsd: 1, spentUsd: () => 0, consult: async () => "", log: () => {} };
}

function put(name: string, body: string): void {
  const p = join(root, name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

beforeEach(() => {
  root = mkdtempSync("/private/tmp/px-tools-");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("registry", () => {
  test("is the same eight tools every call, in canonically stable bytes", () => {
    const a = buildRegistry();
    const b = buildRegistry();
    expect(a.map((t) => t.name).sort()).toEqual(["bash", "edit", "finish", "grep", "ls", "read", "todo", "write"]);
    // Byte stability is the whole contract: this string sits inside the frozen prefix.
    expect(canonTools(a)).toBe(canonTools(b));
    expect(canonTools(a)).toBe(canonTools([...b].reverse()));
  });

  test("buildRegistry takes no arguments", () => {
    expect(buildRegistry.length).toBe(0);
  });
});

describe("read", () => {
  beforeEach(() => {
    put("f.ts", "alpha\nbeta\ngamma\ndelta\nepsilon\n");
  });

  test("numbers every line and reports the file total", async () => {
    const out = await readTool.run({ paths: ["f.ts"] }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("==> f.ts [lines 1-5 of 5] <==");
    expect(out.content).toContain("1|alpha");
    expect(out.content).toContain("5|epsilon");
  });

  test("ranges are 1-indexed and inclusive", async () => {
    const out = await readTool.run({ paths: ["f.ts"], ranges: [[2, 4]] }, ctx());
    expect(out.content).toContain("[lines 2-4 of 5]");
    expect(out.content).toContain("2|beta");
    expect(out.content).toContain("4|delta");
    expect(out.content).not.toContain("alpha");
    expect(out.content).not.toContain("epsilon");
  });

  test("ranges[i] binds to paths[i]", async () => {
    put("g.ts", "one\ntwo\nthree\n");
    const out = await readTool.run({ paths: ["f.ts", "g.ts"], ranges: [[1, 1], [3, 3]] }, ctx());
    expect(out.content).toContain("1|alpha");
    expect(out.content).toContain("3|three");
    expect(out.content).not.toContain("2|two");
  });

  test("one bad path does not sink the rest of the batch", async () => {
    const out = await readTool.run({ paths: ["f.ts", "gone.ts"] }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("1|alpha");
    expect(out.content).toContain("no such file: gone.ts");
  });

  test("a path outside the worktree comes back as a visible refusal", async () => {
    const out = await readTool.run({ paths: ["../../etc/hosts"] }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain("outside the worktree");
  });

  test("caps the whole batch, not just each file, and says which files it dropped", async () => {
    // The per-file cap alone is not a cap: ten 2,000-line files is ~90k tokens
    // in one tool result, from a call the model thinks is cheap.
    const many = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n") + "\n";
    for (let i = 0; i < 5; i++) put(`b${i}.txt`, many);

    const out = await readTool.run({ paths: ["b0.txt", "b1.txt", "b2.txt", "b3.txt", "b4.txt"] }, ctx());
    const body = out.content.split("\n").filter((l) => /^\s*\d+\|/.test(l));
    expect(body.length).toBeLessThanOrEqual(4000);
    expect(out.content).toContain("[not read: this call already returned 4000 lines");
    expect(out.content).toContain("==> b4.txt <==");
  });

  test("caps a long file and spells out the call that gets the rest", async () => {
    const many: string[] = [];
    for (let i = 1; i <= 2500; i++) many.push(`line ${i}`);
    put("big.ts", many.join("\n") + "\n");

    const out = await readTool.run({ paths: ["big.ts"] }, ctx());
    expect(out.content).toContain("2000|line 2000");
    expect(out.content).not.toContain("2001|line 2001");
    expect(out.content).toContain("capped at 2000 lines");
    expect(out.content).toContain("ranges=[[2001,2500]]");
  });
});

describe("grep", () => {
  beforeEach(() => {
    put("a.ts", "const needle = 1;\nother\n");
    put("b.md", "needle in prose\n");
    put("sub/c.ts", "no match here\nneedle again\n");
  });

  test("returns path:line:text", async () => {
    const out = await grepTool.run({ pattern: "needle" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("a.ts:1:const needle = 1;");
    expect(out.content).toContain("sub/c.ts:2:needle again");
    expect(out.content).toContain("b.md:1:");
  });

  test("glob narrows to matching filenames", async () => {
    const out = await grepTool.run({ pattern: "needle", glob: "*.ts" }, ctx());
    expect(out.content).toContain("a.ts:1:");
    expect(out.content).not.toContain("b.md");
  });

  test("no matches is an ordinary result, not an error", async () => {
    const out = await grepTool.run({ pattern: "zzzznotpresent" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("no matches");
  });

  test("caps results and says how many it dropped", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) lines.push("needle");
    put("many.txt", lines.join("\n") + "\n");

    const out = await grepTool.run({ pattern: "needle", max_results: 5 }, ctx());
    expect(out.content.split("\n").filter((l) => l.includes("needle")).length).toBe(5);
    expect(out.content).toContain("more results dropped");
  });

  test("refuses a path outside the worktree", async () => {
    const out = await grepTool.run({ pattern: "x", path: "/etc" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain("outside the worktree");
  });

  test("alternation and \\s mean what the model thinks they mean on every engine", async () => {
    // The failure this pins is not an error, it is a lie: under POSIX BRE these
    // patterns match nothing and the tool reports "no matches", which the model
    // reads as proof the symbol does not exist.
    const alt = await grepTool.run({ pattern: "needle|absentword" }, ctx());
    expect(alt.content).toContain("a.ts:1:");

    const ws = await grepTool.run({ pattern: "const\\s+needle" }, ctx());
    expect(ws.content).toContain("a.ts:1:const needle = 1;");

    const cls = await grepTool.run({ pattern: "needle = [0-9]+" }, ctx());
    expect(cls.content).toContain("a.ts:1:");
  });

  test("a pattern the engine cannot compile is an error, never a quiet no-match", async () => {
    const out = await grepTool.run({ pattern: "needle(" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain("no matches");
  });

  test("inside a repo the engine honours .gitignore", async () => {
    put(".gitignore", "build/\n");
    put("build/gen.ts", "needle generated\n");
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: root }).exitCode).toBe(0);

    const out = await grepTool.run({ pattern: "needle" }, ctx());
    expect(out.content).toContain("a.ts:1:");
    expect(out.content).not.toContain("build/gen.ts");
    expect(out.content).not.toContain("plain grep");
  });
});

describe("grep pattern translation", () => {
  test("rewrites Perl shorthands only where they are not already literal", () => {
    expect(toPosixEre("\\s+")).toBe("[[:space:]]+");
    expect(toPosixEre("\\w\\d")).toBe("[[:alnum:]_][[:digit:]]");
    expect(toPosixEre("a\\\\sb")).toBe("a\\\\sb"); // an escaped backslash, then a literal s
    expect(toPosixEre("[\\d]")).toBe("[\\d]"); // inside a bracket expression, left alone
    expect(toPosixEre("[[:space:]]\\w")).toBe("[[:space:]][[:alnum:]_]");
    expect(toPosixEre("x\\by")).toBe("x\\by"); // no POSIX equivalent: passed through
  });
});

describe("ls", () => {
  test("walks a plain directory and collapses past the depth limit", async () => {
    put("top.ts", "x\n");
    put("src/mid.ts", "x\n");
    put("src/deep/leaf.ts", "x\n");
    put("src/deep/leaf2.ts", "x\n");

    const out = await lsTool.run({ depth: 2 }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("top.ts");
    expect(out.content).toContain("src/mid.ts");
    expect(out.content).toContain("src/deep/ (2 files)");
    expect(out.content).not.toContain("leaf.ts");
  });

  test("depth 1 shows only immediate children", async () => {
    put("top.ts", "x\n");
    put("src/mid.ts", "x\n");

    const out = await lsTool.run({ depth: 1 }, ctx());
    expect(out.content).toContain("top.ts");
    expect(out.content).toContain("src/ (1 files)");
    expect(out.content).not.toContain("mid.ts");
  });

  test("honours .gitignore inside a repo", async () => {
    put(".gitignore", "ignored.txt\n");
    put("kept.txt", "x\n");
    put("ignored.txt", "x\n");
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    expect(init.exitCode).toBe(0);

    const out = await lsTool.run({}, ctx());
    expect(out.content).toContain("kept.txt");
    expect(out.content).not.toContain("ignored.txt");
    expect(out.content).not.toContain("plain walk");
  });

  test("refuses a path outside the worktree", async () => {
    const out = await lsTool.run({ path: "/etc" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain("outside the worktree");
  });
});

describe("write", () => {
  test("creates a file and its parent directories", async () => {
    const out = await writeTool.run({ path: "a/b/c.ts", content: "hello\n" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.changedPaths).toEqual(["a/b/c.ts"]);
    expect(readFileSync(join(root, "a/b/c.ts"), "utf8")).toBe("hello\n");
    expect(out.content).toContain("created a/b/c.ts");
  });

  test("rewrites a short existing file", async () => {
    put("s.ts", "old\n");
    const out = await writeTool.run({ path: "s.ts", content: "new\n" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("rewrote s.ts");
    expect(readFileSync(join(root, "s.ts"), "utf8")).toBe("new\n");
  });

  test("refuses to overwrite a file above 400 lines and names edit instead", async () => {
    const big: string[] = [];
    for (let i = 0; i < 500; i++) big.push(`line ${i}`);
    const body = big.join("\n") + "\n";
    put("big.ts", body);

    const out = await writeTool.run({ path: "big.ts", content: "gone\n" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain("500 lines");
    expect(out.content).toContain("Use edit");
    expect(readFileSync(join(root, "big.ts"), "utf8")).toBe(body);
  });

  test("counts lines the way read does: a trailing newline ends a line, it is not one", async () => {
    // The boundary is exact. Counting the terminator would make this file 401
    // lines and refuse a rewrite the description promises is legal.
    const body = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n") + "\n";
    put("exact400.ts", body);

    const out = await writeTool.run({ path: "exact400.ts", content: "a\nb\n" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("rewrote exact400.ts (2 lines)");

    const read = await readTool.run({ paths: ["exact400.ts"] }, ctx());
    expect(read.content).toContain("of 2]"); // write and read agree on the count
  });

  test("refuses a path outside the worktree", async () => {
    const out = await writeTool.run({ path: "../escape.ts", content: "x" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain("outside the worktree");
    expect(existsSync(join(root, "../escape.ts"))).toBe(false);
  });
});

describe("bash", () => {
  test("passes a non-zero exit through as content, not as a tool error", async () => {
    const out = await bashTool.run({ cmd: "echo to-out; echo to-err 1>&2; exit 3" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("exit 3");
    expect(out.content).toContain("to-out");
    expect(out.content).toContain("to-err");
  });

  test("runs inside the worktree by default", async () => {
    put("marker.txt", "x\n");
    const out = await bashTool.run({ cmd: "ls" }, ctx());
    expect(out.content).toContain("marker.txt");
  });

  test("cwd is confined", async () => {
    const out = await bashTool.run({ cmd: "pwd", cwd: "../.." }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain("outside the worktree");
  });

  test("a denied command is refused as visible content, naming the reason", async () => {
    const out = await bashTool.run({ cmd: "sudo chown -R root ." }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain("refused:");
    expect(out.content).toContain("privilege escalation");
  });

  test("rm -rf / is refused before anything spawns", async () => {
    put("survivor.txt", "x\n");
    const out = await bashTool.run({ cmd: "rm -rf / --no-preserve-root" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain("recursive delete of /");
    expect(existsSync(join(root, "survivor.txt"))).toBe(true);
  });

  test("git push is refused: pushing is the user's call", async () => {
    const out = await bashTool.run({ cmd: "git push origin main" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toContain("refused:");
  });

  test("kills a command that outlives its timeout", async () => {
    const out = await bashTool.run({ cmd: "sleep 5", timeout_s: 0.3 }, ctx());
    expect(out.content).toContain("TIMED OUT");
  });
});

describe("todo", () => {
  test("replaces the store wholesale and hands back a copy", async () => {
    const out = await todoTool.run(
      {
        items: [
          { id: "1", text: "read the code", status: "done" },
          { id: "2", text: "fix the bug", status: "doing" },
        ],
      },
      ctx(),
    );

    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("1/2 done");
    expect(out.content).toContain("now: fix the bug");

    const todos = getTodos();
    expect(todos.map((t) => t.id)).toEqual(["1", "2"]);
    todos.length = 0; // a caller mutating the copy must not empty the store
    expect(getTodos().length).toBe(2);
  });

  test("an unknown status degrades to todo rather than bouncing the turn", async () => {
    await todoTool.run({ items: [{ id: "1", text: "x", status: "in-progress" }] }, ctx());
    expect(getTodos()[0]?.status).toBe("todo");
  });
});

describe("finish", () => {
  test("returns a marker, not a verdict", async () => {
    const out = await finishTool.run({ summary: "did the thing", changed_files: ["a.ts"] }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("FINISH REQUESTED");
    expect(finishTool.description).toContain("If they fail, the run does NOT end");
  });

  test("needs a summary", async () => {
    const out = await finishTool.run({ summary: "  ", changed_files: [] }, ctx());
    expect(out.isError).toBe(true);
  });
});

describe("execution modes", () => {
  test("read-only tools are concurrent, mutating tools are sequential", () => {
    const byName = new Map(buildRegistry().map((t) => [t.name, t.executionMode]));
    expect(byName.get("read")).toBe("concurrent");
    expect(byName.get("grep")).toBe("concurrent");
    expect(byName.get("ls")).toBe("concurrent");
    expect(byName.get("bash")).toBe("sequential");
    expect(byName.get("edit")).toBe("sequential");
    expect(byName.get("write")).toBe("sequential");
    expect(byName.get("todo")).toBe("sequential");
    expect(byName.get("finish")).toBe("sequential");
  });
});
