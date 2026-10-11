import { describe, expect, it } from "vitest";
import { evaluateSpec } from "../src/builder/evaluate.js";
import type { AgentSpec, RunRecord, TestCase } from "../src/core/types.js";
import { Brain } from "../src/llm/brain.js";
import { SearchCache, searchKey } from "../src/llm/searchCache.js";
import { CostModel, featuresOf } from "../src/runtime/costModel.js";
import { anvilWith, FakeClient } from "./helpers.js";

const spec = (nodes: AgentSpec["nodes"], edges: AgentSpec["edges"], extra: Partial<AgentSpec> = {}): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "t",
  name: "t",
  description: "doubles n",
  version: 1,
  inputSchema: { type: "object", properties: { n: { type: "number" }, q: { type: "string" } } },
  nodes,
  edges,
  policy: { maxCostUsd: 1, maxNodeExecutions: 50, timeoutMs: 30_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
  ...extra,
});

/** A fake client with a paid web search that counts its calls. */
function searchClient() {
  const c = new FakeClient();
  let calls = 0;
  Object.assign(c.config, { searchProviders: ["openrouter"], maxPaidSearchesPerRun: 12, searchCacheTtlMs: 3_600_000 });
  (c as unknown as { webSearch: unknown }).webSearch = async (q: string) => {
    calls++;
    return { results: [{ title: q, url: `https://x.test/${calls}`, snippet: "s" }], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.008 }, latencyMs: 1 };
  };
  return { client: c, calls: () => calls };
}

describe("search cache", () => {
  it("shares one entry for similar queries and expires entries", async () => {
    expect(searchKey("TEFAS fon, getiri!", 5)).toBe(searchKey("getiri  tefas FON", 5));
    expect(searchKey("a b", 5)).not.toBe(searchKey("a b", 3));
    let now = 0;
    const cache = new SearchCache({ ttlMs: 1000, max: 2, now: () => now });
    await cache.set("one", 5, [{ title: "1", url: "u", snippet: "" }], "openrouter");
    expect((await cache.get("ONE", 5))?.results[0].title).toBe("1");
    now = 2000;
    expect(await cache.get("one", 5)).toBeUndefined();
    await cache.set("a", 1, [{ title: "a", url: "u", snippet: "" }], "p");
    await cache.set("b", 1, [{ title: "b", url: "u", snippet: "" }], "p");
    await cache.set("c", 1, [{ title: "c", url: "u", snippet: "" }], "p");
    expect(await cache.get("a", 1)).toBeUndefined(); // the oldest entry went first
    expect(await cache.get("c", 1)).toBeDefined();
  });

  it("answers repeated searches from the cache and enforces the paid search budget", async () => {
    const { client, calls } = searchClient();
    const cache = new SearchCache({ ttlMs: 60_000, max: 100 });
    const budget = { paidSearches: { used: 0, max: 1 } };
    const logs: string[] = [];
    const brain = new Brain(client, { budget, emit: (e) => e.type === "log" && logs.push(e.message) }, { searchCache: cache });
    expect((await brain.webSearch("fund returns turkey")).results).toHaveLength(1);
    expect((await brain.webSearch("Turkey fund returns")).provider).toContain("cached");
    expect(calls()).toBe(1);
    expect((await brain.webSearch("something else")).results).toHaveLength(0); // budget used
    expect(calls()).toBe(1);
    expect(logs.join("\n")).toMatch(/paid search budget used/);
  });

  it("applies the budget for each run in the engine", async () => {
    const { client, calls } = searchClient();
    const anvil = await anvilWith(client);
    const s = spec(
      [
        { id: "input", type: "input", config: {} },
        { id: "a", type: "web_search", config: { query: "first {{input.q}}" } },
        { id: "b", type: "web_search", config: { query: "second {{input.q}}" } },
        { id: "output", type: "output", config: { value: { a: "{{nodes.a.output.count}}", b: "{{nodes.b.output.count}}" } } },
      ],
      [
        { from: "input", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "output" },
      ],
    );
    s.policy.maxPaidSearches = 1;
    const r1 = await anvil.runs.run({ spec: s }, { q: "x" });
    expect(r1.output).toEqual({ a: 1, b: 0 });
    // A new run has a new budget. The cache answers the first query for free,
    // so the second query can use the one paid search.
    const r2 = await anvil.runs.run({ spec: s }, { q: "x" });
    expect(r2.output).toEqual({ a: 1, b: 1 });
    expect(calls()).toBe(2);
    // Now the cache answers both queries, and no paid search runs.
    const r3 = await anvil.runs.run({ spec: s }, { q: "x" });
    expect(r3.output).toEqual({ a: 1, b: 1 });
    expect(calls()).toBe(2);
  });
});

