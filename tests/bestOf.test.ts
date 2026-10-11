import { beforeEach, describe, expect, it } from "vitest";
import { builderFor, checkModels, contenders, forgetModelChecks, judge, rank, sharedSuite, suiteFor, weighted, type CandidateScore } from "../src/builder/bestOf.js";
import type { AgentSpec, EvaluationReport, TestCase, TestResult } from "../src/core/types.js";
import type { ChatRequest, ChatResult } from "../src/llm/openrouter.js";
import { anvilWith, FakeClient } from "./helpers.js";

const test = (id: string, input: Record<string, unknown>, extra: Partial<TestCase> = {}): TestCase => ({ id, name: id, input, criteria: [], checks: [], ...extra });
const result = (testId: string, passed: boolean, score: number, extra: Partial<TestResult> = {}): TestResult => ({
  testId,
  name: testId,
  passed,
  score,
  criteria: [],
  checks: [],
  costUsd: 0,
  durationMs: 0,
  ...extra,
});
const report = (results: TestResult[]): EvaluationReport => ({ version: 1, passRate: 0, score: 0, results, costUsd: 0, at: 0 });
const cand = (label: string, passRate: number, score: number, failures: TestResult[] = [], tests = 100): CandidateScore => ({
  label,
  model: `model/${label}`,
  passRate,
  score,
  tests,
  costUsd: 0,
  report: report(failures),
});

beforeEach(() => forgetModelChecks());

describe("best-of-N: the entry", () => {
  it("selects the builder from the request and the config", () => {
    expect(builderFor(undefined, false)).toEqual({ agentId: "anvil-builder" });
    expect(builderFor(undefined, true)).toEqual({ agentId: "anvil-best-of", candidates: "auto" });
    expect(builderFor(1, true)).toEqual({ agentId: "anvil-builder" });
    expect(builderFor(3, false)).toEqual({ agentId: "anvil-best-of", candidates: 3 });
    expect(builderFor("auto", false)).toEqual({ agentId: "anvil-best-of", candidates: "auto" });
    expect(builderFor(99, false)).toEqual({ agentId: "anvil-best-of", candidates: 8 });
    expect(() => builderFor(0, false)).toThrow(/whole number of 1 or more/);
    expect(() => builderFor("many", false)).toThrow(/whole number/);
  });
});

describe("best-of-N: the shared suite", () => {
  it("keeps the given tests, removes duplicates, and gives the places to the candidates in turn", () => {
    const given = [test("g1", { order_id: "A-1" })];
    const r = sharedSuite(
      [
        { label: "A", tests: [test("t1", { order_id: " a-1 " }), test("t2", { order_id: "A-2" }), test("t3", { order_id: "A-3" })] },
        { label: "B", tests: [test("t1", { order_id: "A-2" }), test("t2", { order_id: "B-9" }), test("t3", { order_id: "B-8" })] },
      ],
      given,
      4,
    );
    // A's first test is the given test (same input after trim and lower case). B's first test is A's second test.
    expect(r.tests.map((t) => [t.id, t.input.order_id])).toEqual([
      ["g1", "A-1"],
      ["a1", "A-2"],
      ["b1", "B-9"],
      ["a2", "A-3"],
    ]);
    expect(r.origin).toEqual({ g1: "given", a1: "A", b1: "B", a2: "A" });
    // More given tests than the limit: all stay.
    expect(sharedSuite([{ label: "A", tests: [test("t1", { x: 1 })] }], [test("g1", { x: 2 }), test("g2", { x: 3 })], 1).tests.map((t) => t.id)).toEqual(["g1", "g2"]);
  });

  it("a candidate runs the given tests, its own tests, and the tests of others that fit its input schema", () => {
    const spec = { inputSchema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] } } as unknown as AgentSpec;
    const suite = [test("g1", { id: 1 }), test("a1", { order_id: "A" }), test("b1", { order_id: "B" }), test("c1", { orderId: "C" })];
    const origin = { g1: "given", a1: "A", b1: "B", c1: "C" };
    expect(suiteFor(spec, suite, origin, "A").map((t) => t.id)).toEqual(["g1", "a1", "b1"]);
    // A conversation test fits a conversation agent: its input gets the first message.
    const chat = { inputSchema: { type: "object", properties: { messages: { type: "array" } }, required: ["messages"] } } as unknown as AgentSpec;
    const convo = test("b2", {}, { conversation: { persona: "p", goal: "g", firstMessage: "hi", facts: {}, maxTurns: 3 } });
    expect(suiteFor(chat, [convo, test("b3", { q: 1 })], { b2: "B", b3: "B" }, "A").map((t) => t.id)).toEqual(["b2"]);
  });
});

