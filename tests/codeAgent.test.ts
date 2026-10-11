import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { emptyResult, extractPython, splitTask, toolSignatures, wrapBareRefs } from "../src/core/nodes/codeAgent.js";
import { autoFix } from "../src/builder/autofix.js";
import { AGENT_TOOLS } from "../src/core/tools/agentTools.js";
import { LADDER } from "../src/core/harness.js";
import type { AgentSpec, Answer, Question } from "../src/core/types.js";
import type { ChatRequest } from "../src/llm/openrouter.js";
import { createAnvil } from "../src/runtime/anvil.js";
import { anvilWith, defaultAnswer, FakeClient } from "./helpers.js";

const image = spawnSync("docker", ["image", "inspect", "anvil-sandbox:py312"], { stdio: "ignore" }).status === 0;

const spec = (node: AgentSpec["nodes"][number], policy: Partial<AgentSpec["policy"]> = {}): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "c",
  name: "c",
  description: "",
  version: 1,
  inputSchema: { type: "object", properties: {} },
  nodes: [{ id: "input", type: "input", config: {} }, node, { id: "output", type: "output", config: { value: `{{nodes.${node.id}.output}}` } }],
  edges: [
    { from: "input", to: node.id },
    { from: node.id, to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 120_000, requireApprovalForSideEffects: false, ...policy },
  tests: [],
  meta: {},
});

const py = (code: string) => "```python\n" + code + "\n```";

describe("empty program results", () => {
  it("finds a result without data", () => {
    for (const v of [null, [], {}, { stocks: [] }, { a: null, b: "" }]) expect(emptyResult(v)).toBe(true);
    for (const v of [0, false, [1], { stocks: [{ s: "A" }] }, { n: 0 }]) expect(emptyResult(v)).toBe(false);
  });
});

describe("data paths in plain text", () => {
  it("makes a plain data path a template, and keeps text in templates and the end of a sentence", () => {
    const r = wrapBareRefs("The rates are in nodes.fetch.output.rates. The base is {{nodes.v.output.base}}. See nodes.other.output.", () => true);
    expect(r.text).toBe("The rates are in {{nodes.fetch.output.rates}}. The base is {{nodes.v.output.base}}. See {{nodes.other.output}}.");
    expect(r.wrapped).toEqual(["nodes.fetch.output.rates", "nodes.other.output"]);
    expect(wrapBareRefs("in nodes.x.output.a", (_p, id) => id !== "x").text).toBe("in nodes.x.output.a");
  });

  it("gives the data of a plain path to the program as DATA, and leaves an unknown path as text", () => {
    const values: Record<string, unknown> = { "{{nodes.fetch.output.rates}}": [{ date: "2026-10-01", rate: 0.88 }] };
    const { prompt, data } = splitTask("The rates are in nodes.fetch.output.rates. Ignore nodes.gone.output.x.", (t) => values[t]);
    expect(data).toEqual({ d0: [{ date: "2026-10-01", rate: 0.88 }] });
    expect(prompt).toContain('The rates are in DATA["d0"]');
    expect(prompt).toContain("Ignore nodes.gone.output.x.");
  });

  it("the compiler autofix makes the plain data paths of a code_agent task into templates, only for nodes of the spec", () => {
    const { spec, fixes } = autoFix({
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "fetch", type: "http", config: { url: "https://x.test" } },
        { id: "calc", type: "code_agent", config: { task: "Average the rates in nodes.fetch.output.body.rates and in nodes.ghost.output.x." } },
      ],
      edges: [],
    });
    expect((spec as { nodes: { config: { task?: string } }[] }).nodes[2].config.task).toBe("Average the rates in {{nodes.fetch.output.body.rates}} and in nodes.ghost.output.x.");
    expect(fixes.join(" ")).toContain("made the data paths of calc into templates: nodes.fetch.output.body.rates");
  });
});

