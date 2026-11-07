import { describe, expect, test } from "bun:test";
import { Guards, sanitizeArgs } from "../src/agent/guards.ts";
import type { RawToolCall } from "../src/types.ts";

/** Ids are fresh every turn in a real stream, so they vary here on purpose. */
let nonce = 0;
function call(name: string, args: string): RawToolCall {
  return { id: `call_${nonce++}`, type: "function", function: { name, arguments: args } };
}

function guards(over: Partial<{ maxSteps: number; budgetUsd: number }> = {}): Guards {
  return new Guards({ maxSteps: 12, budgetUsd: 2, ...over });
}

const A = () => [call("read", '{"path":"src/a.ts"}')];
const B = () => [call("edit", '{"path":"src/a.ts","new":"x","old":"y"}')];

describe("noProgress", () => {
  test("a fresh guard and a single turn are never a stall", () => {
    const g = guards();
    expect(g.noProgress()).toBe("none");
    g.recordTurn(A());
    expect(g.noProgress()).toBe("none");
  });

  test("distinct turns stay clean", () => {
    const g = guards();
    for (const p of ["a", "b", "c", "d", "e"]) g.recordTurn([call("read", `{"path":"${p}.ts"}`)]);
    expect(g.noProgress()).toBe("none");
  });

  test("A,B,A,B trips oscillation on the second window, not before", () => {
    const g = guards();
    g.recordTurn(A());
    g.recordTurn(B());
    expect(g.noProgress()).toBe("none");
    g.recordTurn(A()); // A,B,A is still a plausible read-edit-read
    expect(g.noProgress()).toBe("none");
    g.recordTurn(B()); // the second A,B window closes: alternation, not progress
    expect(g.noProgress()).toBe("oscillation");
  });

  test("a three-turn cycle trips once the window recurs", () => {
    const g = guards();
    const C = () => [call("bash", '{"cmd":"bun test"}')];
    for (const t of [A, B, C, A, B]) g.recordTurn(t());
    expect(g.noProgress()).toBe("oscillation");
  });

  test("a full three-cycle still trips at the point the cycle closes", () => {
    const g = guards();
    const C = () => [call("bash", '{"cmd":"bun test"}')];
    for (const t of [A, B, C, A, B, C]) g.recordTurn(t());
    expect(g.noProgress()).toBe("oscillation");
  });

  test("a pair that recurs long after real work is coincidence, not a cycle", () => {
    const g = guards();
    g.recordTurn(A());
    g.recordTurn([call("bash", '{"cmd":"bun test"}')]);
    // A dozen distinct edits: this session is demonstrably getting somewhere.
    for (let i = 0; i < 12; i++) {
      g.recordTurn([call("edit", `{"path":"f${i}.ts"}`)]);
      g.recordTurn([call("read", `{"path":"g${i}.ts"}`)]);
    }
    expect(g.noProgress()).toBe("none");
    // The same read/test pair comes round again 26 turns later. Outside the
    // lookback, so it must not spend a rung of the escalation ladder.
    g.recordTurn(A());
    g.recordTurn([call("bash", '{"cmd":"bun test"}')]);
    expect(g.noProgress()).toBe("none");
  });

  test("identical turns report repeat, which outranks oscillation", () => {
    const g = guards();
    g.recordTurn(A());
    g.recordTurn(A());
    expect(g.noProgress()).toBe("repeat");
    g.recordTurn(A());
    expect(g.noProgress()).toBe("repeat");
  });

  test("whitespace drift is not a different call", () => {
    const g = guards();
    g.recordTurn([call("edit", '{"path":"src/a.ts","old":"y","new":"x"}')]);
    g.recordTurn([call("edit", '{\n  "path" : "src/a.ts",\n  "old" : "y",\n  "new" : "x"\n}')]);
    expect(g.noProgress()).toBe("repeat");
  });

  test("key order is not a different call either", () => {
    const g = guards();
    g.recordTurn([call("edit", '{"new":"x","old":"y","path":"src/a.ts"}')]);
    g.recordTurn([call("edit", '{"path":"src/a.ts","old":"y","new":"x"}')]);
    expect(g.noProgress()).toBe("repeat");
  });

  test("a changed argument value is a different call", () => {
    const g = guards();
    g.recordTurn([call("read", '{"path":"src/a.ts"}')]);
    g.recordTurn([call("read", '{"path":"src/b.ts"}')]);
    expect(g.noProgress()).toBe("none");
  });

  test("tool call ids do not enter the signature", () => {
    const g = guards();
    g.recordTurn(A()); // call_N
    g.recordTurn(A()); // call_N+1, same work
    expect(g.noProgress()).toBe("repeat");
  });

  test("a concurrent turn is a multiset: arrival order does not matter", () => {
    const g = guards();
    g.recordTurn([call("read", '{"path":"a.ts"}'), call("read", '{"path":"b.ts"}')]);
    g.recordTurn([call("read", '{"path":"b.ts"}'), call("read", '{"path":"a.ts"}')]);
    expect(g.noProgress()).toBe("repeat");
  });

  test("multiset, not set: one call differs from the same call twice", () => {
    const g = guards();
    g.recordTurn([call("read", '{"path":"a.ts"}')]);
    g.recordTurn([call("read", '{"path":"a.ts"}'), call("read", '{"path":"a.ts"}')]);
    expect(g.noProgress()).toBe("none");
  });

  test("two text-only turns in a row are a stall", () => {
    const g = guards();
    g.recordTurn([]);
    g.recordTurn([]);
    expect(g.noProgress()).toBe("repeat");
  });

  test("unparseable arguments still hash consistently", () => {
    const g = guards();
    g.recordTurn([call("edit", '{"path":"a.ts","old":')]);
    expect(g.noProgress()).toBe("none");
    g.recordTurn([call("edit", '{"path":"a.ts","old":')]);
    expect(g.noProgress()).toBe("repeat");
  });
});