describe("best-of-N: checks of other candidates", () => {
  it("drops a check of another candidate on a field that this candidate does not give, and keeps the criteria", () => {
    const spec = {
      inputSchema: { type: "object", properties: {} },
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "output", type: "output", config: { value: { reply: "x", done: true } } },
      ],
      edges: [{ from: "input", to: "output" }],
    } as unknown as AgentSpec;
    const checks = [
      { path: "reply", op: "exists" as const },
      { path: "frozen", op: "equals" as const, value: true },
    ];
    const suite = [test("b1", {}, { criteria: ["The agent freezes the card."], checks }), test("a1", {}, { checks })];
    const out = suiteFor(spec, suite, { b1: "B", a1: "A" }, "A");
    // The test of B: the check on "frozen" goes, the check on "reply" and the criteria stay.
    expect(out[0]).toMatchObject({ id: "b1", criteria: ["The agent freezes the card."], checks: [{ path: "reply", op: "exists" }] });
    // The own test of A keeps all its checks: a missing field is a fault of A.
    expect(out[1].checks).toHaveLength(2);
  });
});

describe("best-of-N: scores", () => {
  it("weighs given tests, does not count the environment, and counts a skipped test as failed", () => {
    const r = report([
      result("g1", true, 1),
      result("a1", false, 0.5),
      result("a2", false, 0, { environment: "rate limit" }),
      result("a3", false, 0, { skipped: "the smoke test failed" }),
    ]);
    const origin = { g1: "given", a1: "A", a2: "A", a3: "A" };
    // pass: given 2 of weight 2+1+1 = 4 → 0.5. Score: (2×1 + 0.5) / 3.
    expect(weighted(r, origin, 2)).toEqual({ passRate: 0.5, score: 0.833 });
    expect(weighted(report([]), origin, 2)).toEqual({ passRate: 0, score: 0 });
  });

  it("ranks by pass^k, then score, and finds the close candidates", () => {
    const ranked = rank([cand("A", 0.8, 0.9), cand("B", 0.9, 0.7), cand("C", 0.8, 0.95)]);
    expect(ranked.map((c) => c.label)).toEqual(["B", "C", "A"]);
    expect(contenders(ranked, 0.05).map((c) => c.label)).toEqual(["B"]);
    expect(contenders(rank([cand("A", 0.9, 0.9), cand("B", 0.88, 0.87), cand("C", 0.5, 0.9)]), 0.05).map((c) => c.label)).toEqual(["A", "B"]);
    // One test of 12 is not a clear lead: 1/12 passes against 0/12, with a lower score, goes to the judge.
    expect(contenders(rank([cand("A", 1 / 12, 0.736, [], 12), cand("B", 0, 0.782, [], 12)]), 0.05).map((c) => c.label)).toEqual(["A", "B"]);
    // Two tests of 12 are a lead.
    expect(contenders(rank([cand("A", 2 / 12, 0.8, [], 12), cand("B", 0, 0.8, [], 12)]), 0.05).map((c) => c.label)).toEqual(["A"]);
  });
});

