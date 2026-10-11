import { describe, expect, it } from "vitest";
import { EXAMPLE_SPEC } from "../src/builder/guide.js";
import type { AgentSpec, Answer, Question } from "../src/core/types.js";
import { FakeClient, anvilWith } from "./helpers.js";

const base = (nodes: AgentSpec["nodes"], edges: AgentSpec["edges"], extra: Partial<AgentSpec> = {}): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "t",
  name: "t",
  description: "",
  version: 1,
  inputSchema: { type: "object", properties: { text: { type: "string" }, n: { type: "number" } } },
  nodes,
  edges,
  policy: { maxCostUsd: 1, maxNodeExecutions: 100, timeoutMs: 60_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
  ...extra,
});

describe("engine", () => {
  it("routes by Jev decision and skips untaken branches (dead-path elimination)", async () => {
    const client = new FakeClient(
      (req) => `reply to: ${String(req.messages.at(-1)?.content).slice(0, 20)}`,
      (_id: string, q: Question): Answer => {
        if (q.type === "choice") return { type: "choice", choice: "how_to", confidence: 0.92, probabilities: { refund: 0.04, how_to: 0.92, other: 0.04 } };
        if (q.type === "score") return { type: "score", score: 0.2, confidence: 0.8, probabilities: {} };
        return { type: "noul", noul: 0.95 };
      },
    );
    const anvil = await anvilWith(client);
    const rec = await anvil.runs.run({ spec: EXAMPLE_SPEC }, { message: "How do I export to CSV?" });
    expect(rec.status).toBe("completed");
    expect(rec.nodeStates).toMatchObject({ classify: "done", howto_reply: "done", refund_reply: "skipped", handoff_reply: "skipped", output: "done" });
    expect(rec.output).toMatchObject({ intent: "how_to", anger: 0.2 });
    expect(String((rec.output as { reply: string }).reply)).toMatch(/^reply to:/);
    // input defaults applied from inputSchema
    expect((rec.input as Record<string, unknown>).message).toBeDefined();
    expect(rec.usage.decisionCalls).toBe(1);
  });

  it("sends low-confidence answers to the uncertain port", async () => {
    const client = new FakeClient(
      () => "handoff",
      (_id: string, q: Question): Answer =>
        q.type === "choice"
          ? { type: "choice", choice: "refund", confidence: 0.2, probabilities: { refund: 0.4, how_to: 0.35, other: 0.25 } }
          : { type: "score", score: 1, confidence: 1, probabilities: {} },
    );
    const anvil = await anvilWith(client);
    const rec = await anvil.runs.run({ spec: EXAMPLE_SPEC }, { message: "hmm" });
    expect(rec.nodeStates.handoff_reply).toBe("done");
    expect(rec.nodeStates.refund_reply).toBe("skipped");
  });

  it("runs independent branches in parallel and joins with merge", async () => {
    let concurrent = 0;
    let peak = 0;
    const client = new FakeClient();
    client.chat = async (req) => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return {
        content: `ok:${String(req.messages.at(-1)?.content)}`,
        toolCalls: [],
        finishReason: "stop",
        model: "f",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        latencyMs: 1,
      };
    };
    const anvil = await anvilWith(client);
    const spec = base(
      [
        { id: "input", type: "input", config: {} },
        { id: "a", type: "llm", config: { prompt: "A {{input.text}}" } },
        { id: "b", type: "llm", config: { prompt: "B {{input.text}}" } },
        { id: "join", type: "merge", config: { strategy: "object" } },
        { id: "output", type: "output", config: { value: { a: "{{nodes.join.output.a.text}}", b: "{{nodes.b.output.text}}" } } },
      ],
      [
        { from: "input", to: "a" },
        { from: "input", to: "b" },
        { from: "a", to: "join" },
        { from: "b", to: "join" },
        { from: "join", to: "output" },
      ],
    );
    const rec = await anvil.runs.run({ spec }, { text: "x" });
    expect(rec.status).toBe("completed");
    expect(peak).toBe(2);
    expect(rec.output).toEqual({ a: "ok:A x", b: "ok:B x" });
  });

  it("routes failures to the error port and retries", async () => {
    let calls = 0;
    const client = new FakeClient(() => {
      calls++;
      throw new Error("provider down");
    });
    const anvil = await anvilWith(client);
    const spec = base(
      [
        { id: "input", type: "input", config: {} },
        { id: "risky", type: "llm", config: { prompt: "p" }, retry: { maxAttempts: 2, backoffMs: 1 } },
        { id: "fallback", type: "transform", config: { value: { text: "fallback because {{nodes.risky.output.error}}" } } },
        { id: "output", type: "output", config: { value: "{{nodes.fallback.output.text ?? nodes.risky.output.text}}" } },
      ],
      [
        { from: "input", to: "risky" },
        { from: "risky", to: "fallback", port: "error" },
        { from: "risky", to: "output" },
        { from: "fallback", to: "output" },
      ],
    );
    const rec = await anvil.runs.run({ spec }, {});
    expect(calls).toBe(2);
    expect(rec.status).toBe("completed");
    expect(String(rec.output)).toContain("fallback because provider down");
  });

  it("fails the run when an unhandled node fails", async () => {
    const client = new FakeClient(() => {
      throw new Error("boom");
    });
    const anvil = await anvilWith(client);
    const spec = base(
      [
        { id: "input", type: "input", config: {} },
        { id: "x", type: "llm", config: { prompt: "p" }, retry: { maxAttempts: 1 } },
        { id: "output", type: "output", config: { value: "{{nodes.x.output.text}}" } },
      ],
      [
        { from: "input", to: "x" },
        { from: "x", to: "output" },
      ],
    );
    const rec = await anvil.runs.run({ spec }, {});
    expect(rec.status).toBe("failed");
    expect(rec.error).toContain("boom");
  });

  it("maps over items with code and router rules", async () => {
    const anvil = await anvilWith(new FakeClient());
    const spec = base(
      [
        { id: "input", type: "input", config: {} },
        { id: "nums", type: "code", config: { code: "return { list: [1,2,3,4].map(x => x * input.n) }" } },
        { id: "sq", type: "map", config: { items: "{{nodes.nums.output.list}}", mode: "code", code: "return item * item" } },
        { id: "total", type: "code", config: { code: "return { sum: nodes.sq.output.results.reduce((a,b)=>a+b,0) }" } },
        { id: "gate", type: "router", config: { rules: [{ port: "big", when: { left: "{{nodes.total.output.sum}}", op: "gt", right: 100 } }], default: "small" } },
        { id: "big", type: "transform", config: { value: "big:{{nodes.total.output.sum}}" } },
        { id: "small", type: "transform", config: { value: "small:{{nodes.total.output.sum}}" } },
        { id: "output", type: "output", config: { value: "{{nodes.big.output ?? nodes.small.output}}" } },
      ],
      [
        { from: "input", to: "nums" },
        { from: "nums", to: "sq" },
        { from: "sq", to: "total" },
        { from: "total", to: "gate" },
        { from: "gate", to: "big", port: "big" },
        { from: "gate", to: "small", port: "small" },
        { from: "big", to: "output" },
        { from: "small", to: "output" },
      ],
    );
    const rec = await anvil.runs.run({ spec }, { n: "2" }); // "2" is coerced to a number by the input schema
    expect(rec.status).toBe("completed");
    expect(rec.output).toBe("big:120");
    expect(rec.nodeStates.small).toBe("skipped");
  });

  it("pauses for human approval and resumes", async () => {
    const anvil = await anvilWith(new FakeClient(() => "draft email"));
    const spec = base(
      [
        { id: "input", type: "input", config: {} },
        { id: "draft", type: "llm", config: { prompt: "write" } },
        { id: "approve", type: "human_approval", config: { title: "Send?", payload: "{{nodes.draft.output.text}}" } },
        { id: "sent", type: "transform", config: { value: "sent: {{nodes.approve.output.payload}}" } },
        { id: "dropped", type: "transform", config: { value: "not sent" } },
        { id: "output", type: "output", config: { value: "{{nodes.sent.output ?? nodes.dropped.output}}" } },
      ],
      [
        { from: "input", to: "draft" },
        { from: "draft", to: "approve" },
        { from: "approve", to: "sent", port: "approved" },
        { from: "approve", to: "dropped", port: "rejected" },
        { from: "sent", to: "output" },
        { from: "dropped", to: "output" },
      ],
    );
    const started = anvil.runs.start({ spec }, {});
    for (let i = 0; i < 50 && !anvil.runs.pendingRequests(started.id).length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(anvil.runs.activeRecord(started.id)?.status).toBe("waiting");
    expect(anvil.runs.pendingRequests(started.id)[0].request.payload).toBe("draft email");
    expect(anvil.runs.resume(started.id, "approve", { approved: true, payload: "edited email" })).toBe(true);
    const rec = await anvil.runs.waitForRun(started.id);
    expect(rec?.output).toBe("sent: edited email");

    const auto = await anvil.runs.run({ spec }, {}, { humanMode: "auto" });
    expect(auto.output).toBe("sent: draft email");
  });

  it("enforces the cost budget", async () => {
    const client = new FakeClient();
    client.chat = async () => ({ content: "x", toolCalls: [], finishReason: "stop", model: "f", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.6 }, latencyMs: 1 });
    const anvil = await anvilWith(client);
    const spec = base(
      [
        { id: "input", type: "input", config: {} },
        { id: "a", type: "llm", config: { prompt: "p" } },
        { id: "b", type: "llm", config: { prompt: "p" } },
        { id: "output", type: "output", config: { value: "{{nodes.b.output.text}}" } },
      ],
      [
        { from: "input", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "output" },
      ],
    );
    const rec = await anvil.runs.run({ spec }, {});
    expect(rec.status).toBe("failed");
    expect(rec.error).toMatch(/Budget exceeded/);
  });

  it("validates run input against the input schema", async () => {
    const anvil = await anvilWith(new FakeClient());
    const rec = await anvil.runs.run({ spec: EXAMPLE_SPEC }, {});
    expect(rec.status).toBe("failed");
    expect(rec.error).toMatch(/Invalid input/);
  });

  it("runs a tool agent loop with native tool calls", async () => {
    let step = 0;
    const client = new FakeClient((req) => {
      step++;
      if (step === 1) return { content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "calculator", arguments: '{"expression":"17*23"}' } }] };
      const toolMsg = req.messages.find((m) => m.role === "tool");
      return `The answer is ${JSON.parse(String(toolMsg?.content)).result}`;
    });
    const anvil = await anvilWith(client);
    const spec = base(
      [
        { id: "input", type: "input", config: {} },
        { id: "solve", type: "agent", config: { task: "What is 17*23?", tools: ["calculator"], maxSteps: 4 } },
        { id: "output", type: "output", config: { value: "{{nodes.solve.output.answer}}" } },
      ],
      [
        { from: "input", to: "solve" },
        { from: "solve", to: "output" },
      ],
    );
    const rec = await anvil.runs.run({ spec }, {});
    expect(rec.output).toBe("The answer is 391");
  });

  it("composes saved agents via subagent and map(mode=agent), and blocks self-recursion", async () => {
    const anvil = await anvilWith(new FakeClient());
    const doubler = base(
      [
        { id: "input", type: "input", config: {} },
        { id: "calc", type: "code", config: { code: "return { value: input.n * 2 }" } },
        { id: "output", type: "output", config: { value: "{{nodes.calc.output.value}}" } },
      ],
      [
        { from: "input", to: "calc" },
        { from: "calc", to: "output" },
      ],
      { id: "doubler" },
    );
    await anvil.store.saveVersion(doubler, { note: "test" });
    const parent = base(
      [
        { id: "input", type: "input", config: {} },
        { id: "one", type: "subagent", config: { agentId: "doubler", input: { n: "{{input.n}}" } } },
        { id: "many", type: "map", config: { items: [1, 2, 3], mode: "agent", agentId: "doubler", agentInput: { n: "{{item}}" } } },
        { id: "output", type: "output", config: { value: { one: "{{nodes.one.output}}", many: "{{nodes.many.output.results}}" } } },
      ],
      [
        { from: "input", to: "one" },
        { from: "input", to: "many" },
        { from: "one", to: "output" },
        { from: "many", to: "output" },
      ],
      { id: "parent" },
    );
    const rec = await anvil.runs.run({ spec: parent }, { n: 21 });
    expect(rec.status).toBe("completed");
    expect(rec.output).toEqual({ one: 42, many: [2, 4, 6] });

    const { validateSpec } = await import("../src/core/validator.js");
    const selfCall = { ...parent, id: "doubler" };
    const v = validateSpec(selfCall, anvil.registry, { getAgent: (id) => anvil.store.getAgent(id) });
    expect(v.diagnostics.some((d) => d.message.includes("cannot call itself"))).toBe(true);
  });

  it("code nodes see skipped branches as output null instead of crashing", async () => {
    const anvil = await anvilWith(new FakeClient(() => "summary"));
    const spec = base(
      [
        { id: "input", type: "input", config: {} },
        { id: "gate", type: "router", config: { rules: [{ port: "yes", when: { left: "{{input.n}}", op: "gt", right: 5 } }], default: "no" } },
        { id: "write", type: "llm", config: { prompt: "p" } },
        { id: "join", type: "code", config: { code: "return { text: nodes.write.output?.text ?? 'skipped' }" } },
        { id: "output", type: "output", config: { value: "{{nodes.join.output.text}}" } },
      ],
      [
        { from: "input", to: "gate" },
        { from: "gate", to: "write", port: "yes" },
        { from: "gate", to: "join", port: "no" },
        { from: "write", to: "join" },
        { from: "join", to: "output" },
      ],
    );
    expect((await anvil.runs.run({ spec }, { n: 1 })).output).toBe("skipped");
    expect((await anvil.runs.run({ spec }, { n: 9 })).output).toBe("summary");
  });
});
