import { describe, expect, it } from "vitest";
import { autoFix } from "../src/builder/autofix.js";
import { EXAMPLE_SPEC } from "../src/builder/guide.js";
import { SYSTEM_AGENTS } from "../src/builder/systemAgents.js";
import { extractRefs, resolveDeep, resolveString } from "../src/core/template.js";
import { bm25, calculate, runSandboxed } from "../src/core/tools/text.js";
import { htmlToText } from "../src/core/tools/web.js";
import type { AgentSpec } from "../src/core/types.js";
import { validateSpec } from "../src/core/validator.js";
import { extractJson } from "../src/llm/json.js";
import { createRegistry } from "../src/runtime/anvil.js";

const registry = createRegistry();

describe("template language", () => {
  const scope = { input: { name: "Ada", tags: ["a", "b"], n: 3 }, nodes: { x: { output: { text: "hi", items: [{ t: 1 }, { t: 2 }] } }, y: { output: {} } } };
  it("keeps raw types for whole expressions", () => {
    expect(resolveString("{{nodes.x.output.items}}", scope)).toEqual([{ t: 1 }, { t: 2 }]);
    expect(resolveString("{{ input.n }}", scope)).toBe(3);
  });
  it("interpolates, falls back and filters", () => {
    expect(resolveString("Hello {{input.name | upper}}!", scope)).toBe("Hello ADA!");
    expect(resolveString("{{nodes.y.output.text ?? nodes.x.output.text}}", scope)).toBe("hi");
    expect(resolveString('{{nodes.y.output.text ?? "none"}}', scope)).toBe("none");
    expect(resolveString('{{input.tags | join:" / "}}', scope)).toBe("a / b");
    expect(resolveString("{{nodes.x.output.items | length}}", scope)).toBe(2);
    expect(resolveString("{{nodes.x.output.items[-1].t}}", scope)).toBe(2);
  });
  it("resolves deeply and respects skip keys", () => {
    expect(resolveDeep({ a: "{{input.name}}", b: ["{{input.n}}"], c: "{{item}}" }, scope, ["c"])).toEqual({ a: "Ada", b: [3], c: "{{item}}" });
  });
  it("extracts references with node ids and field paths", () => {
    const { refs, issues } = extractRefs({ p: "x {{nodes.foo.output.bar[0].baz}} {{input.q ?? nodes.z.output.t}}" });
    expect(issues).toEqual([]);
    expect(refs.map((r) => [r.root, r.nodeId, r.fieldPath])).toEqual([
      ["nodes", "foo", ["bar", 0, "baz"]],
      ["input", undefined, undefined],
      ["nodes", "z", ["t"]],
    ]);
    expect(extractRefs({ p: "{{input.x | nope}}" }).issues[0].message).toMatch(/Unknown filter/);
  });
});