describe("best-of-N: the judge", () => {
  it("sees anonymous candidates in a random order, and its letter becomes the label again", async () => {
    let seen: ChatRequest | undefined;
    const client = new FakeClient((req) => {
      seen = req;
      return JSON.stringify({ choice: "A", reason: "B breaks a rule", severity: { A: "light", B: "severe" } });
    });
    const anvil = await anvilWith(client);
    const failure = result("t1", false, 0.5, {
      criteria: [{ criterion: "The agent refunds at most 100 USD.", probability: 0.1, passed: false }],
      output: { transcript: [{ role: "assistant", content: "I refunded 240 USD.", toolCalls: [{ tool: "x_tool_refund_order_8d6770", args: { amount_usd: 240 } }] }] },
    });
    // random() = 0.99: the order stays [A, B] → letter "A" is candidate A.
    const j = await judge(anvil.runs.brain, "judge/model", "Refund desk", [cand("A", 0.9, 0.9), cand("B", 0.9, 0.88, [failure])], 0.05, () => 0.99);
    expect(seen?.model).toBe("judge/model");
    const user = String(seen?.messages.at(-1)?.content);
    expect(user).not.toContain("model/A");
    expect(user).not.toContain("model/B");
    expect(user).toContain("I refunded 240 USD.");
    // The tool name goes to the judge without the prefix and the hash of the class.
    expect(user).toContain('"tool":"refund_order"');
    expect(j).toMatchObject({ choice: "A", accepted: true, severity: { A: "light", B: "severe" } });
    expect(j.winner.label).toBe("A");
    // random() = 0: the order is [B, A] → letter "A" is candidate B.
    const swapped = await judge(anvil.runs.brain, "judge/model", "Refund desk", [cand("A", 0.9, 0.9), cand("B", 0.9, 0.88)], 0.05, () => 0);
    expect(swapped.choice).toBe("B");
    expect(swapped.severity).toEqual({ B: "light", A: "severe" });
  });

  it("the choice cannot be more than 2 × the margin below the best scores", async () => {
    const anvil = await anvilWith(new FakeClient(() => JSON.stringify({ choice: "B", reason: "x", severity: {} })));
    const j = await judge(anvil.runs.brain, "judge/model", "task", [cand("A", 0.9, 0.9), cand("B", 0.75, 0.9)], 0.05, () => 0.99);
    expect(j).toMatchObject({ choice: "B", accepted: false });
    expect(j.winner.label).toBe("A");
  });
});

describe("best-of-N: models", () => {
  it("removes a model that does not answer with JSON, and keeps the result for some time", async () => {
    let calls = 0;
    const client = new FakeClient((req) => {
      calls++;
      if (req.model === "bad/model") throw new Error("404 No endpoints found");
      return JSON.stringify({ ok: true });
    });
    const anvil = await anvilWith(client);
    const r = await checkModels(anvil.runs.brain, ["good/model", "bad/model"]);
    expect(r.ok).toEqual(["good/model"]);
    expect(r.failed[0]).toMatchObject({ model: "bad/model", error: expect.stringContaining("404") });
    const before = calls;
    await checkModels(anvil.runs.brain, ["good/model", "bad/model"]);
    expect(calls).toBe(before);
  });

  it("the builder model changes only the calls of its run: an explicit model and nested runs keep their model", async () => {
    const client = new FakeClient(() => "ok");
    const anvil = await anvilWith(client);
    const brain = anvil.runs.brain.with({ model: "builder/model" });
    await brain.chat({ purpose: "x", messages: [{ role: "user", content: "a" }] });
    await brain.chat({ purpose: "y", model: "own/model", messages: [{ role: "user", content: "b" }] });
    expect(client.chats.map((c) => c.model)).toEqual(["builder/model", "own/model"]);

    const inner: AgentSpec = {
      specVersion: "anvil/v1",
      id: "inner",
      name: "inner",
      description: "",
      version: 1,
      inputSchema: { type: "object", properties: {} },
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "a", type: "llm", config: { prompt: "inner" } },
        { id: "output", type: "output", config: { value: { t: "{{nodes.a.output.text}}" } } },
      ],
      edges: [
        { from: "input", to: "a" },
        { from: "a", to: "output" },
      ],
      policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 20_000, requireApprovalForSideEffects: false },
      tests: [],
      meta: {},
    };
    await anvil.store.saveVersion(inner, { note: "t" });
    const outer: AgentSpec = {
      ...inner,
      id: "outer",
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "a", type: "llm", config: { prompt: "outer" } },
        { id: "sub", type: "subagent", config: { agentId: "inner", input: {} } },
        { id: "output", type: "output", config: { value: { t: "{{nodes.sub.output}}" } } },
      ],
      edges: [
        { from: "input", to: "a" },
        { from: "a", to: "sub" },
        { from: "sub", to: "output" },
      ],
    };
    client.chats.length = 0;
    await anvil.runs.run({ spec: outer }, {}, { builderModel: "builder/model" });
    const byPrompt = Object.fromEntries(client.chats.map((c) => [String(c.messages.at(-1)?.content), c.model]));
    expect(byPrompt.outer).toBe("builder/model");
    expect(byPrompt.inner).toBeUndefined();
  });
});

