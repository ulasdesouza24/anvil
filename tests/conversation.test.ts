import { describe, expect, it } from "vitest";
import { converseTest, toolCallsOf } from "../src/builder/evaluate.js";
import { conversationTask, deriveAcceptance, type TaskSpec } from "../src/builder/nodes.js";
import { parseToolDefinitions, toolClassDraft } from "../src/core/toolDefs.js";
import type { AgentSpec, TestCase } from "../src/core/types.js";
import type { ChatRequest } from "../src/llm/openrouter.js";
import { converse, FAILED_REPLY, isConversational, replyOf, SessionService } from "../src/runtime/sessions.js";
import { anvilWith, FakeClient } from "./helpers.js";

const book = {
  name: "book_seat",
  description: "Book a seat",
  parameters: { type: "object", properties: { seat: { type: "string" } }, required: ["seat"] },
  mock: "state.booked = state.booked || []; if (state.booked.includes(args.seat)) return { ok: false, reason: 'taken' }; state.booked.push(args.seat); return { ok: true };",
};

/** A conversation agent: one agent step with the turns and the given booking tool. */
function chatSpec(toolType: string): AgentSpec {
  return {
    specVersion: "anvil/v1",
    id: "seat-desk",
    name: "Seat desk",
    description: "Books seats in a conversation.",
    version: 1,
    inputSchema: { type: "object", properties: { messages: { type: "array" }, session_id: { type: "string" } }, required: ["messages"] },
    nodes: [
      { id: "input", type: "input", config: {} },
      { id: "a", type: "agent", config: { task: "Book the seat that the user asks for.", conversation: "{{input.messages}}", classes: [toolType], style: "plain" } },
      { id: "output", type: "output", config: { value: { reply: "{{nodes.a.output.answer}}", done: false } } },
    ],
    edges: [
      { from: "input", to: "a" },
      { from: "a", to: "output" },
    ],
    policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 20_000, requireApprovalForSideEffects: false },
    tests: [],
    meta: { interaction: "conversation" },
  };
}

/** The fake model: the agent books seat 1A with the tool, and gives the tool result as its reply. */
function agentTurn(req: ChatRequest) {
  const last = req.messages.at(-1);
  if (req.tools?.length && last?.role !== "tool") {
    const fn = req.tools.find((t) => t.function.name.startsWith("x_tool_book_seat"))!.function.name;
    return { content: "", toolCalls: [{ id: `c${Math.random()}`, type: "function" as const, function: { name: fn, arguments: '{"seat":"1A"}' } }] };
  }
  return `Result: ${String(last?.content ?? "")}`;
}

/** The setup with the fake client, to read its calls. */
async function setupWithClient() {
  const r = await setup((req) => (String(req.messages[0]?.content ?? "").includes("You play a user") ? JSON.stringify({ message: "", finished: true }) : agentTurn(req)));
  return r;
}

async function setup(onChat: (req: ChatRequest) => string | ReturnType<typeof agentTurn>) {
  const client = new FakeClient(onChat);
  client.config.tools = { ...client.config.tools, adapter: "mock", endpoint: "" };
  const anvil = await anvilWith(client);
  const [d] = parseToolDefinitions([book]).map(toolClassDraft);
  await anvil.classes.save(d, { test: false, createdBy: "given" });
  return { anvil, client, spec: chatSpec(d.type) };
}

