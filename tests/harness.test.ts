import { describe, expect, it } from "vitest";
import { evaluateSpec } from "../src/builder/evaluate.js";
import { capabilityHint, deriveAcceptance } from "../src/builder/nodes.js";
import { ContextManager, contextOptions } from "../src/core/context.js";
import { checkAcceptance, LADDER } from "../src/core/harness.js";
import type { AgentSpec, Answer, Question, RunEvent } from "../src/core/types.js";
import { validateSpec } from "../src/core/validator.js";
import type { ChatMessage, ChatRequest } from "../src/llm/openrouter.js";
import { anvilWith, defaultAnswer, FakeClient } from "./helpers.js";

const base = (nodes: AgentSpec["nodes"], extra: Partial<AgentSpec> = {}): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "h",
  name: "h",
  description: "Finds a price.",
  version: 1,
  inputSchema: { type: "object", properties: {} },
  nodes: [{ id: "input", type: "input", config: {} }, ...nodes, { id: "output", type: "output", config: { value: { price: "{{nodes.a.output.answer}}" } } }],
  edges: [
    { from: "input", to: "a" },
    { from: "a", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 50, timeoutMs: 120_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
  ...extra,
});

const priceAgent = (acceptance: AgentSpec["acceptance"], policy: Partial<AgentSpec["policy"]> = {}) => {
  const s = base([{ id: "a", type: "agent", config: { task: "Find the price of the product." } }], { acceptance });
  s.policy = { ...s.policy, ...policy };
  return s;
};

const hasPrice: AgentSpec["acceptance"] = [{ id: "price", kind: "check", check: { path: "price", op: "matches", value: "^\\d+$" } }];

/** Jev classifies every failure as a blocked source. */
const blocked = (id: string, q: Question, s: unknown): Answer => (id === "failure" && q.type === "choice" ? { type: "choice", choice: "source_blocked", confidence: 0.9, probabilities: {} } : defaultAnswer(id, q));

const sys = (req: ChatRequest) => String(req.messages[0]?.content ?? "");
const toolNames = (req: ChatRequest) => (req.tools ?? []).map((t) => t.function.name);
const harnessEvents = (events: RunEvent[]) => events.filter((e) => e.type === "artifact" && e.kind === "harness").map((e) => (e as { data: { event: string } }).data.event);

describe("acceptance rules", () => {
  it("rejects empty output, empty lists for exists, and judge rules below 0.5", async () => {
    const client = new FakeClient(undefined, (id, q) => (id === "j0" ? { type: "noul", noul: 0.2 } : defaultAnswer(id, q)));
    const anvil = await anvilWith(client);
    const spec = base([], {
      acceptance: [
        { id: "items", kind: "check", check: { path: "items", op: "exists" } },
        { id: "fresh", kind: "judge", criterion: "The data is from today." },
      ],
    });
    expect((await checkAcceptance(spec, {}, null, anvil.runs.brain)).failures.map((f) => f.id)).toContain("output");
    const r = await checkAcceptance(spec, {}, { items: [] }, anvil.runs.brain);
    expect(r.passed).toBe(false);
    expect(r.failures.map((f) => f.id)).toEqual(["items", "fresh"]);
    const a2 = await anvilWith(new FakeClient());
    expect((await checkAcceptance(spec, {}, { items: [1] }, a2.runs.brain)).passed).toBe(true);
  });

  it("the validator reports bad acceptance rules", async () => {
    const anvil = await anvilWith(new FakeClient());
    const spec = priceAgent([
      { id: "x", kind: "check", check: { path: "price", op: "matches", value: "(" } },
      { id: "x", kind: "check", check: { path: "price", op: "equals" } },
    ]);
    const codes = validateSpec(spec, anvil.registry).diagnostics.filter((d) => d.code === "ACCEPTANCE");
    expect(codes.map((d) => d.message)).toEqual([
      'acceptance rule "x": the pattern is not a valid regular expression',
      'acceptance rule "x": duplicate id',
      'acceptance rule "x": the "equals" check needs a value',
    ]);
  });

  it("compose derives the rules from the output fields and the success criteria", () => {
    const spec = priceAgent(undefined);
    const rules = deriveAcceptance(spec, { outputs: [{ name: "price" }], successCriteria: ["The price is in TRY.", "x", "a", "b", "c", "d", "The source is named."] });
    expect(rules[0]).toEqual({ id: "has_price", kind: "check", check: { path: "price", op: "exists" } });
    expect(rules.filter((r) => r.kind === "judge").map((r) => (r as { criterion: string }).criterion)).toEqual(["The price is in TRY.", "The source is named."]);
  });
});