/** A fake builder: its answer depends on the builder model of the candidate. */
const fakeBuilder = (): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "fake-builder",
  name: "fake builder",
  description: "",
  version: 1,
  inputSchema: { type: "object", properties: { request: { type: "string" }, builderModel: { type: "string" }, publish: {}, clarify: {}, askOnCost: {}, tests: {} } },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "think", type: "llm", config: { prompt: "design the agent" } },
    {
      id: "out",
      type: "code",
      config: {
        code: `const m = input.builderModel;
if (m === "m/broken") throw new Error("the spec does not compile");
const v = m === "m/bad" ? "5" : "4";
return { agentId: "echo", score: 0.9, published: input.publish !== false, spec: { specVersion: "anvil/v1", id: "echo", name: "Echo", description: "Says 4.", version: 1,
  inputSchema: { type: "object", properties: {} },
  nodes: [{ id: "input", type: "input", config: {} }, { id: "output", type: "output", config: { value: { v } } }],
  edges: [{ from: "input", to: "output" }],
  policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 20000, requireApprovalForSideEffects: false },
  tests: [{ id: "t1", name: "says 4", input: {}, criteria: [], checks: [{ path: "v", op: "equals", value: "4" }] }], meta: {} } };`,
      },
    },
    { id: "output", type: "output", config: { value: "{{nodes.out.output}}" } },
  ],
  edges: [
    { from: "input", to: "think" },
    { from: "think", to: "out" },
    { from: "out", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 60_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
});

/** A fake client: "m/slow" answers late, the judge answers with "B", and other calls give JSON or text. */
class Client extends FakeClient {
  judgeCalls: ChatRequest[] = [];
  constructor() {
    super((req) => {
      const sys = String(req.messages[0]?.content ?? "");
      if (sys.startsWith("You select the best of several AI agents")) {
        this.judgeCalls.push(req);
        return JSON.stringify({ choice: "B", reason: "fewer severe failures", severity: { A: "medium", B: "none" } });
      }
      if (sys.includes("You answer with JSON only.")) return JSON.stringify({ ok: true });
      return "designed";
    });
  }
  async chat(req: ChatRequest): Promise<ChatResult> {
    if (req.model === "m/slow") await new Promise((r) => setTimeout(r, 1500));
    return super.chat(req);
  }
}

async function bestOfRun(models: string[], judgeModel = "j/judge", extra: Partial<Client["config"]["bestOf"]> = {}) {
  const client = new Client();
  client.config.bestOf = { ...client.config.bestOf, models, judgeModel, candidateTimeoutMs: 800, candidateGraceMs: 60_000, margin: 0.05, ...extra };
  client.config.selectRepeats = 2;
  const anvil = await anvilWith(client);
  await anvil.store.saveVersion(fakeBuilder(), { note: "t" });
  const spec: AgentSpec = {
    ...fakeBuilder(),
    id: "best",
    inputSchema: { type: "object", properties: {} },
    nodes: [
      { id: "input", type: "input", config: {} },
      { id: "best_of", type: "anvil_best_of", config: { build: { request: "Say the number 4." }, builder: "fake-builder" } },
      { id: "output", type: "output", config: { value: "{{nodes.best_of.output}}" } },
    ],
    edges: [
      { from: "input", to: "best_of" },
      { from: "best_of", to: "output" },
    ],
    policy: { maxCostUsd: 5, maxNodeExecutions: 50, timeoutMs: 120_000, requireApprovalForSideEffects: false },
  };
  const r = await anvil.runs.run({ spec }, {});
  return { anvil, client, r };
}

