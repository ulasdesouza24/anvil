import { describe, it, expect } from "vitest";
import { AgentSpecZ } from "@core/types";
import { connect, removeNodes, pasteNodes, copyNodes, initialState, reducer, updateNode, renameNode } from "./store";
const spec = () =>
  AgentSpecZ.parse({
    id: "test",
    name: "Test",
    nodes: [
      { id: "input", type: "input" },
      { id: "a", type: "code", config: { code: "return nodes.a.output;" } },
      { id: "b", type: "transform", config: { text: "{{nodes.a.output.text}}" } },
      { id: "output", type: "output" },
    ],
    edges: [
      { from: "input", to: "a" },
      { from: "a", to: "b" },
      { from: "b", to: "output" },
    ],
  });
describe("graph edits", () => {
  it("rejects cycles, duplicates, and input targets", () => {
    const s = spec();
    expect(() => connect(s, { from: "b", to: "a" })).toThrow("cycle");
    expect(() => connect(s, { from: "a", to: "b", port: "out" })).toThrow("exists");
    expect(() => connect(s, { from: "a", to: "input" })).toThrow("input");
  });
  it("reconnects a deleted chain and protects input/output", () => {
    const s = removeNodes(spec(), ["input", "a", "b", "output"]);
    expect(s.nodes.map((n) => n.id)).toEqual(["input", "output"]);
    expect(s.edges).toEqual([{ from: "input", to: "output", port: undefined }]);
  });
  it("does not bridge different ports", () => {
    const s = spec();
    s.edges[1].port = "error";
    expect(removeNodes(s, ["a"]).edges.some((e) => e.from === "input" && e.to === "b")).toBe(false);
  });
  it("rewrites internal copied references without changing the originals", () => {
    const s = spec();
    const p = pasteNodes(s, copyNodes(s, ["a", "b"]), { x: 400, y: 200 });
    expect(p.nodes.find((n) => n.id === "b_2")?.config.text).toBe("{{nodes.a_2.output.text}}");
    expect(p.nodes.find((n) => n.id === "a_2")?.config.code).toBe("return nodes.a_2.output;");
    expect(s.nodes[2].config.text).toBe("{{nodes.a.output.text}}");
    expect(p.edges).toContainEqual({ from: "a_2", to: "b_2" });
    expect(p.nodes.at(-1)?.position).toEqual({ x: 400, y: 200 });
  });
  it("renames code and template references", () => {
    const s = renameNode(spec(), "a", "first");
    expect(s.nodes[2].config.text).toBe("{{nodes.first.output.text}}");
    expect(s.nodes[1].config.code).toContain("nodes.first.output");
    expect(() => renameNode(s, "first", "b")).toThrow("already used");
  });
});
describe("history", () => {
  it("coalesces typing, restores pins, and keeps saved revisions distinct", () => {
    let s = initialState(spec());
    s = reducer(s, { type: "edit", spec: updateNode(s.spec, "a", { name: "A" }), group: "name", now: 1000 });
    s = reducer(s, { type: "edit", spec: updateNode(s.spec, "a", { name: "AB" }), group: "name", now: 1200 });
    expect(s.past).toHaveLength(1);
    s = reducer(s, { type: "saved", revision: 2 });
    s = reducer(s, { type: "edit", spec: s.spec, pinData: { a: { output: 42 } } });
    s = reducer(s, { type: "undo" });
    expect(s.pinData).toEqual({});
    expect(s.revision).not.toBe(s.savedRevision);
    s = reducer(s, { type: "undo" });
    expect(s.spec.nodes[1].name).toBeUndefined();
    s = reducer(s, { type: "redo" });
    expect(s.spec.nodes[1].name).toBe("AB");
  });
  it("caps history at 50 steps", () => {
    let s = initialState(spec());
    for (let i = 0; i < 80; i++) s = reducer(s, { type: "edit", spec: updateNode(s.spec, "a", { name: String(i) }) });
    expect(s.past).toHaveLength(50);
  });
});

describe("merge draft lifecycle", () => {
  it("marks an identical merged spec dirty so its new base is saved", () => {
    const before = initialState(spec());
    const after = reducer(before, { type: "rebase", spec: before.spec });
    expect(after.revision).not.toBe(after.savedRevision);
    expect(after.past).toHaveLength(0);
  });
  it("rejects malformed clipboard steps before editing the graph", () => {
    const s = spec();
    expect(() => pasteNodes(s, { anvilNodes: [{ ...s.nodes[1], id: "BAD ID" }], edges: [] }, { x: 0, y: 0 })).toThrow();
    expect(s.nodes).toHaveLength(4);
  });
});
