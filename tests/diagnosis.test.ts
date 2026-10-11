import { describe, expect, it } from "vitest";
import { evaluateSpec } from "../src/builder/evaluate.js";
import { BLAME_TEXT } from "../src/core/quality.js";
import { followShape } from "../src/builder/nodes.js";
import type { AgentSpec, Answer, Question, TestCase } from "../src/core/types.js";
import { anvilWith, defaultAnswer, FakeClient } from "./helpers.js";

/** An agent that fetches live data and writes one sentence. */
const agent: AgentSpec = {
  specVersion: "anvil/v1",
  id: "quakes",
  name: "quakes",
  description: "Lists the earthquakes of the last 24 hours.",
  version: 1,
  inputSchema: { type: "object", properties: {} },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "w", type: "llm", config: { prompt: "Write the list." } },
    { id: "output", type: "output", config: { value: { text: "{{nodes.w.output.text}}" } } },
  ],
  edges: [
    { from: "input", to: "w" },
    { from: "w", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 50, timeoutMs: 60_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: { taskSpec: { dataNeeds: [{ id: "quakes" }] } },
};

const FAIR = "The text names at least one earthquake.";
const UNFAIR = "The list has exactly 3 earthquakes.";

/** Jev: the unfair criterion fails, and the diagnosis gives it to the test. */
const decide = (id: string, q: Question): Answer => {
  if (q.type === "noul" && String(q.instructions).includes(UNFAIR)) return { type: "noul", noul: 0.1 };
  if (/^d\d+$/.test(id) && q.type === "choice") return { type: "choice", choice: "test_live_value", confidence: 0.9, probabilities: {} };
  return defaultAnswer(id, q);
};

const test = (criteria: string[]): TestCase => ({ id: "t1", name: "typical", input: {}, criteria, checks: [] });

describe("failure diagnosis", () => {
  it("says for each failed item if the agent or the test is wrong, and counts both in the report", async () => {
    const client = new FakeClient(() => "One earthquake in Feke.", decide);
    const anvil = await anvilWith(client);
    const out = await evaluateSpec(agent, [test([FAIR, UNFAIR])], { services: anvil.runs.services, brain: anvil.runs.brain });
    const r = out.report.results[0];
    expect(r.passed).toBe(false);
    expect(r.diagnosis).toEqual([{ kind: "criterion", item: UNFAIR, blame: "test_live_value", confidence: 0.9 }]);
    expect(out.report).toMatchObject({ testProblems: 1, agentProblems: 0 });
    const call = client.decisions.find((d) => d.questions.d0)!;
    expect(call.state).toMatchObject({ live_data: "The agent gets its data from external sources at run time.", agent_output: { text: "One earthquake in Feke." } });
    expect(Object.keys((call.questions.d0 as { criteria: object }).criteria)).toEqual(Object.keys(BLAME_TEXT));
  });

  it("the confidence of a test blame is the probability of all test classes together", async () => {
    const client = new FakeClient(() => "One earthquake in Feke.", (id, q) =>
      /^d\d+$/.test(id) && q.type === "choice"
        ? { type: "choice", choice: "test_live_value", confidence: 0.4, probabilities: { agent: 0.37, test_live_value: 0.5, test_contradicts: 0.12, unclear: 0.01 } }
        : decide(id, q),
    );
    const anvil = await anvilWith(client);
    const out = await evaluateSpec(agent, [test([UNFAIR])], { services: anvil.runs.services, brain: anvil.runs.brain });
    expect(out.report.results[0].diagnosis?.[0]).toMatchObject({ blame: "test_live_value", confidence: 0.62 });
  });

  it("does not diagnose a test that passes", async () => {
    const client = new FakeClient(() => "One earthquake in Feke.", decide);
    const anvil = await anvilWith(client);
    const out = await evaluateSpec(agent, [test([FAIR])], { services: anvil.runs.services, brain: anvil.runs.brain });
    expect(out.report.results[0].diagnosis).toBeUndefined();
    expect(client.decisions.some((d) => d.questions.d0)).toBe(false);
  });

  it("evolve removes a test item that the diagnosis gives to the test, and records why", async () => {
    const client = new FakeClient(() => "One earthquake in Feke.", decide);
    const anvil = await anvilWith(client);
    const evolver: AgentSpec = {
      ...agent,
      id: "ev",
      meta: {},
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "evolve", type: "anvil_evolve", config: { spec: agent, tests: [test([FAIR, UNFAIR])] } },
        { id: "output", type: "output", config: { value: "{{nodes.evolve.output}}" } },
      ],
      edges: [
        { from: "input", to: "evolve" },
        { from: "evolve", to: "output" },
      ],
    };
    const r = await anvil.runs.run({ spec: evolver }, {});
    expect(r.status).toBe("completed");
    const out = r.output as { spec: AgentSpec; history: { change: string }[]; evaluation: { passRate: number } };
    expect(out.history.map((h) => h.change)).toContain("removed 1 faulty test item(s): Test error: live value");
    expect(out.spec.tests[0].criteria).toEqual([FAIR]);
    expect(out.evaluation.passRate).toBe(1);
    const adjusted = r.events.find((e) => e.type === "artifact" && e.kind === "testsAdjusted") as { data: { dropped: { item: string; meaning: string }[] } };
    expect(adjusted.data.dropped[0]).toMatchObject({ item: UNFAIR, meaning: BLAME_TEXT.test_live_value.meaning });
    // No critic call: the agent was not wrong.
    expect(client.chats.some((c) => /critic/.test(String(c.messages[0]?.content)))).toBe(false);
  });
});