describe("code agent helpers", () => {
  it("takes the program from a fenced block, or the whole reply", () => {
    expect(extractPython("Here:\n```python\nx = 1\n```\nDone.")).toBe("x = 1");
    expect(extractPython("x = 2")).toBe("x = 2");
  });

  it("gives the model the arguments and the return shape of each tool", () => {
    expect(AGENT_TOOLS.every((t) => t.returns.length > 0)).toBe(true);
    expect(toolSignatures(["http_request", "fetch_url"])).toBe(
      "  - tools.http_request(method, url, headers?, body?) returns {status, body}. body is the parsed JSON, or the text when the answer is not JSON\n  - tools.fetch_url(url, maxChars?) returns {url, status, title, text, truncated}. In text, each table row is one line with the cells between |, after a header line",
    );
    expect(toolSignatures([])).toBe("  (none)");
  });

  it("puts small template values into the task, and gives large values to the program as DATA", () => {
    const big = Array.from({ length: 500 }, (_, i) => ({ date: `d${i}`, rate: i }));
    const values: Record<string, unknown> = { "{{input.base}}": "EUR", "{{nodes.fetch.output.rates}}": big };
    const r = splitTask("Base {{input.base}}. Rates: {{nodes.fetch.output.rates}}. Find the maximum.", (t) => values[t]);
    expect(r.prompt).toBe(`Base EUR. Rates: DATA["d0"] (a list of 500 items. First item: {"date":"d0","rate":0}). Find the maximum.`);
    expect(r.data).toEqual({ d0: big });
  });

  it("always gives structured values to the program as parsed DATA, also small ones and JSON text", () => {
    const small = { rates: { "2026-09-01": { USD: 1.16 } } };
    const values: Record<string, unknown> = { "{{a}}": small, "{{b | json}}": JSON.stringify(small), "{{c}}": "plain text" };
    const r = splitTask("A: {{a}} B: {{b | json}} C: {{c}}", (t) => values[t]);
    expect(r.prompt).toBe(`A: DATA["d0"] (its content: ${JSON.stringify(small)}) B: DATA["d1"] (its content: ${JSON.stringify(small)}) C: plain text`);
    expect(r.data).toEqual({ d0: small, d1: small });
  });

  it("the harness ladder has the write_code strategy", () => {
    expect(LADDER.no_data).toContain("write_code");
    expect(LADDER.bad_format).toContain("write_code");
  });
});

