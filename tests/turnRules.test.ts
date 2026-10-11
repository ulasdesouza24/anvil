import { describe, expect, it } from "vitest";
import { CONVERSATION_TOOL_RULES, earlierToolFacts } from "../src/core/nodes/ai.js";
import { parseToolDefinitions, toolClassDraft } from "../src/core/toolDefs.js";
import type { AgentSpec, Answer, Question } from "../src/core/types.js";
import { smokeShowsWorkingAgent, toolCallsOf } from "../src/builder/evaluate.js";
import { IR_GUIDE } from "../src/builder/guide.js";
import { checkAcceptance } from "../src/core/harness.js";
import { anvilWith, defaultAnswer, FakeClient } from "./helpers.js";

/** The fake Jev: every action is confirmed and keeps the rules. */
const jev = (id: string, q: Question): Answer => {
  if (id === "confirmed") return { type: "noul", noul: 0.95 };
  if (id === "only_information") return { type: "noul", noul: 0.05 };
  if (id.startsWith("rule_")) return { type: "noul", noul: 0.95 };
  return defaultAnswer(id, q);
};

type Chat = (req: { tools?: unknown[]; messages: { role: string; content?: unknown }[] }) => unknown;
type Call = { name: string; args: Record<string, unknown> };

/** A conversation agent with a lookup tool (no side effect) and an outcome tool (a side effect). The model makes the given calls in its first step. */
async function agentWith(calls: Call[], conversation = true) {
  const client = new FakeClient(undefined, jev);
  client.config.tools = { ...client.config.tools, adapter: "mock", endpoint: "" };
  const anvil = await anvilWith(client);
  const drafts = parseToolDefinitions([
    {
      name: "verify_person",
      description: "Checks a person",
      parameters: { type: "object", properties: { full_name: { type: "string" }, date_of_birth: { type: "string" } }, required: ["full_name", "date_of_birth"] },
      sideEffects: false,
      mock: "state.checks = (state.checks || 0) + 1; return { verified: args.date_of_birth === '1990-03-12', checks: state.checks };",
    },
    {
      name: "log_outcome",
      description: "Records the end of the call",
      parameters: { type: "object", properties: { outcome: { type: "string" } }, required: ["outcome"] },
      sideEffects: true,
      mock: "state.logs = (state.logs || 0) + 1; return { ok: true, logs: state.logs };",
    },
  ]).map(toolClassDraft);
  for (const d of drafts) await anvil.classes.save(d, { test: false, createdBy: "given" });
  const type = (name: string) => drafts.find((d) => d.type.includes(name))!.type;
  let step = 0;
  const systems: string[] = [];
  (client as unknown as { onChat: Chat }).onChat = (req) => {
    systems.push(String(req.messages[0]?.content ?? ""));
    if (req.tools?.length && step++ === 0)
      return { content: "", toolCalls: calls.map((c, i) => ({ id: `c${i}`, type: "function", function: { name: type(c.name), arguments: JSON.stringify(c.args) } })) };
    return "Thank you. Goodbye.";
  };
  const spec: AgentSpec = {
    specVersion: "anvil/v1",
    id: "caller",
    name: "caller",
    description: "",
    version: 1,
    inputSchema: { type: "object", properties: { messages: { type: "array" } } },
    nodes: [
      { id: "input", type: "input", config: {} },
      {
        id: "a",
        type: "agent",
        config: {
          task: "Call the customer.",
          ...(conversation ? { conversation: "{{input.messages}}" } : {}),
          classes: [type("verify_person"), type("log_outcome")],
          style: "plain",
        },
      },
      { id: "output", type: "output", config: { value: { reply: "{{nodes.a.output.answer}}" } } },
    ],
    edges: [
      { from: "input", to: "a" },
      { from: "a", to: "output" },
    ],
    policy: { maxCostUsd: 1, maxNodeExecutions: 30, timeoutMs: 20_000, requireApprovalForSideEffects: false },
    tests: [],
    meta: conversation ? { interaction: "conversation" } : {},
  };
  const run = await anvil.runs.run({ spec }, { messages: [{ role: "user", content: "Hello? Yes, this is Maria Lopez." }] });
  const steps = (run.events.find((e) => e.type === "node.completed" && e.nodeId === "a") as { output: { steps: { tool: string; result: string; rejected?: boolean }[] } }).output
    .steps;
  const nodeOutputs = Object.fromEntries(run.events.filter((e) => e.type === "node.completed").map((e) => [(e as { nodeId: string }).nodeId, (e as { output: unknown }).output]));
  return { run, steps, systems, calls: toolCallsOf(spec, { nodeOutputs, nodeConfigs: {} }) };
}