describe("staged evaluation", () => {
  const doubler = spec(
    [
      { id: "input", type: "input", config: {} },
      { id: "calc", type: "code", config: { code: "return { v: input.n * 2 }" } },
      { id: "output", type: "output", config: { value: "{{nodes.calc.output}}" } },
    ],
    [
      { from: "input", to: "calc" },
      { from: "calc", to: "output" },
    ],
  );
  const test = (id: string, n: number, expected: number): TestCase => ({ id, name: id, input: { n }, criteria: [], checks: [{ path: "v", op: "equals", value: expected }] });

  it("skips the other tests when the smoke test fails, and runs them all when it passes", async () => {
    const anvil = await anvilWith(new FakeClient());
    const env = { services: anvil.runs.services, brain: anvil.runs.brain, smokeFirst: true };
    const failed = await evaluateSpec(doubler, [test("a", 1, 99), test("b", 2, 4), test("c", 3, 6)], env);
    expect(failed.report.results.map((r) => [r.testId, r.passed, r.skipped ?? null])).toEqual([
      ["a", false, null],
      ["b", false, "the smoke test failed"],
      ["c", false, "the smoke test failed"],
    ]);
    expect(failed.report.skippedTests).toBe(2);
    // The skipped tests did not run: they have no score. The score is the score of the smoke test.
    expect(failed.report.score).toBe(failed.report.results[0].score);
    expect(failed.report.passRate).toBe(0);
    expect(anvil.store.listRuns({ kind: "eval", includeChildren: true })).toHaveLength(1);

    const ok = await evaluateSpec(doubler, [test("a", 1, 2), test("b", 2, 4), test("c", 3, 6)], env);
    expect(ok.report.passRate).toBe(1);
    expect(ok.report.skippedTests).toBe(0);
  });

  it("runs the other tests when the failed smoke test has a good score", async () => {
    const anvil = await anvilWith(new FakeClient());
    const notes: string[] = [];
    const env = { services: anvil.runs.services, brain: anvil.runs.brain, smokeFirst: true, onSmokeNote: (n: string) => notes.push(n) };
    // One of two checks fails: the score is 0.5, the minimum of the config.
    const half: TestCase = { id: "a", name: "a", input: { n: 1 }, criteria: [], checks: [{ path: "v", op: "equals", value: 2 }, { path: "v", op: "equals", value: 99 }] };
    const r = await evaluateSpec(doubler, [half, test("b", 2, 4), test("c", 3, 6)], env);
    expect(r.report.results.map((x) => [x.testId, x.passed, x.skipped ?? null])).toEqual([
      ["a", false, null],
      ["b", true, null],
      ["c", true, null],
    ]);
    expect(notes[0]).toMatch(/The smoke test failed with the score 0.5, which is not below 0.5. The other tests run./);
  });

  it("stops starting tests when the evaluation budget is used", async () => {
    const anvil = await anvilWith(new FakeClient());
    const paid = spec(
      [
        { id: "input", type: "input", config: {} },
        { id: "w", type: "llm", config: { prompt: "hi" } },
        { id: "output", type: "output", config: { value: "{{nodes.w.output.text}}" } },
      ],
      [
        { from: "input", to: "w" },
        { from: "w", to: "output" },
      ],
    );
    const tests: TestCase[] = ["a", "b", "c"].map((id) => ({ id, name: id, input: {}, criteria: [], checks: [] }));
    const r = await evaluateSpec(paid, tests, { services: anvil.runs.services, brain: anvil.runs.brain, concurrency: 1, budgetUsd: 0.00005 });
    expect(r.report.results.filter((x) => x.skipped?.includes("budget")).length).toBe(2);
  });

  it("evolve stops when the evaluation budget is used", async () => {
    const anvil = await anvilWith(new FakeClient());
    const evolver = spec(
      [
        { id: "input", type: "input", config: {} },
        { id: "evolve", type: "anvil_evolve", config: { spec: doubler, tests: [test("a", 1, 99)], evalBudgetUsd: 0 } },
        { id: "output", type: "output", config: { value: "{{nodes.evolve.output.history}}" } },
      ],
      [
        { from: "input", to: "evolve" },
        { from: "evolve", to: "output" },
      ],
    );
    const r = await anvil.runs.run({ spec: evolver }, {});
    expect(r.status).toBe("completed");
    const history = r.output as { round: number; change: string }[];
    expect(history.at(-1)).toMatchObject({ round: 1, change: "stopped: evaluation budget used" });
  });
});