describe("acceptance from the task", () => {
  it("makes exists rules only for the declared outputs, not for extra fields such as error", () => {
    const spec = base([{ id: "a", type: "agent", config: { task: "t" } }]);
    spec.nodes[2].config = { value: { quotes: "{{nodes.a.output.answer}}", error: "{{nodes.a.output.answer}}" } };
    const rules = deriveAcceptance(spec, { outputs: [{ name: "quotes" }, { name: "top_authors" }], successCriteria: [] });
    expect(rules.map((r) => r.id)).toEqual(["has_quotes"]);
    // A single template as the output value: the spec output schema gives the fields.
    spec.nodes[2].config = { value: "{{nodes.a.output}}" };
    spec.outputSchema = { type: "object", properties: { quotes: { type: "array" }, error: { type: "string" } } };
    expect(deriveAcceptance(spec, { outputs: [{ name: "quotes" }] }).map((r) => r.id)).toEqual(["has_quotes"]);
  });
});

describe("harness loop", () => {
  it("is off without acceptance rules: one attempt, no harness record", async () => {
    const client = new FakeClient(() => "unknown");
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: priceAgent(undefined) }, {});
    expect(r.output).toEqual({ price: "unknown" });
    expect(r.harness).toBeUndefined();
    expect(client.chats).toHaveLength(1);
  });

  it("classifies the failure, takes the next strategy of the ladder, and gives its tools and note", async () => {
    const client = new FakeClient((req) => (sys(req).includes("HARNESS NOTE") && toolNames(req).includes("browse") ? "42" : "unknown"), blocked);
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: priceAgent(hasPrice) }, {});
    expect(r.status).toBe("completed");
    expect(r.output).toEqual({ price: "42" });
    expect(r.harness).toMatchObject({ status: "accepted", attempts: 2, strategies: [LADDER.source_blocked[0]] });
    const second = client.chats.at(-1)!;
    expect(sys(second)).toMatch(/Failure class: source_blocked/);
    expect(sys(second)).toMatch(/Unmet: price matches/);
    expect(toolNames(second)).toEqual(expect.arrayContaining(["browse", "recall"]));
    expect(harnessEvents(r.events)).toEqual(["strategy", "accepted"]);
    // The usage covers all attempts.
    expect(r.usage.llmCalls).toBe(2);
  });

  it("stops with an honest partial result after the attempt limit", async () => {
    const client = new FakeClient(() => "unknown", blocked);
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: priceAgent(hasPrice, { harness: { maxAttempts: 3 } }) }, {});
    expect(r.status).toBe("completed");
    expect(r.output).toMatchObject({ status: "partial", result: { price: "unknown" }, attempts: 3, strategies: ["browser", "capture_api"] });
    expect((r.output as { gaps: string[] }).gaps[0]).toMatch(/price matches/);
    expect((r.output as { reason: string }).reason).toMatch(/^source_blocked/);
    expect(r.harness).toMatchObject({ status: "partial", attempts: 3, failureClass: "source_blocked" });
    expect(harnessEvents(r.events)).toEqual(["strategy", "strategy", "partial"]);
  });

  it("accepts an output that explains a problem in the input, and does not try again", async () => {
    const client = new FakeClient(() => "There is no product with this code.", (id, q) =>
      id === "failure" && q.type === "choice" ? { type: "choice", choice: "input_problem", confidence: 0.9, probabilities: {} } : defaultAnswer(id, q),
    );
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: priceAgent(hasPrice) }, {});
    expect(r.output).toEqual({ price: "There is no product with this code." });
    expect(r.harness).toMatchObject({ status: "accepted", attempts: 1, failureClass: "input_problem", strategies: [] });
    expect(client.chats).toHaveLength(1);
  });

  it("the acceptance judge and the classifier get the time of the check and the input", async () => {
    const client = new FakeClient(() => "unknown", blocked);
    const anvil = await anvilWith(client);
    const spec = priceAgent([...hasPrice!, { id: "fresh", kind: "judge", criterion: "The price is from the last 24 hours." }], { harness: { maxAttempts: 1 } });
    await anvil.runs.run({ spec }, { q: "x" });
    const judge = client.decisions.find((d) => d.questions.j0)!;
    // A rule about a case that the input does not have does not apply.
    expect(String((judge.questions.j0 as { instructions: string }).instructions)).toMatch(/the requirement does not apply: answer yes/);
    expect(Date.now() - Date.parse((judge.state as { now: string }).now)).toBeLessThan(60_000);
    const classify = client.decisions.find((d) => d.questions.failure)!;
    expect(classify.state).toMatchObject({ input: { q: "x" } });
    expect(String((classify.questions.failure as { criteria: Record<string, string> }).criteria.input_problem)).toMatch(/filters that no item meets/);
  });

  it("accepts a correct empty result when the sources worked and no item meets the filters", async () => {
    const client = new FakeClient(() => "", (id, q) =>
      id === "failure" && q.type === "choice" ? { type: "choice", choice: "valid_empty", confidence: 0.9, probabilities: {} } : defaultAnswer(id, q),
    );
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: priceAgent(hasPrice) }, {});
    expect(r.harness).toMatchObject({ status: "accepted", attempts: 1, failureClass: "valid_empty", reason: "the sources worked, and no item meets the filters of the input" });
    const classify = client.decisions.find((d) => d.questions.failure)!;
    expect(classify.state).toMatchObject({ source_status: "All tool calls and source requests succeeded. No node failed." });
    expect(Object.keys((classify.questions.failure as { criteria: object }).criteria)).toContain("valid_empty");
  });

  it("classifies the failure also on the last attempt, so a partial result has a reason", async () => {
    const client = new FakeClient(() => "unknown", blocked);
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: priceAgent(hasPrice, { harness: { maxAttempts: 1 } }) }, {});
    expect(r.harness).toMatchObject({ status: "partial", attempts: 1, failureClass: "source_blocked" });
  });

  it("does not retry invalid input", async () => {
    const client = new FakeClient(() => "1");
    const anvil = await anvilWith(client);
    const spec = priceAgent(hasPrice);
    spec.inputSchema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    const r = await anvil.runs.run({ spec }, {});
    expect(r.status).toBe("failed");
    expect(client.chats).toHaveLength(0);
  });

  it("evaluation marks a partial result as failed and gives credit for listed gaps", async () => {
    const client = new FakeClient(() => "unknown", blocked);
    const anvil = await anvilWith(client);
    const spec = priceAgent(hasPrice, { harness: { maxAttempts: 2 } });
    const out = await evaluateSpec(spec, [{ id: "t", name: "t", input: {}, criteria: [], checks: [] }], { services: anvil.runs.services, brain: anvil.runs.brain });
    const t = out.report.results[0];
    expect(t).toMatchObject({ passed: false, partial: true, failureClass: "source_blocked" });
    // No criteria and no checks give 1, so the score is 0.8 * 1 + 0.2 for the gap list.
    expect(t.score).toBe(1);
    expect(capabilityHint([t.failureClass])).toMatch(/CAPABILITY GAP/);
    expect(capabilityHint(["bad_format"])).toBe("");
  });
});

