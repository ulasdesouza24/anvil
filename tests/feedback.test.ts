import { describe, expect, it } from "vitest";
import { isGivenTest } from "../src/builder/nodes.js";
import type { AgentSpec } from "../src/core/types.js";
import { FeedbackService } from "../src/runtime/feedback.js";
import { anvilWith, FakeClient } from "./helpers.js";

const capital: AgentSpec = {
  specVersion: "anvil/v1",
  id: "capital",
  name: "Capital finder",
  description: "Gives the capital of a country.",
  version: 1,
  inputSchema: { type: "object", properties: { country: { type: "string" } } },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "a", type: "llm", config: { prompt: "Give the capital of {{input.country}}." } },
    { id: "output", type: "output", config: { value: { answer: "{{nodes.a.output.text}}" } } },
  ],
  edges: [
    { from: "input", to: "a" },
    { from: "a", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 20_000, requireApprovalForSideEffects: false },
  tests: [{ id: "t1", name: "France", input: { country: "France" }, criteria: ["The answer is Paris."], checks: [] }],
  meta: {},
};

const sys = (req: { messages: { content?: unknown }[] }) => String(req.messages[0]?.content ?? "");

async function setup() {
  const client = new FakeClient((req) =>
    sys(req).includes("Change the words of the person into test criteria") ? JSON.stringify({ name: "gives the country", criteria: ["The answer names the country of the capital."] }) : "Paris",
  );
  const anvil = await anvilWith(client);
  await anvil.store.saveVersion(capital, { note: "test" });
  const started: unknown[] = [];
  const runs = Object.create(anvil.runs) as typeof anvil.runs;
  runs.start = ((ref: unknown, input: unknown, opts: unknown) => (started.push({ ref, input, opts }), { id: "run_improve" })) as never;
  const feedback = new FeedbackService({ store: anvil.store, kv: anvil.store, brain: anvil.runs.brain, runs });
  return { anvil, feedback, started, client };
}

describe("feedback becomes a test", () => {
  it("a feedback on a run adds a test with the input of the run and criteria from the reason", async () => {
    const { anvil, feedback } = await setup();
    const run = await anvil.runs.run({ agentId: "capital" }, { country: "France" });
    const { feedback: f, test } = await feedback.add(run.id, { reason: "It gives only the city. I want the country too.", expected: "Paris, France" });
    expect(test).toEqual({
      id: "f1",
      name: "feedback: gives the country",
      input: { country: "France" },
      criteria: ["The answer names the country of the capital.", "The output agrees with this expected result: Paris, France"],
      checks: [],
    });
    expect(anvil.store.getSpec("capital")!.tests.map((t) => t.id)).toEqual(["t1", "f1"]);
    // Tests do not change the agent: no new version.
    expect(anvil.store.getAgent("capital")!.versions).toHaveLength(1);
    expect(f).toMatchObject({ agentId: "capital", version: 1, runId: run.id, testId: "f1" });
    expect((await feedback.list("capital")).map((x) => x.id)).toEqual([f.id]);

    const second = await feedback.add(run.id, { reason: "Write it in one sentence." });
    expect(second.test.id).toBe("f2");
  });

  it("rejects a feedback without a reason or on an unknown run", async () => {
    const { anvil, feedback } = await setup();
    const run = await anvil.runs.run({ agentId: "capital" }, { country: "France" });
    await expect(feedback.add(run.id, { reason: "  " })).rejects.toThrow(/Give the reason/);
    await expect(feedback.add("run_nope", { reason: "wrong" })).rejects.toThrow(/does not exist/);
  });

  it("improve starts evolve only when the current version has a feedback test, and evolve keeps feedback tests", async () => {
    const { anvil, feedback, started } = await setup();
    expect(() => feedback.improve("capital")).toThrow(/no feedback test/);
    const run = await anvil.runs.run({ agentId: "capital" }, { country: "France" });
    await feedback.add(run.id, { reason: "It gives only the city." });
    expect(feedback.improve("capital").id).toBe("run_improve");
    expect(started).toEqual([{ ref: { agentId: "anvil-evolver" }, input: { agentId: "capital", rounds: 2 }, opts: { kind: "refine" } }]);
    // Evolve never removes an item of a feedback test or of a given test.
    expect(isGivenTest("f1")).toBe(true);
    expect(isGivenTest("g3")).toBe(true);
    expect(isGivenTest("t1")).toBe(false);
  });
});