describe("tool rules of a conversation turn", () => {
  it("does not run a call with an empty required argument, tells the agent to ask, and keeps it out of the evaluated calls", async () => {
    const { steps, calls } = await agentWith([{ name: "verify_person", args: { full_name: "Maria Lopez", date_of_birth: "" } }]);
    expect(steps[0].rejected).toBe(true);
    expect(steps[0].result).toMatch(/Not run: date_of_birth is empty.*Ask the user for it/);
    expect(calls).toEqual([]);
  });

  it("runs one action of a tool in a turn and rejects the second", async () => {
    const { steps, calls } = await agentWith([
      { name: "log_outcome", args: { outcome: "wrong_person" } },
      { name: "log_outcome", args: { outcome: "failed_verification" } },
    ]);
    expect(steps[0].result).toMatch(/"logs": ?1/);
    expect(steps[1].rejected).toBe(true);
    expect(steps[1].result).toMatch(/already done in this turn/);
    expect(calls.map((c) => c.args)).toEqual([{ outcome: "wrong_person" }]);
  });

  it("does not limit the actions of an agent that works alone", async () => {
    const { steps } = await agentWith(
      [
        { name: "log_outcome", args: { outcome: "a" } },
        { name: "log_outcome", args: { outcome: "b" } },
      ],
      false,
    );
    expect(steps.map((s) => s.rejected ?? false)).toEqual([false, false]);
  });

  it("gives the tool rules to each conversation agent", async () => {
    const { systems } = await agentWith([]);
    expect(systems[0]).toContain(CONVERSATION_TOOL_RULES);
    expect(CONVERSATION_TOOL_RULES).toMatch(/do not ask for other data/);
  });
});

describe("the smoke gate", () => {
  const conversation = { persona: "p", goal: "g", firstMessage: "Hello?", facts: {}, maxTurns: 4 };
  it("runs the other tests after a low-score conversation that ran, and stops them after a failed run", () => {
    expect(smokeShowsWorkingAgent({ score: 0.49 }, { conversation }, 0.5)).toBe(true);
    expect(smokeShowsWorkingAgent({ score: 0.49 }, {}, 0.5)).toBe(false);
    expect(smokeShowsWorkingAgent({ score: 0.49, error: "the agent run failed" }, { conversation }, 0.5)).toBe(false);
    expect(smokeShowsWorkingAgent({ score: 0.8 }, {}, 0.5)).toBe(true);
  });
});

describe("the tool results of earlier turns", () => {
  const turns = [
    { role: "user", content: "Hi, this is Maria Lopez, 1990-03-12." },
    {
      role: "assistant",
      content: "You are verified.",
      toolCalls: [{ tool: "verify_identity", args: { full_name: "Maria Lopez" }, result: '{"verified":true,"account_id":"A-1001"}' }],
    },
    { role: "user", content: "Take 140 dollars." },
  ];
  it("lists the calls of the earlier turns with their ids", () => {
    const text = earlierToolFacts(turns);
    expect(text).toContain("TOOL RESULTS OF THE EARLIER TURNS");
    expect(text).toContain('verify_identity {"full_name":"Maria Lopez"} -> {"verified":true,"account_id":"A-1001"}');
    expect(earlierToolFacts(JSON.stringify(turns))).toBe(text);
    expect(earlierToolFacts([{ role: "user", content: "x" }])).toBe("");
  });
  it("keeps the newest calls when the list is too long", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ role: "assistant", content: "", toolCalls: [{ tool: "lookup", args: { n: i }, result: "x".repeat(100) }] }));
    const text = earlierToolFacts(many, 1000);
    expect(text).toContain('{"n":49}');
    expect(text).not.toContain('{"n":0}');
  });
});