describe("validator (compiler)", () => {
  it("accepts the bundled example and every system agent", () => {
    expect(validateSpec(EXAMPLE_SPEC, registry).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    for (const s of SYSTEM_AGENTS) expect(validateSpec(s, registry, { allowInternal: true }).valid).toBe(true);
  });

  it("rejects internal node types in user agents", () => {
    const r = validateSpec({ ...EXAMPLE_SPEC, nodes: [...EXAMPLE_SPEC.nodes, { id: "x", type: "anvil_compose", config: {} }] }, registry);
    expect(r.diagnostics.some((d) => d.code === "UNKNOWN_NODE_TYPE")).toBe(true);
  });

  it("reports precise, actionable diagnostics", () => {
    const bad = {
      id: "bad-agent",
      name: "Bad",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "sum", type: "lmm", config: { prompt: "x" } },
        { id: "ext", type: "llm_structured", config: { prompt: "{{input.txt}}", schema: { type: "object", properties: { title: { type: "string" } } } } },
        { id: "use", type: "llm", config: { prompt: "{{nodes.ext.output.titel}} {{nodes.later.output.text}} {{nodes.ghost.output.x}}" } },
        { id: "later", type: "llm", config: { prompt: "p" } },
        {
          id: "route",
          type: "decision",
          config: { state: "{{input.text}}", questions: { k: { type: "choice", instructions: "which?", criteria: { a: "A", b: "B" } } }, route: "k" },
        },
        { id: "orphan", type: "llm", config: { prompt: "p" } },
        { id: "output", type: "output", config: { value: "{{nodes.use.output.text}}" } },
      ],
      edges: [
        { from: "input", to: "ext" },
        { from: "ext", to: "use" },
        { from: "use", to: "later" },
        { from: "input", to: "route" },
        { from: "route", to: "output", port: "c" },
        { from: "use", to: "output" },
      ],
    };
    const r = validateSpec(bad, registry);
    const codes = new Set(r.diagnostics.map((d) => d.code));
    for (const c of [
      "UNKNOWN_NODE_TYPE",
      "TEMPLATE_UNKNOWN_INPUT",
      "TEMPLATE_UNKNOWN_FIELD",
      "TEMPLATE_NOT_UPSTREAM",
      "TEMPLATE_UNKNOWN_NODE",
      "EDGE_UNKNOWN_PORT",
      "UNREACHABLE_NODE",
    ]) {
      expect(codes, c).toContain(c);
    }
    expect(r.diagnostics.find((d) => d.code === "UNKNOWN_NODE_TYPE")?.hint).toContain('"llm"');
    expect(r.diagnostics.find((d) => d.code === "TEMPLATE_UNKNOWN_FIELD")?.hint).toContain("title");
    expect(r.valid).toBe(false);
  });

  it("detects cycles", () => {
    const r = validateSpec(
      {
        id: "cyc",
        name: "c",
        nodes: [
          { id: "input", type: "input" },
          { id: "a", type: "llm", config: { prompt: "p" } },
          { id: "b", type: "llm", config: { prompt: "p" } },
          { id: "output", type: "output", config: { value: 1 } },
        ],
        edges: [
          { from: "input", to: "a" },
          { from: "a", to: "b" },
          { from: "b", to: "a" },
          { from: "b", to: "output" },
        ],
      },
      registry,
    );
    expect(r.diagnostics.some((d) => d.code === "CYCLE")).toBe(true);
  });

  it("allows templates where typed values are expected", () => {
    const spec: AgentSpec = structuredClone(EXAMPLE_SPEC);
    spec.nodes.splice(5, 0, { id: "m", type: "map", config: { items: "{{input.message}}", mode: "llm", prompt: "{{item}}", concurrency: "{{input.message}}" } });
    spec.edges.push({ from: "classify", to: "m", port: "refund" }, { from: "m", to: "output" });
    const r = validateSpec(spec, registry);
    expect(r.diagnostics.filter((d) => d.code === "INVALID_CONFIG")).toEqual([]);
  });
});

describe("code safety", () => {
  it("flags unsafe property access on nodes that can be skipped", () => {
    const mk = (code: string) => ({
      id: "c",
      name: "c",
      nodes: [
        { id: "input", type: "input" },
        { id: "gate", type: "router", config: { rules: [{ port: "yes", when: { left: "{{input.x}}", op: "truthy" } }], default: "no" } },
        { id: "w", type: "llm", config: { prompt: "p" } },
        { id: "j", type: "code", config: { code } },
        { id: "output", type: "output", config: { value: "{{nodes.j.output}}" } },
      ],
      edges: [
        { from: "input", to: "gate" },
        { from: "gate", to: "w", port: "yes" },
        { from: "gate", to: "j", port: "no" },
        { from: "w", to: "j" },
        { from: "j", to: "output" },
      ],
    });
    const codes = (code: string) => validateSpec(mk(code), registry).diagnostics.map((d) => d.code);
    expect(codes("return nodes.w.output.text")).toContain("CODE_UNSAFE_OPTIONAL");
    expect(codes("return nodes.w.output?.text ?? ''")).not.toContain("CODE_UNSAFE_OPTIONAL");
    expect(codes("return nodes.gate.output.matched")).not.toContain("CODE_UNSAFE_OPTIONAL"); // gate always runs before j
  });
});

describe("autofix", () => {
  it("normalizes common model slips", () => {
    const { spec, fixes } = autoFix({
      spec: {
        name: "My Agent!",
        nodes: [
          { id: "Input", type: "input" },
          { id: "Write Summary", type: "llm", prompt: "Summarize {{input.text}}" },
          { id: "out", type: "output", config: { value: "{{nodes.Write Summary.output.text}}" } },
        ],
        edges: [
          { source: "Input", target: "Write Summary" },
          { source: "Write Summary", target: "out" },
          { source: "Write Summary", target: "out" },
        ],
      },
    });
    expect(spec.id).toBe("my-agent");
    const nodes = spec.nodes as { id: string; config: Record<string, unknown> }[];
    expect(nodes.map((n) => n.id)).toEqual(["input", "write_summary", "out"]);
    expect(nodes[1].config.prompt).toBe("Summarize {{input.text}}");
    expect(spec.edges).toEqual([
      { from: "input", to: "write_summary" },
      { from: "write_summary", to: "out" },
    ]);
    expect(fixes.length).toBeGreaterThan(2);
  });
});