describe("conversation task specs", () => {
  const task = (interaction?: "single" | "conversation"): TaskSpec => ({
    name: "Desk",
    agentId: "desk",
    summary: "s",
    goal: "g",
    inputs: [{ name: "question", type: "string", description: "q", required: true }],
    outputs: [{ name: "answer", type: "string", description: "a" }],
    steps: ["x"],
    constraints: [],
    successCriteria: ["The agent asks for the order id.", "The agent confirms before it cancels."],
    assumptions: [],
    clarifyingQuestions: [],
    exampleInputs: [{ question: "Cancel my order" }],
    ...(interaction ? { interaction } : {}),
  });

  it("a conversation task gets the messages input and the reply and done outputs", () => {
    const t = conversationTask(task("conversation"));
    expect(t.inputs.map((i) => [i.name, i.required])).toEqual([
      ["messages", true],
      ["session_id", false],
      ["question", false],
    ]);
    expect(t.outputs.map((o) => o.name)).toEqual(["reply", "done", "answer"]);
    expect(t.exampleInputs).toEqual([{ messages: [{ role: "user", content: "Cancel my order" }] }]);
  });

  it("a task without an interaction stays a single task", () => {
    const t = conversationTask(task());
    expect(t.interaction).toBe("single");
    expect(t.inputs.map((i) => i.name)).toEqual(["question"]);
  });

  it("the acceptance of a turn has no judge rules about the full conversation", () => {
    const spec = { nodes: [{ id: "output", type: "output", config: { value: { reply: "", done: false } } }] } as unknown as AgentSpec;
    const rules = deriveAcceptance(spec, conversationTask(task("conversation")));
    expect(rules.map((r) => r.kind)).toEqual(["check", "check"]);
    expect(deriveAcceptance(spec, { ...task(), outputs: [{ name: "reply" }] }).some((r) => r.kind === "judge")).toBe(true);
  });

  it("a turn of a conversation needs only the reply and done: an end field (an outcome) can be empty in a turn", () => {
    const spec = { nodes: [{ id: "output", type: "output", config: { value: { reply: "", done: false, outcome: "", call_transcript: "" } } }] } as unknown as AgentSpec;
    const t = conversationTask({ ...task("conversation"), outputs: [{ name: "reply" }, { name: "done" }, { name: "outcome" }, { name: "call_transcript" }] } as never);
    expect(deriveAcceptance(spec, t).map((r) => r.id)).toEqual(["has_reply", "has_done"]);
    // A single task still needs each declared field.
    expect(deriveAcceptance(spec, { outputs: [{ name: "outcome" }] }).map((r) => r.id)).toEqual(["has_outcome"]);
  });
});