describe("best-of-N: the selection", () => {
  it("drops broken and slow candidates, ranks the others on the shared suite, and publishes the clear winner", async () => {
    const { anvil, client, r } = await bestOfRun(["m/broken", "m/slow", "m/bad", "m/good"]);
    expect(r.error).toBeUndefined();
    const out = r.output as {
      agentId: string;
      model: string;
      passRate: number;
      selection: { by: string; winner: string; candidates: { label: string; model: string; status: string; passRate?: number }[] };
    };
    expect(out.model).toBe("m/good");
    expect(out.passRate).toBe(1);
    expect(out.selection.by).toBe("lead");
    expect(out.selection.candidates.map((c) => [c.model, c.status])).toEqual([
      ["m/broken", "failed"],
      ["m/slow", "timeout"],
      ["m/bad", "ready"],
      ["m/good", "ready"],
    ]);
    expect(out.selection.candidates.find((c) => c.model === "m/bad")?.passRate).toBe(0);
    // A clear lead: no judge.
    expect(client.judgeCalls).toHaveLength(0);
    // The winner is saved once, with the selection, and the candidates are not saved.
    const saved = anvil.store.getAgent(out.agentId)!;
    expect(saved.versions).toHaveLength(1);
    expect(saved.versions[0].spec.meta).toMatchObject({ builtBy: "anvil-best-of", builderModel: "m/good" });
    expect(saved.versions[0].evaluation?.repeats).toBe(2);
    // Four candidates, one saved agent: only the winner.
    expect(
      anvil.store
        .listAgents()
        .filter((a) => a.id.startsWith("echo"))
        .map((a) => a.id),
    ).toEqual(["echo"]);
  });

  it("when two candidates are ready, a slow candidate gets only the grace time", async () => {
    const t0 = Date.now();
    const { r } = await bestOfRun(["m/good", "m/slow", "m/bad"], "j/judge", { candidateTimeoutMs: 60_000, candidateGraceMs: 300 });
    const out = r.output as { selection: { candidates: { model: string; status: string; error?: string }[] } };
    const slow = out.selection.candidates.find((c) => c.model === "m/slow")!;
    expect(slow.status).toBe("timeout");
    expect(slow.error).toMatch(/grace time of 0 s after 2 ready candidates/);
    // The run did not wait for the time limit of 60 s.
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  it("stops the build run of a candidate that is out, so it spends no more money", async () => {
    const { anvil, r } = await bestOfRun(["m/good", "m/slow", "m/bad"], "j/judge", { candidateTimeoutMs: 60_000, candidateGraceMs: 300 });
    // The record of the slow candidate: three build runs under the best-of run, one of them not completed.
    const builds = () => anvil.store.listRuns({ includeChildren: true, limit: 100 }).filter((x) => x.parentRunId === r.id && x.kind === "build");
    for (let i = 0; i < 100 && builds().length < 3; i++) await new Promise((res) => setTimeout(res, 50));
    const slowRun = builds().find((x) => x.status !== "completed");
    expect(slowRun).toBeDefined();
    const done = await anvil.runs.waitForRun(slowRun!.id);
    expect(done?.status).toBe("cancelled");
  });

  it("close candidates go to the judge, and the selection keeps its reason", async () => {
    const { client, r } = await bestOfRun(["m/good", "m/good2"]);
    const out = r.output as { selection: { by: string; winner: string; judge: { model: string; choice: string; accepted: boolean } } };
    expect(client.judgeCalls).toHaveLength(1);
    expect(client.judgeCalls[0].model).toBe("j/judge");
    expect(String(client.judgeCalls[0].messages.at(-1)?.content)).not.toMatch(/m\/good/);
    expect(out.selection.by).toBe("judge");
    expect(out.selection.judge).toMatchObject({ model: "j/judge", accepted: true });
    expect(out.selection.winner).toBe(out.selection.judge.choice);
  });

  it("one ready candidate is published without a judge", async () => {
    const { client, r } = await bestOfRun(["m/broken", "m/good"]);
    expect((r.output as { selection: { by: string } }).selection.by).toBe("only");
    expect(client.judgeCalls).toHaveLength(0);
  });

  it("stops with the reasons when no candidate is ready", async () => {
    const { r } = await bestOfRun(["m/broken"]);
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/No candidate is ready: A m\/broken/);
  });
});

describe("best-of-N: the entry points", () => {
  it("the benchmark starts best-of-N with the candidates, and its report gives the winning models", async () => {
    const { runBenchmark } = await import("../src/bench/runner.js");
    const anvil = await anvilWith(new FakeClient());
    const started: { ref: unknown; input: Record<string, unknown> }[] = [];
    const runs = Object.create(anvil.runs) as typeof anvil.runs;
    const fake: AgentSpec = {
      ...fakeBuilder(),
      id: "fake-best",
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "out", type: "code", config: { code: 'return { agentId: "x", score: 0.9, passRate: 1, selection: { model: "m/good", by: "judge", candidates: [1, 2, 3] } }' } },
        { id: "output", type: "output", config: { value: "{{nodes.out.output}}" } },
      ],
      edges: [
        { from: "input", to: "out" },
        { from: "out", to: "output" },
      ],
    };
    runs.start = ((ref: unknown, input: Record<string, unknown>, opts: unknown) => {
      started.push({ ref, input });
      return anvil.runs.start({ spec: fake }, input, opts as never);
    }) as never;
    const report = await runBenchmark({ version: 1, cases: [{ id: "a", category: "x", request: "a request here", expect: {} }] }, { runs, store: anvil.store }, { bestOf: 3 });
    expect(started[0].ref).toEqual({ agentId: "anvil-best-of" });
    expect(started[0].input.candidates).toBe(3);
    expect(report.cases[0].selection).toEqual({ model: "m/good", by: "judge", candidates: 3 });
    expect(report.totals).toMatchObject({ judged: 1, modelWins: { "m/good": 1 } });
    // bestOf false: a normal build.
    await runBenchmark({ version: 1, cases: [{ id: "b", category: "x", request: "a request here", expect: {} }] }, { runs, store: anvil.store }, { bestOf: false });
    expect(started[1].ref).toEqual({ agentId: "anvil-builder" });
  });

  it("a task file can ask for candidates", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { loadTask } = await import("../src/runtime/tasks.js");
    const { tmpDir } = await import("./helpers.js");
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "t.json"), JSON.stringify({ request: "Say 4.", candidates: 3 }));
    expect(loadTask(path.join(dir, "t.json")).candidates).toBe(3);
    fs.writeFileSync(path.join(dir, "u.json"), JSON.stringify({ request: "Say 4.", candidates: "many" }));
    expect(() => loadTask(path.join(dir, "u.json"))).toThrow();
  });

  it("the publish step of a candidate gives the spec and saves nothing", async () => {
    const { AnvilPublishNode } = await import("../src/builder/nodes.js");
    const anvil = await anvilWith(new FakeClient());
    const spec = { ...fakeBuilder(), id: "cand" };
    const ctx = {
      services: anvil.runs.services,
      brain: anvil.runs.brain,
      signal: new AbortController().signal,
      runId: "r",
      node: { id: "publish", type: "anvil_publish", config: {} },
      log: () => undefined,
      emit: () => undefined,
    };
    const r = await AnvilPublishNode.execute({ ...ctx, config: { spec, evaluation: report([result("t1", true, 1)]), mode: "new", save: false } } as never);
    expect(r.output).toMatchObject({ agentId: "cand", version: null, published: false, spec: { id: "cand" } });
    expect(anvil.store.getAgent("cand")).toBeUndefined();
  });
});
