import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectMetrics } from "../src/bench/metrics.js";
import { compareReports, listReports, loadSuite, reportMarkdown, runBenchmark, saveReport, type BenchReport, type BenchSuite } from "../src/bench/runner.js";
import type { AgentSpec, RunEvent, RunRecord } from "../src/core/types.js";
import { anvilWith, FakeClient } from "./helpers.js";

const t = 1;
const rec = (over: Partial<RunRecord>): RunRecord => ({
  id: "r",
  agentId: "a",
  agentName: "a",
  version: 1,
  kind: "build",
  status: "completed",
  input: {},
  startedAt: 0,
  endedAt: 1000,
  usage: { llmCalls: 0, decisionCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
  nodeStates: {},
  events: [],
  ...over,
});

describe("benchmark metrics", () => {
  it("counts steps, searches, cache hits, repeated calls and harness events", () => {
    const evalEvents: RunEvent[] = [
      { type: "llm", t, purpose: "research · step 1", model: "z-ai/glm", inputTokens: 1000, outputTokens: 100, costUsd: 0.001, latencyMs: 1, cachedTokens: 0 },
      { type: "llm", t, purpose: "research · step 2", model: "z-ai/glm", inputTokens: 3000, outputTokens: 100, costUsd: 0.001, latencyMs: 1, cachedTokens: 1000 },
      { type: "llm", t, purpose: "web search: x", model: "openrouter:web_search", inputTokens: 500, outputTokens: 10, costUsd: 0.008, latencyMs: 1 },
      { type: "log", t, nodeId: "research", level: "info", message: "tool fetch_url", data: { args: { url: "u", maxChars: 10 } } },
      { type: "log", t, nodeId: "research", level: "info", message: "tool fetch_url", data: { args: { maxChars: 10, url: "u" } } }, // same args, other key order
      { type: "log", t, nodeId: "research", level: "info", message: "tool fetch_url", data: { args: { url: "v" } } },
      { type: "artifact", t, kind: "harness", data: { event: "recall" } },
      { type: "artifact", t, kind: "harness", data: { event: "detailed_summary" } },
      { type: "artifact", t, kind: "harness", data: { event: "strategy", strategy: "browser" } },
      { type: "artifact", t, kind: "harness", data: { event: "repeat_blocked" } },
    ];
    const build = rec({
      usage: { llmCalls: 0, decisionCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0.05 },
      output: { agentId: "x", score: 0.8, passRate: 0.5, repairs: 1, evolution: [{ accepted: true }, { accepted: false }, { accepted: true }] },
    });
    const child = rec({ id: "c", kind: "eval", parentRunId: "r", events: evalEvents, usage: { llmCalls: 0, decisionCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0.01 } });
    const partial = rec({ id: "p", kind: "eval", parentRunId: "r", output: { status: "partial" } });
    const m = collectMetrics(build, [child, partial]);
    expect(m).toMatchObject({
      published: true,
      score: 0.8,
      repairs: 1,
      evolveRounds: 2,
      acceptedRounds: 1,
      webSearches: 1,
      toolCalls: 3,
      recallReads: 1,
      detailedSummaries: 1,
      evalRuns: 2,
      partialRuns: 1,
      partialRate: 0.5,
    });
    expect(m.repeatedToolCalls).toBe(2); // one exact repeat + one blocked repeat
    expect(m.strategySteps).toEqual({ browser: 1 });
    expect(m.tokensPerStepMax).toBe(3100);
    expect(m.tokensPerStepAvg).toBe(2100);
    expect(m.cacheHitRate).toBe(0.25); // 1000 cached of 4000 model input tokens (web search excluded)
    expect(m.evalCostUsd).toBeCloseTo(0.01);
    expect(m.buildCostUsd).toBeCloseTo(0.04);
  });
});

describe("evolve metrics", () => {
  it("counts removed test items, intent rejections, and the diagnosis of the last evaluation", () => {
    const build = rec({
      output: { agentId: "x", score: 0.9 },
      events: [
        { type: "artifact", t, kind: "evaluation", data: { round: 0, report: { agentProblems: 2, testProblems: 1, disputedProblems: 1 } } },
        { type: "artifact", t, kind: "testsAdjusted", data: { dropped: [{}, {}] } },
        { type: "artifact", t, kind: "intentRejected", data: { round: 1 } },
        { type: "artifact", t, kind: "evaluation", data: { round: 1, report: { agentProblems: 0, testProblems: 0, disputedProblems: 1 } } },
      ] as RunEvent[],
    });
    expect(collectMetrics(build, [])).toMatchObject({ testItemsRemoved: 2, intentRejections: 1, agentProblems: 0, testProblems: 0, disputedItems: 1 });
  });

  it("counts the sandbox programs, the failed ones, and their time", () => {
    const build = rec({ output: { agentId: "x" }, usage: { llmCalls: 0, decisionCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sandboxMs: 300 } });
    const child = rec({
      id: "c",
      kind: "eval",
      usage: { llmCalls: 0, decisionCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sandboxMs: 700 },
      events: [
        { type: "artifact", t, kind: "code", data: { ok: true } },
        { type: "artifact", t, kind: "code", data: { ok: false } },
      ] as RunEvent[],
    });
    expect(collectMetrics(build, [child])).toMatchObject({ programs: 2, failedPrograms: 1, sandboxMs: 1000 });
  });
});

describe("environment metrics", () => {
  it("a case whose tests the environment stopped has no score and is not measured", () => {
    const build = rec({
      output: { agentId: "x", score: 0, passRate: 0 },
      events: [{ type: "artifact", t, kind: "evaluation", data: { round: 0, report: { environmentTests: 3, results: [{}, {}, {}] } } }] as RunEvent[],
    });
    expect(collectMetrics(build, [])).toMatchObject({ unmeasured: true, score: null, environmentTests: 3 });
    const partly = rec({ output: { agentId: "x", score: 0.8 }, events: [{ type: "artifact", t, kind: "evaluation", data: { round: 0, report: { environmentTests: 1, results: [{}, {}] } } }] as RunEvent[] });
    expect(collectMetrics(partly, [])).toMatchObject({ unmeasured: false, score: 0.8 });
  });
});

describe("benchmark suite", () => {
  it("the bundled suite is valid and has unique ids", () => {
    const suite = loadSuite(path.resolve("bench/suite.json"));
    expect(suite.cases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(suite.cases.map((c) => c.id)).size).toBe(suite.cases.length);
    expect(suite.cases.some((c) => c.id === "tefas-funds")).toBe(true);
    // Each library case waits for an earlier case of the suite.
    const ids = suite.cases.map((c) => c.id);
    for (const c of suite.cases.filter((x) => x.after)) expect(ids.indexOf(c.after!)).toBeLessThan(ids.indexOf(c.id));
  });
});

describe("benchmark runner", () => {
  const fakeBuilder = (score: number, cost: number): AgentSpec => ({
    specVersion: "anvil/v1",
    id: "fake-builder",
    name: "fake builder",
    description: "",
    version: 1,
    inputSchema: { type: "object", properties: { request: { type: "string" } } },
    nodes: [
      { id: "input", type: "input", config: {} },
      { id: "out", type: "code", config: { code: `return { agentId: "built", score: ${score}, passRate: 1, repairs: 0, evolution: [{ accepted: true }], cost: ${cost} }` } },
      { id: "output", type: "output", config: { value: "{{nodes.out.output}}" } },
    ],
    edges: [
      { from: "input", to: "out" },
      { from: "out", to: "output" },
    ],
    policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 10_000, requireApprovalForSideEffects: false },
    tests: [],
    meta: {},
  });

  const suite: BenchSuite = {
    version: 1,
    cases: [
      { id: "good", category: "x", request: "a good request here", expect: { minScore: 0.7 } },
      { id: "weak", category: "x", request: "a weak request here", expect: { minScore: 0.9 } },
      { id: "late", category: "y", request: "a third request here", expect: {} },
    ],
  };

  it("runs cases, checks expectations, finds child runs, and saves reports", async () => {
    const anvil = await anvilWith(new FakeClient());
    const report = await runBenchmark(
      suite,
      {
        runs: anvil.runs,
        store: anvil.store,
        startBuild: (c) => {
          const r = anvil.runs.start({ spec: fakeBuilder(c.id === "good" ? 0.8 : 0.5, 0) }, { request: c.request }, { kind: "build" });
          anvil.runs.start({ spec: fakeBuilder(0, 0) }, {}, { kind: "eval", parentRunId: r.id });
          return r;
        },
      },
      { concurrency: 2 },
    );
    expect(report.cases.map((c) => [c.id, c.met])).toEqual([
      ["good", true],
      ["weak", false],
      ["late", true],
    ]);
    expect(report.cases[1].misses[0]).toMatch(/score 0.5 < 0.9/);
    expect(report.cases[0].metrics?.evalRuns).toBe(1);
    expect(report.totals).toMatchObject({ cases: 3, published: 3, met: 2, meanScore: 0.6 });

    const file = saveReport(anvil.config.dataDir, report);
    expect(file).toContain(path.join("bench", report.id));
    expect(listReports(anvil.config.dataDir)[0].id).toBe(report.id);
  });

  it("stops starting cases when the budget is reached", async () => {
    const anvil = await anvilWith(new FakeClient());
    let started = 0;
    const report = await runBenchmark(
      suite,
      {
        runs: anvil.runs,
        store: anvil.store,
        startBuild: () => {
          started++;
          return anvil.runs.start({ agentId: "support-triage-example" }, { message: "How do I export to CSV?" }, { kind: "build" });
        },
      },
      { concurrency: 1, budgetUsd: 0.00001 },
    );
    // The fake client charges for each call, so the first case uses the budget.
    expect(started).toBe(1);
    expect(report.skipped.map((s) => s.id)).toEqual(["weak", "late"]);
  });

  it("starts a case with 'after' only when that case is done, and passes the library option to the builds", async () => {
    const anvil = await anvilWith(new FakeClient());
    const order: string[] = [];
    const inputs: Record<string, unknown>[] = [];
    const ordered: BenchSuite = {
      version: 1,
      cases: [
        { id: "seed", category: "x", request: "the first request", expect: {} },
        { id: "follower", category: "library", request: "a similar request", after: "seed", expect: {} },
        { id: "free", category: "x", request: "another request", expect: {} },
        // A case can only wait for an earlier case: this "after" is ignored.
        { id: "loop", category: "x", request: "a request with a bad after", after: "later", expect: {} },
        { id: "later", category: "x", request: "the last request", expect: {} },
      ],
    };
    const report = await runBenchmark(
      ordered,
      {
        runs: anvil.runs,
        store: anvil.store,
        startBuild: (c, o) => {
          order.push(`start ${c.id}`);
          inputs.push({ useLibrary: o.library ?? true });
          const r = anvil.runs.start({ spec: fakeBuilder(0.9, 0) }, { request: c.request }, { kind: "build" });
          void anvil.runs.waitForRun(r.id).then(() => order.push(`end ${c.id}`));
          return r;
        },
      },
      { concurrency: 3, library: false },
    );
    expect(report.cases.map((c) => c.id)).toEqual(["seed", "follower", "free", "loop", "later"]);
    expect(order.indexOf("start follower")).toBeGreaterThan(order.indexOf("end seed"));
    expect(inputs.every((i) => i.useLibrary === false)).toBe(true);
    expect(report.options.library).toBe(false);
  });

  it("counts the examples and the lessons that a build used", () => {
    const build = rec({
      output: { agentId: "x", score: 0.9 },
      events: [{ type: "artifact", t, kind: "library", data: { taxonomy: { domain: "currency_exchange" }, examples: [{}, {}], lessons: [{}] } }] as RunEvent[],
    });
    expect(collectMetrics(build, [])).toMatchObject({ domain: "currency_exchange", examplesUsed: 2, lessonsUsed: 1 });
  });

  it("the default builder input uses the library unless the option turns it off", async () => {
    const anvil = await anvilWith(new FakeClient());
    const seen: unknown[] = [];
    const start = anvil.runs.start.bind(anvil.runs);
    anvil.runs.start = ((ref: unknown, input: unknown, o: unknown) => {
      seen.push(input);
      return start({ spec: fakeBuilder(0.9, 0) }, {}, o as never);
    }) as typeof anvil.runs.start;
    await runBenchmark({ version: 1, cases: [suite.cases[0]] }, { runs: anvil.runs, store: anvil.store }, { library: false });
    await runBenchmark({ version: 1, cases: [suite.cases[0]] }, { runs: anvil.runs, store: anvil.store }, {});
    expect(seen.map((i) => (i as { useLibrary: boolean }).useLibrary)).toEqual([false, true]);
  });

  it("compares reports and writes a markdown summary with deltas", () => {
    const mk = (score: number, cost: number): BenchReport =>
      ({
        id: `b${score}`,
        startedAt: score,
        endedAt: 0,
        gitCommit: "abc",
        suiteVersion: 1,
        options: {},
        skipped: [],
        totals: { cases: 1, published: 1, met: 1, meanScore: score, costUsd: cost, durationMs: 60000, repeatedToolCalls: 0, tokensPerStepAvg: 0, cacheHitRate: 0, partialRate: 0 },
        cases: [
          {
            id: "c1",
            category: "x",
            runId: "r",
            status: "completed",
            met: true,
            misses: [],
            metrics: { ...collectMetrics(rec({ output: { agentId: "a", score } }), []), score, costUsd: cost },
          },
        ],
      }) as BenchReport;
    const d = compareReports(mk(0.9, 0.2), mk(0.7, 0.5));
    expect(d.meanScore).toBe(0.2);
    expect(d.costUsd).toBe(-0.3);
    expect(d.cases[0]).toEqual({ id: "c1", score: 0.2, costUsd: -0.3 });
    const md = reportMarkdown(mk(0.9, 0.2), mk(0.7, 0.5));
    expect(md).toContain("| mean score | 0.9 | +0.200 |");
    expect(md).toContain("| c1 | x | 0.9 | +0.200 | $0.200 | -0.300 |");
  });
});