describe("escalation", () => {
  test("note, then force_consult, then block, and it stays blocked", () => {
    const g = guards();
    g.recordTurn(A());
    g.recordTurn(A());
    g.recordTurn(A());
    expect(g.noProgress()).toBe("repeat");
    expect(g.escalation()).toBe("note");
    expect(g.escalation()).toBe("force_consult");
    expect(g.escalation()).toBe("block");
    expect(g.escalation()).toBe("block");
    expect(g.trips).toBe(4);
  });
});

describe("ceilings", () => {
  test("stepExceeded fires one past maxSteps, so the last step still runs", () => {
    const g = guards({ maxSteps: 12 });
    expect(g.stepExceeded(11)).toBe(false);
    expect(g.stepExceeded(12)).toBe(false);
    expect(g.stepExceeded(13)).toBe(true);
  });

  test("budgetExceeded fires at the budget, because nothing is left to spend", () => {
    const g = guards({ budgetUsd: 2 });
    expect(g.budgetExceeded(1.999999)).toBe(false);
    expect(g.budgetExceeded(2)).toBe(true);
    expect(g.budgetExceeded(2.000001)).toBe(true);
  });
});

describe("reset", () => {
  test("clears both the history and the escalation rung", () => {
    const g = guards();
    g.recordTurn(A());
    g.recordTurn(A());
    expect(g.escalation()).toBe("note");
    g.reset();
    expect(g.signatures.length).toBe(0);
    expect(g.trips).toBe(0);
    expect(g.noProgress()).toBe("none");
    g.recordTurn(A());
    expect(g.noProgress()).toBe("none");
    expect(g.escalation()).toBe("note");
  });
});

describe("sanitizeArgs", () => {
  test("sorts keys and strips whitespace", () => {
    expect(sanitizeArgs('{ "b" : 1,\n  "a" : [ 2, 3 ] }')).toBe('{"a":[2,3],"b":1}');
  });

  test("collapses whitespace-only drift to identical bytes", () => {
    const a = sanitizeArgs('{"path":"src/a.ts","old":"y"}');
    const b = sanitizeArgs('{\n  "old": "y",\n  "path": "src/a.ts"\n}');
    expect(a).toBe(b);
  });

  test("preserves whitespace inside string values", () => {
    expect(sanitizeArgs('{"old":"  indented\\n"}')).toBe('{"old":"  indented\\n"}');
  });

  test("returns the raw string when it is not JSON", () => {
    expect(sanitizeArgs('{"truncated":')).toBe('{"truncated":');
    expect(sanitizeArgs("")).toBe("");
  });
});
