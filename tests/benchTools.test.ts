import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSuite, runBenchmark, type BenchSuite } from "../src/bench/runner.js";
import { fixedInputNames, isGivenTest } from "../src/builder/nodes.js";
import { loadConfig, PROFILES } from "../src/core/config.js";
import { parseExternalTests, withPrefix } from "../src/core/externalTests.js";
import { parseToolDefinitions } from "../src/core/toolDefs.js";
import type { AgentSpec, EvaluationReport } from "../src/core/types.js";
import { loadTask } from "../src/runtime/tasks.js";
import { anvilWith, FakeClient, tmpDir } from "./helpers.js";

describe("tests from outside", () => {
  it("reads Anvil tests, input and expected output pairs, user scenarios, and conversations", () => {
    const tests = parseExternalTests({
      tests: [
        { name: "anvil", input: { q: "x" }, criteria: ["The answer is short."], checks: [{ path: "a", op: "exists" }] },
        { name: "pair", input: { order_id: "O-1" }, expected_output: { status: "shipped", carrier: "UPS", items: [1] } },
        { name: "text", question: "What is 2+2?", answer: "4" },
        {
          name: "scenario",
          instruction: { persona: "Mia", instructions: "You want to move your flight. Confirm when asked.", known_info: { reservation_id: "R1" } },
          actions: [{ name: "change_flight", arguments: { reservation_id: "R1", new_flight: "AN102" } }],
          outputs: ["the new departure time"],
        },
        {
          name: "chat",
          messages: [
            { role: "user", content: "Hi" },
            { role: "assistant", content: "Hello" },
            { role: "user", content: "Bye" },
          ],
          expected: "a goodbye",
        },
      ],
    });
    expect(tests.map((t) => t.id)).toEqual(["x1", "x2", "x3", "x4", "x5"]);
    expect(tests[0]).toMatchObject({ name: "anvil", criteria: ["The answer is short."], checks: [{ path: "a", op: "exists" }] });
    // The simple fields of an expected object become exact checks. The full value is a criterion.
    expect(tests[1].checks).toEqual([
      { path: "status", op: "equals", value: "shipped" },
      { path: "carrier", op: "equals", value: "UPS" },
    ]);
    expect(tests[1].criteria[0]).toMatch(/expected result/);
    expect(tests[2].input).toEqual({ text: "What is 2+2?" });
    expect(tests[3].conversation).toMatchObject({ persona: "Mia", firstMessage: "", facts: { reservation_id: "R1" } });
    expect(tests[3].criteria).toEqual([
      'The agent calls the tool "change_flight" with at least these argument values: {"reservation_id":"R1","new_flight":"AN102"}. More arguments are correct.',
      "The agent tells the user: the new departure time",
    ]);
    expect(tests[4].conversation).toMatchObject({ firstMessage: "Hi", maxTurns: 2 });
    expect(withPrefix(tests, "g").map((t) => t.id)).toEqual(["g1", "g2", "g3", "g4", "g5"]);
    expect(isGivenTest("g2")).toBe(true);
    expect(isGivenTest("t2")).toBe(false);
  });

  it("reads JSON lines and YAML files, and the API mode reads no files", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "t.jsonl"), '{"input": {"a": 1}, "expected": "one"}\n{"input": {"a": 2}, "expected": "two"}\n');
    fs.writeFileSync(path.join(dir, "t.yaml"), "cases:\n  - name: y\n    input: {a: 3}\n    expected: three\n");
    expect(parseExternalTests("t.jsonl", dir)).toHaveLength(2);
    expect(parseExternalTests("t.yaml", dir)[0]).toMatchObject({ name: "y", input: { a: 3 } });
    expect(() => parseExternalTests("t.jsonl", null)).toThrow(/not as a file path/);
    expect(() => parseExternalTests([{ name: "bad" }])).toThrow(/give an input, a scenario, or messages/);
  });

  it("a task file can give its tests as a file", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "tests.json"), JSON.stringify([{ input: { a: 1 }, expected: "one" }]));
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ request: "Say the number as a word.", tests: "tests.json" }));
    const task = loadTask(path.join(dir, "task.json"));
    expect(parseExternalTests(task.tests, task.dir)).toHaveLength(1);
  });
});

describe("profiles", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("the fast profile changes the defaults, and a variable still wins", () => {
    delete process.env.ANVIL_EVOLVE_MAX_ROUNDS;
    delete process.env.ANVIL_EVAL_BUDGET_USD;
    process.env.ANVIL_PROFILE = "fast";
    const fast = loadConfig();
    expect(fast).toMatchObject({ profile: "fast", evolveMaxRounds: 1, evalBudgetUsd: 0.25, harnessMaxAttempts: 2 });
    process.env.ANVIL_EVOLVE_MAX_ROUNDS = "3";
    expect(loadConfig().evolveMaxRounds).toBe(3);
    process.env.ANVIL_PROFILE = "fastest";
    expect(() => loadConfig()).toThrow(/ANVIL_PROFILE must be one of default, fast/);
  });

  it("each setting of a profile is a real config variable", () => {
    const source = fs.readFileSync(path.resolve("src/core/config.ts"), "utf8");
    for (const name of Object.keys(PROFILES.fast)) expect(source).toContain(`num("${name}"`);
  });
});

