import { describe, expect, it } from "vitest";
import { checkAction, specRules, turnsOf } from "../src/core/actionGate.js";
import { parseToolDefinitions, toolClassDraft } from "../src/core/toolDefs.js";
import type { AgentSpec, Answer, Question } from "../src/core/types.js";
import { validateSpec } from "../src/core/validator.js";
import { createRegistry } from "../src/runtime/anvil.js";
import { anvilWith, defaultAnswer, FakeClient } from "./helpers.js";

const RULE = "Refund at most 100 USD for one order.";

/** The fake Jev: the user confirms when the last user message has "yes", and the rule holds when the amount is at most 100. */
const jev = (id: string, q: Question, state: unknown): Answer => {
  const s = state as { last_user_message?: string | null; arguments?: { amount_usd?: number } };
  if (id === "confirmed") return { type: "noul", noul: /\byes\b/i.test(s.last_user_message ?? "") ? 0.95 : 0.05 };
  // A message that only names an item gives information: "It is the sweater."
  if (id === "only_information") return { type: "noul", noul: /^it is /i.test(s.last_user_message ?? "") ? 0.9 : 0.05 };
  if (id.startsWith("rule_")) return { type: "noul", noul: Number(s.arguments?.amount_usd ?? 0) <= 100 ? 0.95 : 0.05 };
  return defaultAnswer(id, q);
};

const turns = (last: string) => [
  { role: "user", content: "Refund my order A-100." },
  { role: "assistant", content: "The refund is 80 USD. Do you confirm?" },
  { role: "user", content: last },
];

describe("the action gate", () => {
  it("a rule question knows the date of today, and that a confirmation rule is kept by a confirmed action", async () => {
    const client = new FakeClient(undefined, jev);
    const anvil = await anvilWith(client);
    await checkAction(
      anvil.runs.brain,
      {
        action: "take a payment of 60 USD",
        args: { amount_usd: 60 },
        conversation: turns("Yes, I confirm the 60 dollar payment."),
        rules: ["Say the amount and the date and get a clear yes before a payment."],
      },
      0.6,
    );
    const req = client.decisions.at(-1)!;
    expect((req.state as { today?: string }).today).toBe(new Date().toISOString().slice(0, 10));
    expect((req.questions.rule_0 as { instructions: string }).instructions).toMatch(/kept when the last user message confirms this action with its values/);
    expect((req.questions.rule_0 as { instructions: string }).instructions).toMatch(/only records a note or an outcome/);
    expect((req.questions.rule_0 as { instructions: string }).instructions).toMatch(/A range of days .* includes today/);
  });

  it("blocks an action without confirmation or against a rule, and passes a confirmed action that keeps the rules", async () => {
    const client = new FakeClient(undefined, jev);
    const anvil = await anvilWith(client);
    const b = anvil.runs.brain;
    const req = (last: string, amount: number) => ({ action: `refund ${amount} USD`, args: { amount_usd: amount }, conversation: turns(last), rules: [RULE] });

    const unconfirmed = await checkAction(b, req("Why is it only 80?", 80), 0.6);
    expect(unconfirmed).toMatchObject({ allowed: false, confirmed: false, broken: [] });
    expect(unconfirmed.reason).toBe("the user did not confirm this action with these values");

    const tooMuch = await checkAction(b, req("Yes, refund 240.", 240), 0.6);
    expect(tooMuch).toMatchObject({ allowed: false, confirmed: true, broken: [RULE] });
    expect(tooMuch.reason).toBe(`it breaks the rule "${RULE}"`);

    const ok = await checkAction(b, req("Yes, 80 USD is fine.", 80), 0.6);
    expect(ok).toMatchObject({ allowed: true, confirmed: true, broken: [], probabilities: { confirmed: 0.95, only_information: 0.05, rule_0: 0.95 } });
    // The state of the Jev call: the action, the arguments, the last user message, and the turns.
    expect(client.decisions.at(-1)?.state).toMatchObject({ action: "refund 80 USD", arguments: { amount_usd: 80 }, last_user_message: "Yes, 80 USD is fine." });
  });

  it("a message that only gives information is not a confirmation, also with a high confirmation answer", async () => {
    const client = new FakeClient(undefined, (id, q, state) => (id === "confirmed" ? { type: "noul", noul: 0.8 } : jev(id, q, state)));
    const anvil = await anvilWith(client);
    const r = await checkAction(anvil.runs.brain, { action: "return the sweater", args: { amount_usd: 85 }, conversation: turns("It is the sweater, item I1."), rules: [] }, 0.6);
    expect(r).toMatchObject({ allowed: false, confirmed: false, probabilities: { confirmed: 0.8, only_information: 0.9 } });
    expect(Object.keys(client.decisions.at(-1)!.questions)).toEqual(["confirmed", "only_information"]);
  });

  it("asks for no confirmation without turns, and makes no call without rules and turns", async () => {
    const client = new FakeClient(undefined, jev);
    const anvil = await anvilWith(client);
    const r = await checkAction(anvil.runs.brain, { action: "send the report", args: { amount_usd: 0 }, rules: [RULE] }, 0.6);
    expect(r).toMatchObject({ allowed: true, confirmed: null });
    expect(Object.keys(client.decisions.at(-1)!.questions)).toEqual(["rule_0"]);
    const before = client.decisions.length;
    expect(await checkAction(anvil.runs.brain, { action: "send", rules: [] }, 0.6)).toMatchObject({ allowed: true, confirmed: null });
    expect(client.decisions.length).toBe(before);
  });

  it("reads turns and the important rules of a spec", () => {
    expect(
      turnsOf(
        JSON.stringify([
          { role: "user", content: "a" },
          { role: "tool", content: "x" },
          { role: "assistant", content: { k: 1 } },
        ]),
      ),
    ).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: '{"k":1}' },
    ]);
    expect(turnsOf("not json")).toEqual([]);
    const spec = {
      meta: {
        taskSpec: {
          rules: [
            { rule: RULE, important: true },
            { rule: "Be polite.", important: false },
          ],
        },
      },
    } as unknown as AgentSpec;
    expect(specRules(spec)).toEqual([RULE]);
    expect(specRules(undefined)).toEqual([]);
  });
});