describe("intent guard in evolve", () => {
  const evolver = (spec: AgentSpec, tests: TestCase[]): AgentSpec => ({
    ...spec,
    id: "ev",
    meta: {},
    nodes: [
      { id: "input", type: "input", config: {} },
      { id: "evolve", type: "anvil_evolve", config: { spec, tests, maxRounds: 1 } },
      { id: "output", type: "output", config: { value: "{{nodes.evolve.output}}" } },
    ],
    edges: [
      { from: "input", to: "evolve" },
      { from: "evolve", to: "output" },
    ],
  });
  const critic = (req: { messages: { content?: unknown }[] }) =>
    String(req.messages[0]?.content).includes("agent optimizer")
      ? JSON.stringify({ diagnosis: "Lower the threshold.", changes: ["Remove the magnitude filter."], operations: [{ op: "replace", path: "/nodes/1/config/prompt", value: "Write all events." }] })
      : "One earthquake in Feke.";

  const run = async (keep: number) => {
    // The agent fails a fair criterion (agent error), so the critic runs. Jev answers the intent question with `keep`.
    const client = new FakeClient(critic, (id, q) => {
      if (id === "kept") return { type: "noul", noul: keep };
      if (q.type === "noul" && String(q.instructions).includes(UNFAIR)) return { type: "noul", noul: 0.1 };
      return defaultAnswer(id, q);
    });
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: evolver({ ...agent, meta: { request: "List the earthquakes above the threshold." } }, [test([UNFAIR])]) }, {});
    return { r, client };
  };

  it("rejects a candidate that changes the meaning of the request", async () => {
    const { r, client } = await run(0.1);
    const out = r.output as { history: { change: string; accepted: boolean }[] };
    expect(out.history.at(-1)).toMatchObject({ accepted: false, change: "rejected (changes the meaning of the task): Remove the magnitude filter." });
    expect(r.events.some((e) => e.type === "artifact" && e.kind === "intentRejected")).toBe(true);
    const guard = client.decisions.find((d) => d.questions.kept)!;
    expect(guard.state).toMatchObject({ request: "List the earthquakes above the threshold.", changes: ["Remove the magnitude filter."] });
  });

  it("evaluates a candidate that keeps the meaning", async () => {
    const { r } = await run(0.9);
    const out = r.output as { history: { change: string }[] };
    expect(out.history.at(-1)?.change).toBe("Remove the magnitude filter.");
  });
});

describe("second opinion on an unsure diagnosis", () => {
  // Jev leans to a test error, but not enough (0.5) for an action.
  const unsure = (id: string, q: Question): Answer =>
    /^d\d+$/.test(id) && q.type === "choice" ? { type: "choice", choice: "test_live_value", confidence: 0.5, probabilities: { agent: 0.5, test_live_value: 0.5 } } : decide(id, q);
  const reasoner = (blame: string) => (req: { purpose?: string; messages: { content?: unknown }[] }) =>
    String(req.messages[0]?.content).includes("You judge failed test items")
      ? JSON.stringify({ verdicts: [{ i: 0, blame, reason: "The count comes from live data." }] })
      : "One earthquake in Feke.";

  it("two opinions that agree are enough for an action", async () => {
    const anvil = await anvilWith(new FakeClient(reasoner("test_live_value"), unsure));
    const out = await evaluateSpec(agent, [test([UNFAIR])], { services: anvil.runs.services, brain: anvil.runs.brain });
    expect(out.report.results[0].diagnosis?.[0]).toMatchObject({ blame: "test_live_value", confidence: 0.6, secondOpinion: "test_live_value", reason: "The count comes from live data." });
    expect(out.report.results[0].diagnosis?.[0].disputed).toBeUndefined();
  });

  it("two opinions that do not agree make the item disputed", async () => {
    const anvil = await anvilWith(new FakeClient(reasoner("agent"), unsure));
    const out = await evaluateSpec(agent, [test([UNFAIR])], { services: anvil.runs.services, brain: anvil.runs.brain });
    expect(out.report.results[0].diagnosis?.[0]).toMatchObject({ blame: "test_live_value", secondOpinion: "agent", disputed: true });
    expect(out.report).toMatchObject({ agentProblems: 0, testProblems: 0, disputedProblems: 1 });
  });

  it("evolve does not give a disputed item to the critic, and asks a person", async () => {
    const client = new FakeClient(reasoner("agent"), unsure);
    const anvil = await anvilWith(client);
    const evolver: AgentSpec = {
      ...agent,
      id: "ev",
      meta: {},
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "evolve", type: "anvil_evolve", config: { spec: agent, tests: [test([UNFAIR])] } },
        { id: "output", type: "output", config: { value: "{{nodes.evolve.output}}" } },
      ],
      edges: [
        { from: "input", to: "evolve" },
        { from: "evolve", to: "output" },
      ],
    };
    const r = await anvil.runs.run({ spec: evolver }, {});
    const out = r.output as { history: { change: string }[] };
    expect(out.history.at(-1)?.change).toBe("stopped: 1 disputed test item(s) need a person");
    expect(client.chats.some((c) => String(c.messages[0]?.content).includes("agent optimizer"))).toBe(false);
  });
});