describe("evaluation of a partial result", () => {
  it("applies the checks and the judge to the agent output inside the wrapper", async () => {
    const client = new FakeClient(() => "unknown", blocked);
    const anvil = await anvilWith(client);
    const spec = priceAgent(hasPrice, { harness: { maxAttempts: 1 } });
    const out = await evaluateSpec(spec, [{ id: "t", name: "t", input: {}, criteria: ["The price is a number."], checks: [{ path: "price", op: "equals", value: "unknown" }] }], {
      services: anvil.runs.services,
      brain: anvil.runs.brain,
    });
    const t = out.report.results[0];
    expect(t.partial).toBe(true);
    expect(t.checks[0]).toMatchObject({ passed: true, actual: "unknown" });
    const judge = client.decisions.find((d) => String(d.questions.c0?.instructions ?? "").includes("The price is a number"))!;
    expect(typeof (judge.state as { now?: string }).now).toBe("string");
    expect(judge.state).toMatchObject({ agent_output: { price: "unknown" }, reported_gaps: [expect.stringMatching(/price matches/)] });
  });
});

describe("agent loop guards", () => {
  it("returns the recorded result for a repeated tool call and does not run the tool again", async () => {
    let step = 0;
    const call = (id: string) => ({ id, type: "function" as const, function: { name: "calculator", arguments: JSON.stringify({ expression: "6*7" }) } });
    const client = new FakeClient(() => {
      step++;
      if (step <= 2) return { content: "", toolCalls: [call(`c${step}`)] };
      return "done";
    });
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: base([{ id: "a", type: "agent", config: { task: "t", tools: ["calculator"] } }]) }, {});
    const last = client.chats.at(-1)!.messages.filter((m) => m.role === "tool");
    expect(last[1].content).toMatch(/same arguments at step 1/);
    expect(harnessEvents(r.events)).toEqual(["repeat_blocked"]);
    // The tool ran one time only.
    expect(r.events.filter((e) => e.type === "log" && e.message === "tool calculator")).toHaveLength(1);
  });

  it("sends an answer with empty required fields back to the agent", async () => {
    let step = 0;
    const client = new FakeClient(() => (++step === 1 ? JSON.stringify({ price: null }) : JSON.stringify({ price: 5 })));
    const anvil = await anvilWith(client);
    const spec = base([{ id: "a", type: "agent", config: { task: "t", outputSchema: { type: "object", properties: { price: { type: ["number", "null"] } }, required: ["price"] } } }]);
    const r = await anvil.runs.run({ spec }, {});
    expect(r.output).toEqual({ price: { price: 5 } });
    expect(String(client.chats[1].messages.at(-1)?.content)).toMatch(/required fields are empty: price/);
    expect(harnessEvents(r.events)).toEqual(["give_up_rejected"]);
  });
});