describe("the practice benchmark", () => {
  it("the practice suite is valid, and its tools and hidden tests parse", () => {
    const suite = loadSuite(path.resolve("bench/practice.json"));
    expect(suite.cases.length).toBeGreaterThanOrEqual(5);
    for (const c of suite.cases) {
      expect(parseExternalTests(c.hiddenTests, null).length).toBeGreaterThan(0);
      if (c.tools) expect(parseToolDefinitions(fs.readFileSync(path.resolve("bench", String(c.tools)), "utf8")).length).toBeGreaterThan(0);
    }
    expect(suite.cases.filter((c) => parseExternalTests(c.hiddenTests, null).some((t) => t.conversation)).length).toBeGreaterThanOrEqual(3);
  });

  it("the rehearsal suite is valid, and its tools and hidden tests parse", () => {
    const suite = loadSuite(path.resolve("bench/rehearsal.json"));
    expect(suite.cases.map((c) => c.id)).toEqual(["hotel-desk", "card-support", "plan-change", "pharmacy-refill", "ticket-triage", "collections"]);
    let hidden = 0;
    for (const c of suite.cases) {
      hidden += parseExternalTests(c.hiddenTests, null).length;
      if (c.tools) expect(parseToolDefinitions(fs.readFileSync(path.resolve("bench", String(c.tools)), "utf8")).some((t) => t.sideEffects)).toBe(true);
    }
    expect(hidden).toBe(27);
  });

  it("hidden tests score the published agent, and the builder does not see them", async () => {
    const anvil = await anvilWith(new FakeClient());
    const built: AgentSpec = {
      specVersion: "anvil/v1",
      id: "built",
      name: "built",
      description: "",
      version: 1,
      inputSchema: { type: "object", properties: {} },
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "output", type: "output", config: { value: { ok: true } } },
      ],
      edges: [{ from: "input", to: "output" }],
      policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 10_000, requireApprovalForSideEffects: false },
      tests: [],
      meta: {},
    };
    await anvil.store.saveVersion(built, { note: "test" });
    const builder: AgentSpec = {
      ...built,
      id: "fake-builder",
      inputSchema: { type: "object", properties: { request: { type: "string" }, tools: {}, tests: {} } },
      nodes: [
        { id: "input", type: "input", config: {} },
        {
          id: "out",
          type: "code",
          config: { code: 'return { agentId: "built", score: 0.9, passRate: 1, sawTests: input.tests !== undefined, sawTools: input.tools !== undefined }' },
        },
        { id: "output", type: "output", config: { value: "{{nodes.out.output}}" } },
      ],
      edges: [
        { from: "input", to: "out" },
        { from: "out", to: "output" },
      ],
    };
    const inputs: unknown[] = [];
    const evaluated: { spec: string; tests: number }[] = [];
    const suite: BenchSuite = {
      version: 1,
      cases: [
        {
          id: "closed",
          category: "practice",
          request: "a request with tools and hidden tests",
          tools: [{ name: "get_x", description: "Gets x", parameters: { type: "object", properties: {} } }],
          hiddenTests: [
            { input: {}, expected: "ok" },
            { input: {}, expected: "ok too" },
          ],
          expect: { minHiddenScore: 0.7 },
        },
      ],
    };
    const report = await runBenchmark(suite, {
      runs: anvil.runs,
      store: anvil.store,
      startBuild: (c) => {
        const input = { request: c.request, ...(c.tools ? { tools: c.tools } : {}) };
        inputs.push(input);
        return anvil.runs.start({ spec: builder }, input, { kind: "build" });
      },
      evaluate: async (spec, tests) => {
        evaluated.push({ spec: spec.id, tests: tests.length });
        return {
          version: 1,
          passRate: 0.5,
          score: 0.6,
          results: [
            { testId: "x1", name: "first", passed: true },
            { testId: "x2", name: "second", passed: false },
          ],
          costUsd: 0.01,
          at: 0,
        } as unknown as EvaluationReport;
      },
    });
    expect(evaluated).toEqual([{ spec: "built", tests: 2 }]);
    expect(inputs[0]).not.toHaveProperty("tests");
    expect(report.cases[0].hidden).toEqual({ passRate: 0.5, score: 0.6, costUsd: 0.01, tests: 2, failed: ["second"] });
    expect(report.cases[0].met).toBe(false);
    expect(report.cases[0].misses[0]).toMatch(/hidden score 0.6 < 0.7/);
    expect(report.totals.hiddenMeanScore).toBe(0.6);
  });
});

describe("fixed input names", () => {
  it("keeps the input names of the request and of the given tests, and ignores names that the request does not have", async () => {
    const client = new FakeClient((req) => (String(req.messages[0]?.content).includes("List the input field names") ? JSON.stringify({ names: ["lines", "made_up"] }) : "{}"));
    const anvil = await anvilWith(client);
    const ctx = { services: anvil.runs.services, brain: anvil.runs.brain, signal: new AbortController().signal, runId: "r", log: () => undefined, emit: () => undefined };
    const names = await fixedInputNames(ctx as never, "The input is lines: a list of expense lines.", [{ input: { lines: [], currency: "USD" }, expected: "x" }]);
    expect(names.sort()).toEqual(["currency", "lines"]);
    // A request without an identifier and without the word "input" needs no model call.
    const before = client.chats.length;
    expect(await fixedInputNames(ctx as never, "Summarize the news of the day.", undefined)).toEqual([]);
    expect(client.chats.length).toBe(before);
  });
});