describe("build cost estimate", () => {
  const mem = () => {
    const data = new Map<string, unknown>();
    return { get: async (ns: string, k: string) => data.get(`${ns}/${k}`), set: async (ns: string, k: string, v: unknown) => void data.set(`${ns}/${k}`, v) };
  };
  const f = { pattern: "pipeline", needsWeb: false, complexity: 1, evaluate: true, optimize: true };

  it("uses priors first, then calibrates from similar past builds", async () => {
    const m = new CostModel(mem());
    const p = await m.estimate(f);
    expect(p.basis).toBe("prior");
    expect((await m.estimate({ ...f, needsWeb: true })).highUsd).toBeGreaterThan(p.highUsd);
    for (const c of [0.01, 0.02, 0.03, 0.04]) await m.record(f, c);
    const h = await m.estimate(f);
    expect(h).toMatchObject({ basis: "history", samples: 4 });
    expect(h.lowUsd).toBeCloseTo(0.0175, 4);
    expect(h.highUsd).toBeCloseTo(0.037, 4);
    // Another pattern with the same web need falls back to the wider group.
    expect((await m.estimate({ ...f, pattern: "rag_qa" })).basis).toBe("history");
    // Other evaluate settings do not share samples.
    expect((await m.estimate({ ...f, evaluate: false })).basis).toBe("prior");
  });

  it("reads build features from a finished build run", () => {
    const r = {
      input: { optimize: false },
      events: [{ type: "artifact", t: 1, kind: "triage", data: { pattern: "rag_qa", complexity: 2, flags: { needs_web: 0.9 } } }],
    } as unknown as RunRecord;
    expect(featuresOf(r)).toEqual({ pattern: "rag_qa", needsWeb: true, complexity: 2, evaluate: true, optimize: false });
  });

  it("stops an unattended build above the limit, and asks a person in an attended build", async () => {
    const anvil = await anvilWith(new FakeClient());
    const stopped = await anvil.runs.run({ agentId: "anvil-builder" }, { request: "summarize meeting notes", askOnCost: false, confirmAboveUsd: 0 });
    expect(stopped.status).toBe("completed");
    expect(stopped.output).toMatchObject({ cancelled: true });
    expect(stopped.nodeStates.analyze).toBe("skipped");

    const asked = anvil.runs.start({ agentId: "anvil-builder" }, { request: "summarize meeting notes", confirmAboveUsd: 0 });
    for (let i = 0; i < 100 && !anvil.runs.pendingRequests(asked.id).length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(anvil.runs.pendingRequests(asked.id)[0].nodeId).toBe("approve_cost");
    anvil.runs.resume(asked.id, "approve_cost", { approved: false });
    const done = await anvil.runs.waitForRun(asked.id);
    expect(done?.output).toMatchObject({ cancelled: true });
  });
});