describe("sessions", () => {
  it("finds the reply in an output, also in a partial result", () => {
    expect(replyOf({ reply: "Hi", done: true })).toEqual({ reply: "Hi", done: true });
    expect(replyOf({ status: "partial", result: { answer: "Part" }, gaps: [] })).toEqual({ reply: "Part", done: false });
    expect(replyOf("plain")).toEqual({ reply: "plain", done: false });
    // A partial result without a result: the user does not see JSON.
    expect(replyOf({ status: "partial", result: null, gaps: ["the output is empty"] })).toEqual({ reply: FAILED_REPLY, done: false });
  });

  it("each message runs the agent with all turns, and the session keeps the state of the tools", async () => {
    const { anvil, client, spec } = await setup(agentTurn);
    expect(isConversational(spec)).toBe(true);
    await anvil.store.saveVersion(spec, { note: "test" });
    const sessions = new SessionService(anvil.store);
    const s = await sessions.create(spec.id, 1);

    const first = await converse({ sessions, runs: anvil.runs }, s.id, "Book seat 1A");
    expect(first.status).toBe("completed");
    expect(first.reply).toMatch(/"ok": ?true/);

    // A second run of the same session: the booking of the first run stays.
    const second = await converse({ sessions, runs: anvil.runs }, s.id, "Book it again");
    expect(second.reply).toContain("taken");
    const saved = await sessions.get(s.id);
    expect(saved?.turns.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // The session keeps the tool calls of a reply, and the next turn gets them as facts.
    expect(saved?.turns[1].toolCalls?.[0]).toMatchObject({ args: { seat: "1A" } });
    expect(String(client.chats.filter((c) => c.tools?.length).at(-1)!.messages[0].content)).toMatch(/TOOL RESULTS OF THE EARLIER TURNS[\s\S]*"seat":"1A"/);

    // The model sees the earlier turns as chat messages.
    const lastAgentCall = client.chats.filter((c) => c.tools?.length).at(-1)!;
    const contents = lastAgentCall.messages.map((m) => m.content);
    expect(contents).toContain("Book seat 1A");
    expect(contents).toContain("Book it again");

    // A new session has its own state.
    const other = await sessions.create(spec.id, 1);
    expect((await converse({ sessions, runs: anvil.runs }, other.id, "Book seat 1A")).reply).toMatch(/"ok": ?true/);
  });
});

describe("conversation tests", () => {
  it("a simulated user talks with the agent, and the result has the transcript and the sum of the costs", async () => {
    let userTurns = 0;
    const simulatorPrompts: string[] = [];
    const { anvil, spec } = await setup((req) => {
      const system = String(req.messages[0]?.content ?? "");
      if (system.includes("You play a user")) {
        simulatorPrompts.push(system);
        userTurns++;
        return JSON.stringify(userTurns === 1 ? { message: "Please try 1A again.", finished: false } : { message: "", finished: true });
      }
      return agentTurn(req);
    });
    const test: TestCase = {
      id: "t1",
      name: "books a seat",
      input: {},
      criteria: ["The agent books the seat."],
      checks: [],
      conversation: { persona: "A traveller", goal: "Book seat 1A", firstMessage: "I want seat 1A", facts: {}, maxTurns: 6 },
    };
    const r = await converseTest(spec, test, { services: anvil.runs.services, brain: anvil.runs.brain });
    expect(r.status).toBe("completed");
    const out = r.output as { transcript: { role: string; content: string }[]; ended?: string; reply: string };
    expect(out.transcript.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(out.transcript[1].content).toMatch(/"ok": ?true/);
    // The second turn uses the same session: the seat is taken.
    expect(out.transcript[3].content).toContain("taken");
    expect(out.ended).toBe("the user ended the conversation");
    // The judge sees the tool calls of each turn.
    expect((out.transcript[1] as { toolCalls?: { tool: string; args: unknown }[] }).toolCalls?.[0]).toMatchObject({
      tool: expect.stringMatching(/^x_tool_book_seat_/),
      args: { seat: "1A" },
    });
    expect(r.usage.costUsd).toBeGreaterThan(0);
    // The simulated user finishes only when every part of the goal is done.
    expect(simulatorPrompts[0]).toMatch(/only when EVERY part of the goal is done/);
  });

  it("a user with an open part of the goal still talks after the agent says done", async () => {
    let userTurns = 0;
    const { anvil, spec } = await setup((req) => {
      const system = String(req.messages[0]?.content ?? "");
      if (system.includes("You play a user")) {
        userTurns++;
        expect(String(req.messages.at(-1)?.content)).toContain("The agent says that the conversation is finished.");
        return JSON.stringify(userTurns === 1 ? { message: "Please book 1A again.", finished: false } : { message: "", finished: true });
      }
      return agentTurn(req);
    });
    const doneSpec = { ...spec, nodes: spec.nodes.map((n) => (n.id === "output" ? { ...n, config: { value: { reply: "{{nodes.a.output.answer}}", done: true } } } : n)) };
    const test: TestCase = {
      id: "t3",
      name: "asks again",
      input: {},
      criteria: [],
      checks: [],
      conversation: { persona: "p", goal: "Book 1A, then ask again", firstMessage: "Book 1A", facts: {}, maxTurns: 6 },
    };
    const r = await converseTest(doneSpec, test, { services: anvil.runs.services, brain: anvil.runs.brain });
    const out = r.output as { transcript: { content: string }[]; ended: string };
    expect(out.transcript).toHaveLength(4);
    expect(out.transcript[3].content).toContain("taken");
    expect(out.ended).toBe("the agent ended the conversation");
  });

  it("without a first message, the simulated user writes it from the goal", async () => {
    const { anvil, spec } = await setup((req) =>
      String(req.messages[0]?.content ?? "").includes("You play a user") ? JSON.stringify({ message: "Hi, can I get seat 1A?", finished: true }) : agentTurn(req),
    );
    const test: TestCase = {
      id: "t4",
      name: "no first message",
      input: {},
      criteria: [],
      checks: [],
      conversation: { persona: "p", goal: "You want seat 1A.", firstMessage: "", facts: {}, maxTurns: 3 },
    };
    const r = await converseTest(spec, test, { services: anvil.runs.services, brain: anvil.runs.brain });
    expect((r.output as { transcript: { role: string; content: string }[] }).transcript[0]).toEqual({ role: "user", content: "Hi, can I get seat 1A?" });
  });

  it("a closing message with a decision gets one more answer of the agent", async () => {
    const { anvil, spec } = await setup((req) =>
      String(req.messages[0]?.content ?? "").includes("You play a user") ? JSON.stringify({ message: "Then I keep my old seat.", finished: true }) : agentTurn(req),
    );
    const test: TestCase = {
      id: "t5",
      name: "closing",
      input: {},
      criteria: [],
      checks: [],
      conversation: { persona: "p", goal: "g", firstMessage: "Book 1A", facts: {}, maxTurns: 4 },
    };
    const r = await converseTest(spec, test, { services: anvil.runs.services, brain: anvil.runs.brain });
    const out = r.output as { transcript: { role: string; content: string }[]; ended: string };
    expect(out.transcript.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(out.transcript[2].content).toBe("Then I keep my old seat.");
    expect(out.ended).toBe("the user ended the conversation");
    // The state fields come from the turn before the closing message: the second answer says "taken", the first one booked.
    expect((r.output as { reply: string }).reply).toMatch(/"ok": ?true/);
    expect(out.transcript[3].content).toContain("taken");
  });

  it("the judge sees the transcript also when the last turn is a partial result", async () => {
    const { anvil, spec } = await setup((req) =>
      String(req.messages[0]?.content ?? "").includes("You play a user") ? JSON.stringify({ message: "", finished: true }) : agentTurn(req),
    );
    const strict = {
      ...spec,
      acceptance: [{ id: "never", kind: "check" as const, check: { path: "missing_field", op: "exists" as const } }],
      policy: { ...spec.policy, harness: { maxAttempts: 1 } },
    };
    const test: TestCase = {
      id: "t6",
      name: "partial",
      input: {},
      criteria: [],
      checks: [],
      conversation: { persona: "p", goal: "g", firstMessage: "Book 1A", facts: {}, maxTurns: 2 },
    };
    const r = await converseTest(strict, test, { services: anvil.runs.services, brain: anvil.runs.brain });
    const out = r.output as { status: string; result: { transcript: unknown[] }; transcript: unknown[] };
    expect(out.status).toBe("partial");
    expect(out.result.transcript).toHaveLength(2);
    expect(out.transcript).toHaveLength(2);
  });

  it("the judge of a conversation knows that a limit holds when the action does not happen, and that a condition needs its user turn", async () => {
    const { evaluateSpec } = await import("../src/builder/evaluate.js");
    const { anvil, spec, client } = await setupWithClient();
    const t: TestCase = {
      id: "t7",
      name: "judge",
      input: {},
      criteria: ["The agent books only after a yes."],
      checks: [],
      conversation: { persona: "p", goal: "g", firstMessage: "Book 1A", facts: {}, maxTurns: 1 },
    };
    await evaluateSpec(spec, [t], { services: anvil.runs.services, brain: anvil.runs.brain });
    const judge = client.decisions.find((d) => d.questions.c0)!;
    const text = String((judge.questions.c0 as { instructions: string }).instructions);
    expect(text).toMatch(/only limits an action \("only after", "never", "does not"\) is met when the action does not happen/);
    expect(text).toMatch(/needs that user turn: without it, the answer is no/);
  });

  it("the conversation stops at maxTurns", async () => {
    const { anvil, spec } = await setup((req) =>
      String(req.messages[0]?.content ?? "").includes("You play a user") ? JSON.stringify({ message: "And again?", finished: false }) : agentTurn(req),
    );
    const test: TestCase = {
      id: "t2",
      name: "loops",
      input: {},
      criteria: [],
      checks: [],
      conversation: { persona: "p", goal: "g", firstMessage: "Seat 1A", facts: {}, maxTurns: 2 },
    };
    const r = await converseTest(spec, test, { services: anvil.runs.services, brain: anvil.runs.brain });
    expect((r.output as { transcript: unknown[] }).transcript).toHaveLength(4);
  });
});

describe("tool calls in the transcript", () => {
  it("has the calls of given tool steps with their arguments, and the calls inside agent steps, in node order", () => {
    const spec = {
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "get", type: "x_tool_get_order_abc123", config: { order_id: "{{x}}" } },
        { id: "a", type: "agent", config: {} },
        { id: "skipped", type: "x_tool_refund_order_def456", config: {} },
      ],
      meta: { givenTools: ["x_tool_get_order_abc123", "x_tool_refund_order_def456"] },
    } as unknown as AgentSpec;
    const calls = toolCallsOf(spec, {
      nodeOutputs: { get: { result: { id: "A-1" } }, a: { answer: "ok", steps: [{ tool: "calculator", args: { e: "1+1" }, result: "2" }] } },
      nodeConfigs: { get: { order_id: "A-1" } },
    });
    expect(calls).toEqual([
      { tool: "x_tool_get_order_abc123", args: { order_id: "A-1" }, result: '{"result":{"id":"A-1"}}' },
      { tool: "calculator", args: { e: "1+1" }, result: "2" },
    ]);
  });
});
