import { describe, expect, it } from "vitest";
import { deriveAcceptance, ruleAcceptance, rulesPrompt, withRuleAcceptance, type TaskRule } from "../src/builder/nodes.js";
import { LADDER, RULE_PREFIX } from "../src/core/harness.js";
import type { AgentSpec } from "../src/core/types.js";
import type { ChatRequest } from "../src/llm/openrouter.js";
import { anvilWith, defaultAnswer, FakeClient } from "./helpers.js";

const rules: TaskRule[] = [
  { id: "max_refund", rule: "Refund at most 100 USD for one order.", kind: "must_not", important: true, source: "refund-policy.pdf" },
  { id: "old_orders", rule: "Do not refund an order that is older than 30 days.", kind: "must_not", important: true, source: "refund-policy.pdf" },
  { id: "polite", rule: "Use a polite tone.", kind: "must", important: false, source: "request" },
];

const spec = (acceptance: AgentSpec["acceptance"]): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "refund",
  name: "Refund desk",
  description: "Gives refunds by the policy.",
  version: 1,
  inputSchema: { type: "object", properties: { request: { type: "string" } } },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "a", type: "llm", config: { prompt: "Answer the refund request: {{input.request}}" } },
    { id: "output", type: "output", config: { value: { answer: "{{nodes.a.output.text}}" } } },
  ],
  edges: [
    { from: "input", to: "a" },
    { from: "a", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 50, timeoutMs: 60_000, requireApprovalForSideEffects: false },
  tests: [],
  acceptance,
  meta: {},
});

const sys = (req: ChatRequest) => req.messages.map((m) => String(m.content ?? "")).join("\n");

describe("rules from a policy", () => {
  it("each important rule becomes a judge acceptance rule with the rule prefix", () => {
    const acc = ruleAcceptance({ rules });
    expect(acc.map((r) => r.id)).toEqual([`${RULE_PREFIX}max_refund`, `${RULE_PREFIX}old_orders`]);
    expect(acc[0]).toMatchObject({ kind: "judge", criterion: expect.stringContaining("Refund at most 100 USD") });
    expect(ruleAcceptance({ rules }, 1)).toHaveLength(1);
    expect(ruleAcceptance({})).toEqual([]);
  });

  it("the derived acceptance has the rules, also for a conversation agent", () => {
    const s = spec(undefined);
    const single = deriveAcceptance(s, { outputs: [{ name: "answer" }], successCriteria: ["The answer says if the refund is given."], rules });
    expect(single.map((r) => r.id)).toEqual(["has_answer", "criterion_1", "rule_max_refund", "rule_old_orders"]);
    const chat = deriveAcceptance(s, { outputs: [{ name: "answer" }], successCriteria: ["The answer says if the refund is given."], rules, interaction: "conversation" });
    // A conversation keeps its rules with the action gate, not with a judge of one turn.
    expect(chat.map((r) => r.id)).toEqual(["has_answer"]);
  });

  it("an optional output field gets no exists rule", () => {
    const s = spec(undefined);
    s.nodes[2] = { id: "output", type: "output", config: { value: { status: "x", carrier: "y" } } };
    const acc = deriveAcceptance(s, { outputs: [{ name: "status" }, { name: "carrier", optional: true }] });
    expect(acc.map((r) => r.id)).toEqual(["has_status"]);
  });

  it("adds the rules to a rule set from the model, without duplicates", () => {
    const acc = withRuleAcceptance([{ id: "rule_max_refund", kind: "judge", criterion: "Refund at most 100 USD." }], { rules });
    expect(acc.map((r) => r.id)).toEqual(["rule_max_refund", "rule_old_orders"]);
  });

  it("the prompts state the rules, and the critic sees a rule violation as its own failure", () => {
    expect(rulesPrompt({ rules }, "design")).toMatch(/max_refund \[MUST NOT, important\]: Refund at most 100 USD/);
    expect(rulesPrompt({ rules }, "design")).toMatch(/refuses it and gives the rule as the reason/);
    expect(rulesPrompt({ rules }, "critic")).toMatch(/RULE VIOLATION is its own failure/);
    expect(rulesPrompt({ rules: [] }, "design")).toBe("");
  });
});

describe("the harness and rules", () => {
  it("a broken rule is a rule violation without a classifier call, and the next attempt gets the keep_rules strategy", async () => {
    const client = new FakeClient(
      (req) => (sys(req).includes("Failure class: rule_violation") ? "I can refund 100 USD, the most that the policy permits." : "I refund 450 USD."),
      (id, q, state) => (id === "j0" ? { type: "noul", noul: /450/.test(JSON.stringify((state as { output?: unknown }).output)) ? 0.05 : 0.95 } : defaultAnswer(id, q)),
    );
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: spec(ruleAcceptance({ rules: rules.slice(0, 1) })) }, { request: "Refund my 450 USD order." });
    expect(r.harness).toMatchObject({ status: "accepted", attempts: 2, strategies: [LADDER.rule_violation[0]] });
    expect(LADDER.rule_violation[0]).toBe("keep_rules");
    expect(r.output).toEqual({ answer: "I can refund 100 USD, the most that the policy permits." });
    // No classifier call: the id of the unmet rule gives the class.
    expect(client.decisions.some((d) => "failure" in d.questions)).toBe(false);
  });

  it("accepts a refusal that a rule asks for, and does not try again", async () => {
    const client = new FakeClient(
      () => "I cannot refund this order: the policy refunds only orders that are less than 30 days old.",
      (id, q) => (id === "failure" && q.type === "choice" ? { type: "choice", choice: "rule_refusal", confidence: 0.9, probabilities: {} } : defaultAnswer(id, q)),
    );
    const anvil = await anvilWith(client);
    const acc: AgentSpec["acceptance"] = [{ id: "amount", kind: "check", check: { path: "answer", op: "matches", value: "\\d+ USD" } }];
    const r = await anvil.runs.run({ spec: spec(acc) }, { request: "Refund my order from last year." });
    expect(r.harness).toMatchObject({ status: "accepted", attempts: 1, failureClass: "rule_refusal" });
    expect(client.chats).toHaveLength(1);
  });
});
