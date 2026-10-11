import { describe, expect, it } from "vitest";
import { validateClassDef } from "../src/core/customClass.js";
import { asyncCodeProblem, runSandboxed } from "../src/core/tools/text.js";
import { validateSpec } from "../src/core/validator.js";
import { createRegistry } from "../src/runtime/anvil.js";
import { guardProcess } from "../src/runtime/processGuard.js";

describe("async code in code steps", () => {
  it("finds async features, and accepts plain synchronous code", () => {
    expect(asyncCodeProblem("return (async () => { const r = await fetch(url); })()")).toMatch(/^The code uses async\./);
    expect(asyncCodeProblem("return fetch('https://x.test')")).toMatch(/uses fetch/);
    expect(asyncCodeProblem("return items.filter((x) => x.asynchronous).map((x) => x.id)")).toBeNull();
  });

  it("the sandbox fails a step whose code returns a promise, and the error of the promise does not stop the process", async () => {
    const code = "return (async () => { await fetch('https://api.github.com'); return 1; })()";
    expect(() => runSandboxed(code, {})).toThrow(/Code runs synchronously and has no network/);
    // Without a handler, the rejected promise would fail this test file with an unhandled rejection.
    await new Promise((r) => setTimeout(r, 50));
  });

  it("the compiler rejects a code node and a code class with async code before they run", () => {
    const spec = {
      specVersion: "anvil/v1",
      id: "a",
      name: "a",
      description: "",
      version: 1,
      inputSchema: { type: "object", properties: {} },
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "c", type: "code", config: { code: "const r = await fetch('https://x.test'); return r" } },
        { id: "output", type: "output", config: { value: "{{nodes.c.output}}" } },
      ],
      edges: [
        { from: "input", to: "c" },
        { from: "c", to: "output" },
      ],
      policy: { maxCostUsd: 1, maxNodeExecutions: 10, timeoutMs: 10_000, requireApprovalForSideEffects: false },
      tests: [],
      meta: {},
    };
    const v = validateSpec(spec, createRegistry());
    expect(v.diagnostics.find((d) => d.code === "CODE_ASYNC")).toMatchObject({ severity: "error", nodeId: "c" });
    const def = {
      type: "x_repo_stats",
      title: "Repo stats",
      category: "data",
      description: "Stats of a repository.",
      whenToUse: "Repository data.",
      configSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      impl: { kind: "code", code: "return (async () => (await fetch('https://api.github.com')).json())()" },
      tests: [],
    };
    const r = validateClassDef(def, createRegistry());
    expect(r.diagnostics.some((d) => d.severity === "error" && /Code runs synchronously/.test(d.message))).toBe(true);
  });

  it("the process guard logs a promise error and the process continues", async () => {
    const logs: string[] = [];
    guardProcess("test", (m) => logs.push(m));
    const listener = process.listeners("unhandledRejection").at(-1)!;
    listener(new Error("boom"), Promise.resolve());
    expect(logs[0]).toMatch(/^\[test\] a promise failed without a handler\. The process continues\.\nError: boom/);
  });
});