describe("autofix with registry knowledge", () => {
  it("hoists only real config keys and drops planning leftovers", async () => {
    const { configKeysFor } = await import("../src/builder/repair.js");
    const { spec, fixes } = autoFix(
      {
        id: "x",
        name: "x",
        nodes: [
          { id: "input", type: "input" },
          { id: "w", type: "llm", prompt: "p", model: "fast", dependsOn: ["input"], branch: null, config: { purpose: "write" } },
          { id: "output", type: "output", config: { value: 1 } },
        ],
        edges: [],
      },
      { configKeys: configKeysFor(registry) },
    );
    const w = (spec.nodes as { id: string; config: Record<string, unknown> }[])[1];
    expect(w.config).toEqual({ prompt: "p", model: "fast" });
    expect(fixes.some((f) => f.includes("dependsOn"))).toBe(true);
  });
});

describe("lenient JSON patch", () => {
  it("applies valid ops and tolerates harmless slips", async () => {
    const { applyPatchLenient } = await import("../src/builder/repair.js");
    const r = applyPatchLenient({ a: 1, nodes: [{ id: "x", config: {} }] }, [
      { op: "remove", path: "/nodes/0/branch" },
      { op: "replace", path: "/nodes/0/config/prompt", value: "hi" },
      { op: "add", path: "/b", value: 2 },
    ]);
    expect(r.doc).toEqual({ a: 1, b: 2, nodes: [{ id: "x", config: { prompt: "hi" } }] });
    expect(r.applied).toBe(2);
    expect(r.skipped[0]).toContain("ignored");
  });
});

describe("tools", () => {
  it("calculates safely", () => {
    expect(calculate("(1200*0.18)+45")).toBeCloseTo(261);
    expect(calculate("round(sqrt(2),3)")).toBe(1.414);
    expect(calculate("2^3^2")).toBe(512);
    expect(calculate("-(3+4)*2")).toBe(-14);
    expect(() => calculate("process.exit()")).toThrow();
  });
  it("ranks with BM25", () => {
    const hits = bm25(
      [
        { id: "a", text: "Refunds are available within 30 days." },
        { id: "b", text: "Shipping takes 5 business days." },
      ],
      "how many days for a refund",
    );
    expect(hits[0].id).toBe("a");
  });
  it("sandboxes code", () => {
    expect(runSandboxed("return data.map(x => x * 2)", { data: [1, 2] })).toEqual([2, 4]);
    expect(() => runSandboxed("while(true){}", {}, 50)).toThrow();
    expect(() => runSandboxed("return require('fs')", {})).toThrow();
  });
  it("extracts readable text from html", () => {
    const r = htmlToText("<html><head><title>T &amp; Co</title><script>x()</script></head><body><h1>Hello</h1><p>World &#8212; ok</p></body></html>");
    expect(r.title).toBe("T & Co");
    expect(r.text).toContain("Hello");
    expect(r.text).toContain("World — ok");
    expect(r.text).not.toContain("x()");
  });
  it("extracts JSON from messy model output", () => {
    expect(extractJson('Sure! ```json\n{"a": [1,2,],}\n``` done')).toEqual({ a: [1, 2] });
    expect(extractJson('prefix {"x": {"y": "}"}} suffix')).toEqual({ x: { y: "}" } });
  });
});

describe("input preparation", () => {
  it("drops an optional field that a form leaves empty, and keeps a required one", async () => {
    const { prepareInput } = await import("../src/core/engine.js");
    const schema = { type: "object", properties: { url: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1 } }, required: ["url"] };
    expect(prepareInput(schema, { url: "https://x.test", text: "" })).toEqual({ value: { url: "https://x.test" }, errors: [] });
    expect(prepareInput(schema, { url: "" }).errors).toEqual(["/url must NOT have fewer than 1 characters"]);
  });
});