describe.skipIf(!image)("code agent and run_code (real Docker)", () => {
  it("an agent runs a program with run_code, and the program calls the other tools of the agent", async () => {
    let step = 0;
    const client = new FakeClient((req: ChatRequest) => {
      step++;
      if (step === 1)
        return {
          content: "",
          toolCalls: [{ id: "t1", type: "function", function: { name: "run_code", arguments: JSON.stringify({ code: 'from anvil import tools, result\nresult(tools.calculator(expression="6*7")["result"])' }) } }],
        };
      const tool = JSON.parse(String(req.messages.find((m) => m.role === "tool")?.content));
      return `answer ${tool.result}`;
    });
    const anvil = await anvilWith(client);
    try {
      const r = await anvil.runs.run({ spec: spec({ id: "a", type: "agent", config: { task: "Compute 6*7", tools: ["run_code", "calculator"] } }) }, {});
      expect((r.output as { answer: string }).answer).toBe("answer 42");
      expect(r.usage.sandboxMs).toBeGreaterThan(0);
    } finally {
      await anvil.sandbox.dispose();
    }
  }, 120_000);

  it("the code agent fixes a failed program with the error, and returns only the result", async () => {
    let n = 0;
    const feedback: string[] = [];
    const client = new FakeClient((req: ChatRequest) => {
      n++;
      if (n > 1) feedback.push(String(req.messages.at(-1)?.content));
      if (n === 1) return py("from anvil import result\nresult({'n': 1 / 0})");
      if (n === 2) return py("from anvil import result\nresult({'n': 'three'})");
      return py("import pandas as pd\nfrom anvil import result\nresult({'n': int(pd.Series([1, 2]).sum())})");
    });
    const anvil = await anvilWith(client);
    try {
      const r = await anvil.runs.run(
        { spec: spec({ id: "p", type: "code_agent", config: { task: "Count the items.", outputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } } }) },
        {},
      );
      expect(r.error).toBeUndefined();
      expect(r.status).toBe("completed");
      expect(r.output).toMatchObject({ result: { n: 3 }, attempts: 3 });
      expect(r.events.filter((e) => e.type === "artifact" && e.kind === "code")).toHaveLength(3);
      // The model gets the error of each failed program.
      expect(feedback[0]).toMatch(/^The program failed:\n[\s\S]*ZeroDivisionError/);
      expect(feedback[1]).toMatch(/^The program failed:\n.*n.*number/);
    } finally {
      await anvil.sandbox.dispose();
    }
  }, 180_000);

  it("keeps a working program and runs it again for the next input without a model call, and fixes it when it fails", async () => {
    let n = 0;
    const prompts: string[] = [];
    const client = new FakeClient((req: ChatRequest) => {
      n++;
      prompts.push(String(req.messages.at(-1)?.content));
      // The first program cannot read a value that is not a number. The fixed one can.
      if (n === 1) return py("from anvil import result\nresult({'double': int(DATA['d0']) * 2})");
      return py("from anvil import result\nv = DATA['d0']\nresult({'double': int(v) * 2 if str(v).isdigit() else None})");
    });
    const anvil = await anvilWith(client);
    try {
      const s = spec({ id: "p", type: "code_agent", config: { task: "Double the value {{input.v}}." } });
      s.inputSchema = { type: "object", properties: { v: { type: "string" } } };
      const first = await anvil.runs.run({ spec: s }, { v: "4" });
      expect(first.output).toMatchObject({ result: { double: 8 }, attempts: 1, cached: false });
      // A small value goes to DATA too: a kept program must read it, not copy it.
      expect(prompts[0]).toContain('DATA["d0"] (its content: "4")');
      const second = await anvil.runs.run({ spec: s }, { v: "21" });
      expect(second.output).toMatchObject({ result: { double: 42 }, attempts: 0, cached: true });
      expect(n).toBe(1);
      const third = await anvil.runs.run({ spec: s }, { v: "x" });
      expect(third.output).toMatchObject({ result: { double: null }, cached: false });
      expect(prompts[1]).toMatch(/^This program worked for earlier inputs, but it failed for this input:/);
      // The fixed program is the kept one now.
      const fourth = await anvil.runs.run({ spec: s }, { v: "5" });
      expect(fourth.output).toMatchObject({ result: { double: 10 }, cached: true });
      expect(n).toBe(2);
    } finally {
      await anvil.sandbox.dispose();
    }
  }, 180_000);

  it("the program reads large data from DATA, and the prompt has only its shape", async () => {
    const values = Array.from({ length: 2000 }, (_, i) => i);
    const client = new FakeClient(() => py("from anvil import result\nresult({'n': len(DATA['d0']), 'sum': sum(DATA['d0'])})"));
    const anvil = await anvilWith(client);
    try {
      const s = spec({ id: "p", type: "code_agent", config: { task: "Sum these values: {{input.values}}" } });
      s.inputSchema = { type: "object", properties: { values: { type: "array", items: { type: "number" } } } };
      const r = await anvil.runs.run({ spec: s }, { values });
      expect(r.output).toMatchObject({ result: { n: 2000, sum: 1999000 }, attempts: 1 });
      const prompt = String(client.chats[0].messages.at(-1)?.content);
      expect(prompt).toContain('DATA["d0"] (a list of 2000 items. First item: 0)');
      expect(prompt.length).toBeLessThan(600);
    } finally {
      await anvil.sandbox.dispose();
    }
  }, 120_000);

  it("tells the model when the token limit cut its program", async () => {
    let n = 0;
    const client = new FakeClient(() => (++n === 1 ? { content: py("x = [1, 2,"), finishReason: "length" } : py("from anvil import result\nresult(1)")));
    const anvil = await anvilWith(client);
    try {
      const r = await anvil.runs.run({ spec: spec({ id: "p", type: "code_agent", config: { task: "Return 1." } }) }, {});
      expect(r.output).toMatchObject({ result: 1, attempts: 2 });
      expect(String(client.chats[1].messages.at(-1)?.content)).toMatch(/^The program failed:\nYour reply was too long and the token limit cut it/);
    } finally {
      await anvil.sandbox.dispose();
    }
  }, 120_000);

  it("stops at the sandbox time budget of the run", async () => {
    const client = new FakeClient(() => py("import time\ntime.sleep(5)"));
    const anvil = await anvilWith(client);
    try {
      const r = await anvil.runs.run({ spec: spec({ id: "p", type: "code_agent", config: { task: "Wait.", maxAttempts: 3 } }, { sandbox: { maxSeconds: 1 } }) }, {});
      expect(r.status).toBe("failed");
      expect(r.error).toMatch(/The sandbox time budget of this run is used \(1 s\)/);
    } finally {
      await anvil.sandbox.dispose();
    }
  }, 120_000);
});