describe("context manager", () => {
  const summarize = async (text: string, level: string) => `${level} summary of ${text.length} chars`;
  const msg = (role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, content, ...extra });

  it("takes the threshold from the config: the lower of the fixed value and 60% of the window", () => {
    const cfg = { contextCompactAt: 200_000, modelContextTokens: 1_048_576, recentTurnShare: 0.4, partCapShare: 0.25 };
    expect(contextOptions(cfg, 8000)).toEqual({ limitTokens: 192_000, recentTokens: 76_800, partCapTokens: 48_000 });
    expect(contextOptions({ ...cfg, modelContextTokens: 100_000 }, 0).limitTokens).toBe(60_000);
  });

  it("puts a detailed summary and a pointer for an oversized part, and recall reads the raw pages", async () => {
    const events: string[] = [];
    const cm = new ContextManager({ limitTokens: 5000, recentTokens: 2000, partCapTokens: 600 }, { summarize, emit: (e) => events.push(e) });
    expect(await cm.addResult(1, "fetch_url", { url: "a" }, "small", "ok")).toBe("small");
    const raw = "x".repeat(4000) + "MARK" + "y".repeat(4000);
    const content = await cm.addResult(2, "fetch_url", { url: "b" }, raw, "ok");
    expect(content).toMatch(/^\[Large result: .* Use recall\(step=2, page=N\)/);
    expect(content).toContain("detailed summary of");
    expect(events).toEqual(["oversized_part", "detailed_summary"]);
    const pages = cm.ledger[1].pages;
    expect(pages).toBeGreaterThan(1);
    const all = Array.from({ length: pages }, (_, i) => cm.recall(2, i + 1).replace(/^\[.*\]\n/, "")).join("");
    expect(all).toBe(raw);
    expect(cm.recall(9)).toMatch(/No ledger entry/);
    expect(cm.ledgerText()).toMatch(/#2 fetch_url\(\{"url":"b"\}\) → ok, \d+ pages/);
    expect(cm.repeated("fetch_url", { url: "a" })).toEqual({ step: 1, text: "small" });
  });

  it("does not change the history below the threshold", async () => {
    const cm = new ContextManager({ limitTokens: 5000, recentTokens: 2000, partCapTokens: 600 }, { summarize });
    const ms = [msg("system", "s"), msg("user", "task"), msg("assistant", "a"), msg("user", "b")];
    expect(await cm.fit(ms)).toBe(ms);
  });

  it("above the threshold keeps the head and the recent turns, and gives a short summary of older turns", async () => {
    const events: string[] = [];
    const cm = new ContextManager({ limitTokens: 1000, recentTokens: 400, partCapTokens: 300 }, { summarize, emit: (e) => events.push(e) });
    const turn = (i: number, size: number): ChatMessage[] => [
      msg("assistant", "", { tool_calls: [{ id: `t${i}`, type: "function", function: { name: "web_search", arguments: `{"q":"${i}"}` } }] }),
      msg("tool", "r".repeat(size), { tool_call_id: `t${i}`, name: "web_search" }),
    ];
    const ms = [msg("system", "SYS"), msg("user", "TASK"), ...turn(1, 1500), ...turn(2, 1500), ...turn(3, 300), msg("user", "go on")];
    const out = await cm.fit(ms);
    expect(out[0].content).toBe("SYS");
    expect(out[1].content).toBe("TASK");
    expect(out[2].content).toMatch(/^CALL LEDGER/);
    expect(out[3].content).toMatch(/^SUMMARY OF EARLIER STEPS/);
    expect(out.slice(4)).toEqual([...turn(3, 300), msg("user", "go on")]);
    expect(events).toEqual(["compaction"]);
    expect(cm.estimate(out)).toBeLessThan(1000);
  });

  it("gives a detailed summary of the newest turn when it alone is larger than the recent share", async () => {
    const events: string[] = [];
    const cm = new ContextManager({ limitTokens: 1000, recentTokens: 300, partCapTokens: 300 }, { summarize, emit: (e) => events.push(e) });
    const ms = [
      msg("system", "SYS"),
      msg("user", "TASK"),
      msg("assistant", "a1"),
      // One turn with two parallel calls: the first result is very large.
      msg("assistant", "", {
        tool_calls: [
          { id: "t1", type: "function", function: { name: "fetch_url", arguments: '{"u":1}' } },
          { id: "t2", type: "function", function: { name: "fetch_url", arguments: '{"u":2}' } },
        ],
      }),
      msg("tool", "z".repeat(6000), { tool_call_id: "t1", name: "fetch_url" }),
      msg("tool", "small result", { tool_call_id: "t2", name: "fetch_url" }),
    ];
    const out = await cm.fit(ms);
    expect(out.map((m) => m.role)).toEqual(["system", "user", "user", "user", "user", "user"]);
    expect(out[3].content).toMatch(/^SUMMARY OF EARLIER STEPS/);
    expect(out[4].content).toMatch(/^DETAILED SUMMARY OF THE LATEST STEPS/);
    // The last tool result lost its assistant call, so it becomes plain text.
    expect(out[5].content).toBe("Latest tool result (fetch_url):\nsmall result");
    expect(events).toEqual(["compaction", "detailed_summary"]);
  });

  it("calibrates the token estimate from real usage", () => {
    const cm = new ContextManager({ limitTokens: 1000, recentTokens: 300, partCapTokens: 300 }, { summarize });
    const ms = [msg("user", "a".repeat(1000))];
    cm.calibrate(ms, 500);
    expect(cm.charsPerToken).toBeLessThan(3.6);
  });
});

describe("acceptance rules that the tests prove wrong", () => {
  it("evolve removes an acceptance rule that rejects outputs which meet every test item, and the smoke test does not stop the other tests", async () => {
    // The agent gives an empty note when the totals match. A derived rule wants a non-empty note.
    const agent: AgentSpec = {
      ...base([{ id: "a", type: "code", config: { code: "return { total: 10, note: '' }" } }]),
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "a", type: "code", config: { code: "return { total: 10, note: '' }" } },
        { id: "output", type: "output", config: { value: { total: "{{nodes.a.output.total}}", note: "{{nodes.a.output.note}}" } } },
      ],
      acceptance: [
        { id: "has_total", kind: "check", check: { path: "total", op: "exists" } },
        { id: "has_note", kind: "check", check: { path: "note", op: "exists" } },
      ],
      policy: { maxCostUsd: 1, maxNodeExecutions: 50, timeoutMs: 120_000, requireApprovalForSideEffects: false, harness: { maxAttempts: 1 } },
    };
    const test = (id: string) => ({ id, name: id, input: {}, criteria: [], checks: [{ path: "total", op: "equals" as const, value: 10 }] });
    const evolver: AgentSpec = {
      ...base([]),
      id: "ev",
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "evolve", type: "anvil_evolve", config: { spec: "{{input.spec}}", tests: [test("t1"), test("t2")], maxRounds: 2 } },
        { id: "output", type: "output", config: { value: "{{nodes.evolve.output}}" } },
      ],
      edges: [
        { from: "input", to: "evolve" },
        { from: "evolve", to: "output" },
      ],
    };
    const anvil = await anvilWith(new FakeClient(() => "x"));
    const r = await anvil.runs.run({ spec: evolver }, { spec: agent });
    const out = r.output as { spec: AgentSpec; evaluation: { passRate: number }; history: { change: string }[] };
    expect(out.evaluation.passRate).toBe(1);
    expect(out.spec.acceptance?.map((a) => a.id)).toEqual(["has_total"]);
    expect(out.history.map((h) => h.change)).toContain("removed 1 wrong acceptance rule(s): has_note");
    // Round 0: the smoke test met every item, so the second test ran too.
    const results = r.events.flatMap((e) => (e.type === "artifact" && e.kind === "testResult" ? [e.data as { round: number; result: { skipped?: string; unmetRules?: string[] } }] : []));
    const round0 = results.filter((d) => d.round === 0).map((d) => d.result);
    expect(round0.map((x) => x.skipped ?? null)).toEqual([null, null]);
    expect(round0[0].unmetRules).toEqual(["has_note"]);
    expect(r.events.some((e) => e.type === "artifact" && e.kind === "acceptanceAdjusted")).toBe(true);
  });
});