describe("rules about actions that did not happen", () => {
  it("the acceptance judge meets a limit when the output does not do the action", async () => {
    const client = new FakeClient();
    const anvil = await anvilWith(client);
    const spec = {
      acceptance: [{ id: "rule_window", kind: "judge", criterion: 'The output keeps this rule: "A promise to pay is at most 14 days away."' }],
    } as unknown as AgentSpec;
    await checkAcceptance(spec, {}, { reply: "Your 6-month plan is set up." }, anvil.runs.brain);
    const q = Object.values(client.decisions.at(-1)!.questions)[0] as { instructions: string };
    expect(q.instructions).toMatch(/limits an action .* is met when the output does not do that action/);
  });

  it("the turn rules forbid a claimed action without a tool call, and a request for a confirmation without the values", () => {
    expect(CONVERSATION_TOOL_RULES).toMatch(/Never say that an action is done .* when no tool call of this conversation did it/);
    expect(CONVERSATION_TOOL_RULES).toMatch(/say its exact values .* in the same message/);
  });

  it("the builder guide does not treat a request to stop as a closing", () => {
    expect(IR_GUIDE).toMatch(/A request to stop, cancel, opt out, or "do not call me again" is NOT a closing/);
  });
});

describe("the rules of a conversation agent", () => {
  it("a turn does not go to a rule judge, but a single task does", async () => {
    const client = new FakeClient();
    const anvil = await anvilWith(client);
    const acceptance = [{ id: "rule_two_checks", kind: "judge", criterion: 'The output keeps this rule: "After 2 failed checks, end the call."' }];
    const before = client.decisions.length;
    const chat = await checkAcceptance({ acceptance, meta: { interaction: "conversation" } } as unknown as AgentSpec, {}, { reply: "Your promise is recorded." }, anvil.runs.brain);
    expect(chat.passed).toBe(true);
    expect(client.decisions.length).toBe(before);
    await checkAcceptance({ acceptance, meta: {} } as unknown as AgentSpec, {}, { reply: "x" }, anvil.runs.brain);
    expect(client.decisions.length).toBe(before + 1);
  });
});

describe("a reply that says an action is done without a tool call", () => {
  it("goes back to the agent one time, and the agent calls the tool", async () => {
    let claims = 0;
    const client = new FakeClient(undefined, (id, q) => {
      if (id === "claims_action") return { type: "noul", noul: claims++ === 0 ? 0.95 : 0.1 };
      return jev(id, q);
    });
    client.config.tools = { ...client.config.tools, adapter: "mock", endpoint: "" };
    const anvil = await anvilWith(client);
    const [draft] = parseToolDefinitions([
      {
        name: "log_outcome",
        description: "Records the end of the call",
        parameters: { type: "object", properties: { outcome: { type: "string" } }, required: ["outcome"] },
        sideEffects: true,
        mock: "return { ok: true };",
      },
    ]).map(toolClassDraft);
    await anvil.classes.save(draft, { test: false, createdBy: "given" });
    let sawCheck = false;
    (client as unknown as { onChat: Chat }).onChat = (req) => {
      const lastMsg = String(req.messages.at(-1)?.content ?? "");
      if (lastMsg.startsWith("HARNESS CHECK")) {
        sawCheck = true;
        return { content: "", toolCalls: [{ id: "c1", type: "function", function: { name: draft.type, arguments: '{"outcome":"do_not_call"}' } }] };
      }
      if (req.messages.at(-1)?.role === "tool") return "Your request is recorded. Goodbye.";
      return "Your request is recorded. Goodbye.";
    };
    const spec: AgentSpec = {
      specVersion: "anvil/v1",
      id: "claimer",
      name: "claimer",
      description: "",
      version: 1,
      inputSchema: { type: "object", properties: { messages: { type: "array" } } },
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "a", type: "agent", config: { task: "Handle the call.", conversation: "{{input.messages}}", classes: [draft.type], noConfirmation: [draft.type], style: "plain" } },
        { id: "output", type: "output", config: { value: { reply: "{{nodes.a.output.answer}}" } } },
      ],
      edges: [
        { from: "input", to: "a" },
        { from: "a", to: "output" },
      ],
      policy: { maxCostUsd: 1, maxNodeExecutions: 30, timeoutMs: 20_000, requireApprovalForSideEffects: false },
      tests: [],
      meta: { interaction: "conversation" },
    };
    const run = await anvil.runs.run({ spec }, { messages: [{ role: "user", content: "Stop calling me." }] });
    expect(sawCheck).toBe(true);
    const steps = (run.events.find((e) => e.type === "node.completed" && e.nodeId === "a") as { output: { steps: { tool: string; result: string }[] } }).output.steps;
    expect(steps.map((s) => s.tool)).toEqual([draft.type]);
    expect(run.events.some((e) => e.type === "artifact" && (e.data as { event?: string }).event === "action_claim_without_call")).toBe(true);
  });
});