/** A conversation agent: a gate before the refund tool, and a reply with the reason on "block". */
async function refundAgent(gated: boolean) {
  const client = new FakeClient(() => "Please confirm the amount.", jev);
  client.config.tools = { ...client.config.tools, adapter: "mock", endpoint: "" };
  const anvil = await anvilWith(client);
  const [refund] = parseToolDefinitions([
    {
      name: "refund_order",
      description: "Refunds an order",
      parameters: { type: "object", properties: { order_id: { type: "string" }, amount_usd: { type: "number" } }, required: ["order_id", "amount_usd"] },
      sideEffects: true,
      mock: "state.refunds = (state.refunds || 0) + 1; return { ok: true, refunds: state.refunds };",
    },
  ]).map(toolClassDraft);
  await anvil.classes.save(refund, { test: false, createdBy: "given" });
  const spec: AgentSpec = {
    specVersion: "anvil/v1",
    id: "refunds",
    name: "refunds",
    description: "",
    version: 1,
    inputSchema: { type: "object", properties: { messages: { type: "array" }, amount: { type: "number" } }, required: ["messages"] },
    nodes: [
      { id: "input", type: "input", config: {} },
      ...(gated
        ? [{ id: "gate", type: "action_gate", config: { action: "refund {{input.amount}} USD for the order A-100", args: { order_id: "A-100", amount_usd: "{{input.amount}}" } } }]
        : []),
      { id: "refund", type: refund.type, config: { order_id: "A-100", amount_usd: "{{input.amount}}" } },
      { id: "ask", type: "llm", config: { prompt: "Tell the user: {{nodes.gate.output.reason}}" } },
      { id: "merge", type: "merge", config: {} },
      { id: "output", type: "output", config: { value: { refund: "{{nodes.refund.output ?? null}}", reply: '{{nodes.ask.output.text ?? "done"}}' } } },
    ],
    edges: gated
      ? [
          { from: "input", to: "gate" },
          { from: "gate", to: "refund", port: "pass" },
          { from: "gate", to: "ask", port: "block" },
          { from: "refund", to: "merge" },
          { from: "ask", to: "merge" },
          { from: "merge", to: "output" },
        ]
      : [
          { from: "input", to: "refund" },
          { from: "refund", to: "merge" },
          { from: "input", to: "ask" },
          { from: "ask", to: "merge" },
          { from: "merge", to: "output" },
        ],
    policy: { maxCostUsd: 1, maxNodeExecutions: 30, timeoutMs: 20_000, requireApprovalForSideEffects: false },
    tests: [],
    meta: { interaction: "conversation", taskSpec: { rules: [{ id: "max_refund", rule: RULE, kind: "must_not", important: true, source: "request" }] } },
  };
  return { anvil, client, spec, refundType: refund.type };
}

