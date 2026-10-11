import { describe, expect, it } from "vitest";
import { evaluateSpec, mergeRuns } from "../src/builder/evaluate.js";
import { loadConfig } from "../src/core/config.js";
import { parseToolDefinitions, toolClassDraft } from "../src/core/toolDefs.js";
import type { AgentSpec, TestCase, TestResult } from "../src/core/types.js";
import type { ChatRequest } from "../src/llm/openrouter.js";
import { anvilWith, FakeClient } from "./helpers.js";

const result = (passed: boolean, score: number, extra: Partial<TestResult> = {}): TestResult => ({
  testId: "t",
  name: "t",
  passed,
  score,
  criteria: [],
  checks: [],
  costUsd: 0.01,
  durationMs: 10,
  ...extra,
});

/** An agent that answers with the text of the model. */
const echo: AgentSpec = {
  specVersion: "anvil/v1",
  id: "echo",
  name: "echo",
  description: "",
  version: 1,
  inputSchema: { type: "object", properties: {} },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "a", type: "llm", config: { prompt: "Say the number." } },
    { id: "output", type: "output", config: { value: { v: "{{nodes.a.output.text}}" } } },
  ],
  edges: [
    { from: "input", to: "a" },
    { from: "a", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 20_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
};
const want4: TestCase = { id: "t1", name: "says 4", input: {}, criteria: [], checks: [{ path: "v", op: "equals", value: "4" }] };

describe("pass^k", () => {
  it("merges the runs of a test: it passes only when every run passes, and shows the first failed run", () => {
    const failed = result(false, 0.2, { error: "the failed run" });
    const m = mergeRuns([result(true, 1), failed, result(true, 0.9)]);
    expect(m).toMatchObject({ passed: false, runs: 3, passes: 2, score: 0.7, error: "the failed run" });
    expect(m.costUsd).toBeCloseTo(0.03);
    expect(m.durationMs).toBe(30);
    expect(mergeRuns([result(true, 1), result(true, 0.8)])).toMatchObject({ passed: true, runs: 2, passes: 2, score: 0.9 });
    // One run: the result stays as it is.
    expect(mergeRuns([failed])).toBe(failed);
  });

  it("a run that the environment stopped does not count", () => {
    const m = mergeRuns([result(false, 0, { environment: "rate limit" }), result(true, 1)]);
    expect(m).toMatchObject({ passed: true, runs: 1, passes: 1, score: 1 });
    const all = mergeRuns([result(false, 0, { environment: "rate limit" }), result(false, 0, { environment: "rate limit" })]);
    expect(all).toMatchObject({ environment: "rate limit", runs: 0, passes: 0 });
  });

  it("an agent that passes only by chance gets a lower pass rate with k=3 than with k=1", async () => {
    let calls = 0;
    // Right on the first call, wrong on the second, right on the third...
    const anvil = await anvilWith(new FakeClient(() => (calls++ % 2 === 0 ? "4" : "5")));
    const env = { services: anvil.runs.services, brain: anvil.runs.brain };
    const k1 = await evaluateSpec(echo, [want4], env);
    expect(k1.report.passRate).toBe(1);
    expect(k1.report.repeats).toBeUndefined();
    const k3 = await evaluateSpec(echo, [want4], { ...env, repeats: 3 });
    expect(k3.report).toMatchObject({ passRate: 0, passAny: 1, repeats: 3 });
    expect(k3.report.results[0]).toMatchObject({ passed: false, runs: 3 });
    expect(k3.report.results[0].passes).toBeGreaterThanOrEqual(1);
    expect(k3.report.results[0].passes).toBeLessThan(3);
  });

  it("each run of a conversation test has its own session, so mock tools start again", async () => {
    const client = new FakeClient((req: ChatRequest) => {
      const system = String(req.messages[0]?.content ?? "");
      if (system.includes("You play a user")) return JSON.stringify({ message: "", finished: true });
      const last = req.messages.at(-1);
      if (req.tools?.length && last?.role !== "tool") {
        const fn = req.tools.find((t) => t.function.name.startsWith("x_tool_book_seat"))!.function.name;
        return { content: "", toolCalls: [{ id: `c${Math.random()}`, type: "function" as const, function: { name: fn, arguments: '{"seat":"1A"}' } }] };
      }
      return `Result: ${String(last?.content ?? "")}`;
    });
    client.config.tools = { ...client.config.tools, adapter: "mock", endpoint: "" };
    const anvil = await anvilWith(client);
    const [d] = parseToolDefinitions([
      {
        name: "book_seat",
        description: "Book a seat",
        parameters: { type: "object", properties: { seat: { type: "string" } }, required: ["seat"] },
        mock: "state.booked = state.booked || []; if (state.booked.includes(args.seat)) return { ok: false }; state.booked.push(args.seat); return { ok: true };",
      },
    ]).map(toolClassDraft);
    await anvil.classes.save(d, { test: false, createdBy: "given" });
    const spec: AgentSpec = {
      ...echo,
      id: "seats",
      inputSchema: { type: "object", properties: { messages: { type: "array" }, session_id: { type: "string" } }, required: ["messages"] },
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "a", type: "agent", config: { task: "Book the seat.", conversation: "{{input.messages}}", classes: [d.type], style: "plain" } },
        { id: "output", type: "output", config: { value: { reply: "{{nodes.a.output.answer}}", done: true } } },
      ],
    };
    const t: TestCase = { id: "c1", name: "books", input: {}, criteria: [], checks: [{ path: "reply", op: "matches", value: '"ok": ?true' }], conversation: { persona: "p", goal: "g", firstMessage: "Book 1A", facts: {}, maxTurns: 2 } };
    const { report } = await evaluateSpec(spec, [t], { services: anvil.runs.services, brain: anvil.runs.brain, repeats: 3 });
    // With one shared session, the second run would get { ok: false }.
    expect(report.results[0]).toMatchObject({ passed: true, runs: 3, passes: 3 });
  });

  it("the config gives the repeats of evolve and of the selection", () => {
    const saved = { ...process.env };
    try {
      delete process.env.ANVIL_EVAL_REPEATS;
      delete process.env.ANVIL_SELECT_REPEATS;
      expect(loadConfig()).toMatchObject({ evalRepeats: 1, selectRepeats: 3 });
      process.env.ANVIL_EVAL_REPEATS = "2";
      process.env.ANVIL_SELECT_REPEATS = "0";
      expect(loadConfig()).toMatchObject({ evalRepeats: 2, selectRepeats: 1 });
    } finally {
      process.env = saved;
    }
  });
});