describe("write_code strategy and the sandbox switch", () => {
  const priceAgent: AgentSpec = {
    ...spec({ id: "a", type: "agent", config: { task: "Find the price." } }),
    nodes: [
      { id: "input", type: "input", config: {} },
      { id: "a", type: "agent", config: { task: "Find the price." } },
      { id: "output", type: "output", config: { value: { price: "{{nodes.a.output.answer}}" } } },
    ],
    acceptance: [{ id: "price", kind: "check", check: { path: "price", op: "matches", value: "^\\d+$" } }],
    policy: { maxCostUsd: 1, maxNodeExecutions: 50, timeoutMs: 120_000, requireApprovalForSideEffects: false, harness: { maxAttempts: 4 } },
  };
  const noData = (id: string, q: Question): Answer => (id === "failure" && q.type === "choice" ? { type: "choice", choice: "no_data", confidence: 0.9, probabilities: {} } : defaultAnswer(id, q));

  it("uses write_code when the sandbox is on, and skips it when the sandbox is off", async () => {
    const on = await anvilWith(new FakeClient(() => "unknown", noData));
    const a = await on.runs.run({ spec: priceAgent }, {});
    expect(a.harness?.strategies).toEqual(["web_search", "read_page", "write_code"]);

    const client = new FakeClient(() => "unknown", noData);
    const off = await createAnvil({ client, config: { dataDir: client.config.dataDir, sandbox: { ...client.config.sandbox, mode: "off" } } });
    const b = await off.runs.run({ spec: priceAgent }, {});
    expect(b.harness?.strategies).toEqual(["web_search", "read_page", "browser"]);
  });
});

describe("plan review: steps that a program does better", () => {
  const plan = (type: string) =>
    JSON.stringify({ pattern: "pipeline", rationale: "r", steps: [{ id: "rank", type, purpose: "Sort 300 records and count them by region", dependsOn: ["input"] }], output: "o" });
  const archSpec = (): AgentSpec => ({
    ...spec({
      id: "arch",
      type: "anvil_architect",
      config: { taskSpec: { name: "x", goal: "Rank records", inputs: [], outputs: [], successCriteria: [] }, triage: { pattern: "pipeline", flags: {} } },
    }),
  });

  it("with the sandbox on, a step that needs exact computation becomes a code_agent step", async () => {
    let n = 0;
    const client = new FakeClient(() => (++n === 1 ? plan("llm_structured") : plan("code_agent")));
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: archSpec() }, {});
    expect(r.status).toBe("completed");
    expect(String(client.chats[1].messages.at(-1)?.content)).toContain('These steps need loops, many records, or exact computation: rank. Make each of them a "code_agent" step');
    expect((r.output as { plan: { steps: { type: string }[] } }).plan.steps[0].type).toBe("code_agent");
    expect(r.events.some((e) => e.type === "artifact" && e.kind === "codeSteps")).toBe(true);
  });

  it("with the sandbox off, the review does not ask about code", async () => {
    const client = new FakeClient(() => plan("llm_structured"));
    const anvil = await createAnvil({ client, config: { dataDir: client.config.dataDir, sandbox: { ...client.config.sandbox, mode: "off" } } });
    await anvil.runs.run({ spec: archSpec() }, {});
    const gate = client.decisions.find((d) => d.questions.complete)!;
    expect(Object.keys(gate.questions).some((k) => k.startsWith("code"))).toBe(false);
  });
});

describe("templates through a merge", () => {
  it("read the node itself, also a node without an edge into the merge, and keep other merge reads", async () => {
    const { autoFix } = await import("../src/builder/autofix.js");
    const spec = (value: string) => ({
      id: "x",
      name: "x",
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "lookup", type: "llm", config: { prompt: "p" } },
        { id: "a", type: "llm", config: { prompt: "p" } },
        { id: "m", type: "merge", config: {} },
        { id: "output", type: "output", config: { value } },
      ],
      edges: [
        { from: "input", to: "lookup" },
        { from: "lookup", to: "a" },
        { from: "a", to: "m" },
        { from: "m", to: "output" },
      ],
    });
    const r = autoFix(spec('{{nodes.m.output.a.text ?? nodes.m.output.lookup.text ?? "none"}} {{nodes.m.output.ab}}'));
    expect((r.spec.nodes as { config: { value?: string } }[])[4].config.value).toBe('{{nodes.a.output.text ?? nodes.lookup.output.text ?? "none"}} {{nodes.m.output.ab}}');
    expect(r.fixes).toEqual(expect.arrayContaining(["templates read a directly, not through merge m", "templates read lookup directly, not through merge m"]));
    const plain = autoFix(spec("{{nodes.m.output.text}}"));
    expect((plain.spec.nodes as { config: { value?: string } }[])[4].config.value).toBe("{{nodes.m.output.text}}");
  });
});
