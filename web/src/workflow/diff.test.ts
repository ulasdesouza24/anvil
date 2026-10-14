import type { AgentSpec } from "@core/types";
import { describe, expect, it } from "vitest";
import { changedParts, diffSummary, diffView, explainWorkflow, placeNew } from "./diff";

const spec = (over: Partial<AgentSpec> = {}): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "wf",
  name: "Flow",
  description: "Checks a text",
  version: 1,
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  nodes: [
    { id: "input", type: "input", config: {}, position: { x: 0, y: 0 } },
    { id: "check", type: "router", name: "Check", config: {}, position: { x: 300, y: 0 } },
    { id: "output", type: "output", config: { value: 1 }, position: { x: 600, y: 0 } },
  ],
  edges: [
    { from: "input", to: "check" },
    { from: "check", to: "output", port: "long" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 10, timeoutMs: 1000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
  ...over,
});

describe("workflow diff helpers", () => {
  it("places a new step next to the step before it, and moves it down when the place is taken", () => {
    const s = spec();
    s.nodes.push({ id: "a", type: "llm", config: {} }, { id: "b", type: "llm", config: {} });
    s.edges.push({ from: "input", to: "a" }, { from: "a", to: "b" });
    const p = placeNew(s);
    expect(p.nodes.find((n) => n.id === "a")?.position).toEqual({ x: 300, y: 120 });
    expect(p.nodes.find((n) => n.id === "b")?.position).toEqual({ x: 600, y: 120 });
    expect(p.nodes.find((n) => n.id === "check")?.position).toEqual({ x: 300, y: 0 });
  });

  it("marks added, changed and removed steps and edges", () => {
    const base = spec();
    const next = spec();
    next.nodes = next.nodes.filter((n) => n.id !== "check");
    next.nodes.splice(1, 0, { id: "new_step", type: "llm", config: {} });
    next.nodes[2] = { ...next.nodes[2], config: { value: 2 } };
    next.edges = [
      { from: "input", to: "new_step" },
      { from: "new_step", to: "output" },
    ];
    const v = diffView(base, next);
    expect(v.nodes.map((n) => [n.node.id, n.mark])).toEqual([
      ["input", "same"],
      ["new_step", "added"],
      ["output", "changed"],
      ["check", "removed"],
    ]);
    expect(v.nodes[2].fields).toEqual(["config"]);
    expect(v.edges.filter((e) => e.mark === "removed")).toHaveLength(2);
    expect(diffSummary(v.diff)).toBe("1 added · 1 removed · 1 changed · 4 connection change(s)");
    expect((changedParts(base, next).after as { nodes: unknown[] }).nodes).toHaveLength(2);
  });

  it("explains a workflow in execution order without an AI call", () => {
    const text = explainWorkflow(spec({ triggers: [{ id: "daily", type: "schedule", cron: "0 9 * * *", enabled: false }] }), { router: "Router" });
    expect(text.split("\n")).toEqual([
      "Flow: Checks a text",
      "It takes the input fields text.",
      "Trigger daily (schedule, 0 9 * * *) starts it when a person turns it on.",
      "1. Check (router): Router. Then: long → output.",
      "2. output (output): output.",
    ]);
  });
});