describe("the action_gate step", () => {
  it("runs the action on pass, and gives the reason on block", async () => {
    const { anvil, spec } = await refundAgent(true);
    const ok = await anvil.runs.run({ spec }, { messages: turns("Yes, 80 USD is fine."), amount: 80 });
    expect(ok.output).toMatchObject({ refund: { result: { ok: true } }, reply: "done" });
    const noYes = await anvil.runs.run({ spec }, { messages: turns("Hmm, let me think."), amount: 80 });
    expect(noYes.output).toMatchObject({ refund: null, reply: "Please confirm the amount." });
    const tooMuch = await anvil.runs.run({ spec }, { messages: turns("Yes, refund 240."), amount: 240 });
    expect(tooMuch.output).toMatchObject({ refund: null });
    const gate = tooMuch.events.find((e) => e.type === "node.completed" && e.nodeId === "gate") as { output: { reason: string } } | undefined;
    expect(gate?.output.reason).toBe(`it breaks the rule "${RULE}"`);
  });

  it("the compiler rejects an action step without a gate, and an action after the block port", async () => {
    const reg = createRegistry();
    const { spec, refundType, anvil } = await refundAgent(false);
    const codes = (s: AgentSpec) =>
      validateSpec(s, anvil.registry)
        .diagnostics.filter((d) => d.code === "UNGATED_ACTION")
        .map((d) => d.message);
    expect(codes(spec)).toEqual(['"refund" changes something, and a path from the input reaches it without an action_gate step']);
    const gated = (await refundAgent(true)).spec;
    expect(codes(gated)).toEqual([]);
    const wrongPort = {
      ...gated,
      edges: gated.edges.map((e) => (e.from === "gate" && e.to === "refund" ? { ...e, port: "block" } : e.from === "gate" ? { ...e, port: "pass" } : e)),
    };
    expect(codes(wrongPort)).toEqual(['the "block" port of an action gate leads to "refund", which changes something']);
    // An agent without a conversation and without rules needs no gate.
    const plain = { ...spec, inputSchema: { type: "object", properties: { amount: { type: "number" } } }, meta: {} };
    expect(codes(plain)).toEqual([]);
    expect(reg.get("action_gate")?.ports?.({} as never)).toEqual(["pass", "block"]);
    void refundType;
  });

  it("a given tool with side effects inside an agent step goes through the gate", async () => {
    const { anvil, client, refundType } = await refundAgent(true);
    let calls = 0;
    // The model calls the refund tool once, then answers with the tool result.
    (client as unknown as { onChat: (req: { tools?: { function: { name: string } }[]; messages: { role: string; content?: unknown }[] }) => unknown }).onChat = (req) => {
      const last = req.messages.at(-1);
      if (req.tools?.length && last?.role !== "tool" && calls++ === 0)
        return { content: "", toolCalls: [{ id: "c1", type: "function", function: { name: refundType, arguments: '{"order_id":"A-100","amount_usd":80}' } }] };
      return `Tool said: ${String(last?.content ?? "")}`;
    };
    const spec: AgentSpec = {
      specVersion: "anvil/v1",
      id: "agentic",
      name: "agentic",
      description: "",
      version: 1,
      inputSchema: { type: "object", properties: { messages: { type: "array" } }, required: ["messages"] },
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "a", type: "agent", config: { task: "Refund the order.", conversation: "{{input.messages}}", classes: [refundType], style: "plain" } },
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
    const blocked = await anvil.runs.run({ spec }, { messages: turns("Hmm.") });
    expect(String((blocked.output as { reply: string }).reply)).toMatch(/The action gate blocked this call: the user did not confirm/);
    expect(blocked.events.some((e) => e.type === "artifact" && (e.data as { event?: string }).event === "action_blocked")).toBe(true);
    calls = 0;
    const passed = await anvil.runs.run({ spec }, { messages: turns("Yes, 80 USD is fine.") });
    expect(String((passed.output as { reply: string }).reply)).toMatch(/"ok": ?true/);
    // The trace shows each decision of the gate, also a pass.
    expect(passed.events.some((e) => e.type === "log" && e.message.startsWith("action gate: pass"))).toBe(true);
    expect(blocked.events.some((e) => e.type === "log" && e.message.startsWith("action gate: block"))).toBe(true);
  });
});