describe("smoke test", () => {
  const tests3 = [test([UNFAIR]), { ...test([FAIR]), id: "t2", name: "second" }, { ...test([FAIR]), id: "t3", name: "third" }];

  it("runs the other tests when only a test problem fails the smoke test", async () => {
    const anvil = await anvilWith(new FakeClient(() => "One earthquake in Feke.", decide));
    const notes: string[] = [];
    const out = await evaluateSpec(agent, tests3, { services: anvil.runs.services, brain: anvil.runs.brain, smokeFirst: true, onSmokeNote: (n) => notes.push(n) });
    expect(out.report.results.map((r) => [r.passed, r.skipped ?? null])).toEqual([
      [false, null],
      [true, null],
      [true, null],
    ]);
    expect(notes).toEqual(["The smoke test failed only because of test problems. The other tests run."]);
  });

  it("skips the other tests when the agent fails the smoke test", async () => {
    const agentError = (id: string, q: Question): Answer =>
      /^d\d+$/.test(id) && q.type === "choice" ? { type: "choice", choice: "agent", confidence: 0.9, probabilities: { agent: 0.9 } } : decide(id, q);
    const anvil = await anvilWith(new FakeClient(() => "One earthquake in Feke.", agentError));
    const out = await evaluateSpec(agent, tests3, { services: anvil.runs.services, brain: anvil.runs.brain, smokeFirst: true });
    expect(out.report.results.map((r) => r.skipped ?? null)).toEqual([null, "the smoke test failed", "the smoke test failed"]);
  });
});

describe("configurable thresholds", () => {
  it("the diagnosis confidence comes from the config", async () => {
    // With the default (0.6), a diagnosis at 0.9 needs no second opinion. With 0.95 in the config, it does.
    const client = new FakeClient((req) => (String(req.messages[0]?.content).includes("You judge failed test items") ? JSON.stringify({ verdicts: [] }) : "One earthquake in Feke."), decide);
    client.config.thresholds = { ...client.config.thresholds, diagnosisConfidence: 0.95 };
    const anvil = await anvilWith(client);
    const out = await evaluateSpec(agent, [test([UNFAIR])], { services: anvil.runs.services, brain: anvil.runs.brain });
    expect(client.chats.some((c) => String(c.messages[0]?.content).includes("You judge failed test items"))).toBe(true);
    expect(out.report.results[0].diagnosis?.[0].disputed).toBe(true);
  });

  it("the criterion pass threshold comes from the config", async () => {
    // Jev gives 0.9 to the fair criterion. With a pass threshold of 0.95, it fails.
    const client = new FakeClient(() => "One earthquake in Feke.", decide);
    client.config.thresholds = { ...client.config.thresholds, criterionPass: 0.95 };
    const anvil = await anvilWith(client);
    const out = await evaluateSpec(agent, [test([FAIR])], { services: anvil.runs.services, brain: anvil.runs.brain });
    expect(out.report.results[0].criteria[0]).toMatchObject({ probability: 0.9, passed: false });
  });
});

describe("type checks follow the output shape", () => {
  it("a type check that agreed with the old shape gets the new type, other checks stay", () => {
    const before: AgentSpec = { ...agent, outputSchema: { type: "object", properties: { people: { type: "object" }, n: { type: "number" } } }, nodes: [{ id: "input", type: "input", config: {} }, { id: "output", type: "output", config: { value: { people: "{{input}}", n: 1 } } }] };
    const after: AgentSpec = { ...before, outputSchema: { type: "object", properties: { people: { type: "array" }, n: { type: "number" } } } };
    const tests: TestCase[] = [
      {
        id: "t1",
        name: "t1",
        input: {},
        criteria: [],
        checks: [
          { path: "people", op: "type", value: "object" },
          { path: "n", op: "type", value: "number" },
          { path: "people", op: "exists" },
        ],
      },
    ];
    const r = followShape(tests, before, after);
    expect(r.changed).toEqual([{ test: "t1", path: "people", from: "object", to: "array" }]);
    expect(r.tests[0].checks).toEqual([
      { path: "people", op: "type", value: "array" },
      { path: "n", op: "type", value: "number" },
      { path: "people", op: "exists" },
    ]);
    // A check that did not agree with the old shape was written on purpose: it stays.
    const own: TestCase[] = [{ ...tests[0], checks: [{ path: "people", op: "type", value: "string" }] }];
    expect(followShape(own, before, after).changed).toEqual([]);
  });
});