describe("critic evidence size", () => {
  it("limits the evidence of the failed tests in the critic prompt, also with many large traces", async () => {
    const big = Array.from({ length: 400 }, (_, i) => ({ clause: `clause ${i} `.repeat(20), risk: "high" }));
    const agent: AgentSpec = {
      ...base([]),
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "a", type: "code", config: { code: `return { items: ${JSON.stringify(big)} }` } },
        { id: "output", type: "output", config: { value: { items: "{{nodes.a.output.items}}" } } },
      ],
    };
    const test = (id: string) => ({ id, name: id, input: {}, criteria: ["The output lists exactly three items."], checks: [] });
    const evolver: AgentSpec = {
      ...base([]),
      id: "ev",
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "evolve", type: "anvil_evolve", config: { spec: "{{input.spec}}", tests: [test("t1"), test("t2"), test("t3")], maxRounds: 1 } },
        { id: "output", type: "output", config: { value: "{{nodes.evolve.output}}" } },
      ],
      edges: [
        { from: "input", to: "evolve" },
        { from: "evolve", to: "output" },
      ],
    };
    const client = new FakeClient(
      (req) => (String(req.messages[0]?.content).includes("agent optimizer") ? JSON.stringify({ diagnosis: "d", changes: [], operations: [] }) : "x"),
      (id, q) => (q.type === "noul" ? { type: "noul", noul: 0.1 } : /^d\d+$/.test(id) && q.type === "choice" ? { type: "choice", choice: "agent", confidence: 0.9, probabilities: { agent: 0.9 } } : defaultAnswer(id, q)),
    );
    Object.assign(client.config, { evalSmokeFirst: false, criticEvidenceChars: 5000 });
    const anvil = await anvilWith(client);
    await anvil.runs.run({ spec: evolver }, { spec: agent });
    const critic = client.chats.find((c) => String(c.messages[0]?.content).includes("agent optimizer"));
    const evidence = String(critic?.messages.at(-1)?.content).split("FAILING TESTS:\n")[1].split("\n\n")[0];
    // Without the limit, three tests with this output give more than 300 000 characters.
    expect(evidence.length).toBeLessThan(5000 * 1.3);
    expect(JSON.parse(evidence)).toHaveLength(3);
  });
});

describe("actions with side effects", () => {
  it("an attempt that changed something does not run again", async () => {
    const http = await import("node:http");
    let posts = 0;
    const server = http.createServer((_req, res) => {
      posts++;
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/book`;
    try {
      const anvil = await anvilWith(new FakeClient());
      const spec: AgentSpec = {
        ...base([{ id: "a", type: "http", config: { method: "POST", url, body: { seat: "1A" } } }]),
        nodes: [
          { id: "input", type: "input", config: {} },
          { id: "a", type: "http", config: { method: "POST", url, body: { seat: "1A" } } },
          { id: "output", type: "output", config: { value: { booked: "{{nodes.a.output.body.ok}}" } } },
        ],
        acceptance: [{ id: "never", kind: "check", check: { path: "missing", op: "exists" } }],
      };
      const r = await anvil.runs.run({ spec }, {});
      expect(posts).toBe(1);
      expect(r.harness).toMatchObject({ status: "partial", attempts: 1 });
      expect((r.output as { gaps: string[] }).gaps.at(-1)).toMatch(/an action with side effects ran \(a\), so the harness does not run the agent again/);
    } finally {
      server.close();
    }
  });
});