describe("a class without a confirmation in an agent step", () => {
  it("runs without a yes, still keeps the rules, and must be a class of the step", async () => {
    const { anvil, client, refundType } = await refundAgent(true);
    let calls = 0;
    let amount = 80;
    (client as unknown as { onChat: (req: { tools?: unknown[]; messages: { role: string; content?: unknown }[] }) => unknown }).onChat = (req) => {
      const last = req.messages.at(-1);
      if (req.tools?.length && last?.role !== "tool" && calls++ === 0)
        return { content: "", toolCalls: [{ id: "c1", type: "function", function: { name: refundType, arguments: JSON.stringify({ order_id: "A-100", amount_usd: amount }) } }] };
      return `Tool said: ${String(last?.content ?? "")}`;
    };
    const spec = (noConfirmation: string[]): AgentSpec => ({
      specVersion: "anvil/v1",
      id: "atonce",
      name: "atonce",
      description: "",
      version: 1,
      inputSchema: { type: "object", properties: { messages: { type: "array" } }, required: ["messages"] },
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "a", type: "agent", config: { task: "Refund the order at once.", conversation: "{{input.messages}}", classes: [refundType], noConfirmation, style: "plain" } },
        { id: "output", type: "output", config: { value: { reply: "{{nodes.a.output.answer}}" } } },
      ],
      edges: [
        { from: "input", to: "a" },
        { from: "a", to: "output" },
      ],
      policy: { maxCostUsd: 1, maxNodeExecutions: 30, timeoutMs: 20_000, requireApprovalForSideEffects: false },
      tests: [],
      meta: { interaction: "conversation", taskSpec: { rules: [{ id: "max", rule: RULE, kind: "must_not", important: true, source: "request" }] } },
    });
    // No yes in the last message, but the class needs no confirmation: the refund runs.
    const ran = await anvil.runs.run({ spec: spec([refundType]) }, { messages: turns("Hmm.") });
    expect(String((ran.output as { reply: string }).reply)).toMatch(/"ok": ?true/);
    expect(client.decisions.at(-1)!.questions).not.toHaveProperty("confirmed");
    // The rule still holds: 240 USD is blocked.
    calls = 0;
    amount = 240;
    const blocked = await anvil.runs.run({ spec: spec([refundType]) }, { messages: turns("Hmm.") });
    expect(String((blocked.output as { reply: string }).reply)).toMatch(/blocked this call: it breaks the rule/);
    // Without the list, a confirmation is asked as before.
    calls = 0;
    amount = 80;
    const asked = await anvil.runs.run({ spec: spec([]) }, { messages: turns("Hmm.") });
    expect(String((asked.output as { reply: string }).reply)).toMatch(/the user did not confirm/);
    // The compiler: a class in noConfirmation must be in classes.
    const bad = spec(["x_tool_other_000000"]);
    expect(validateSpec(bad, anvil.registry).diagnostics.some((d) => /noConfirmation names "x_tool_other_000000", which is not in classes/.test(d.message))).toBe(true);
  });
});
