import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSpec } from "../src/core/types.js";
import { buildTask, buildTasks, loadTask, taskFilesIn } from "../src/runtime/tasks.js";
import { apiTokenOk } from "../src/server/auth.js";
import { anvilWith, FakeClient, tmpDir } from "./helpers.js";

/** A builder that saves a fixed agent and returns its id, like the real builder. It records its input. */
const inputs: unknown[] = [];
async function setup() {
  const anvil = await anvilWith(new FakeClient());
  const agent: AgentSpec = {
    specVersion: "anvil/v1",
    id: "built",
    name: "Built",
    description: "A built agent.",
    version: 1,
    inputSchema: { type: "object", properties: {} },
    nodes: [
      { id: "input", type: "input", config: {} },
      { id: "output", type: "output", config: { value: { ok: true } } },
    ],
    edges: [{ from: "input", to: "output" }],
    policy: { maxCostUsd: 1, maxNodeExecutions: 10, timeoutMs: 10_000, requireApprovalForSideEffects: false },
    tests: [],
    meta: {},
  };
  await anvil.store.saveVersion(agent, { note: "x" });
  const builder: AgentSpec = {
    ...agent,
    id: "fake-builder",
    inputSchema: { type: "object", properties: { request: { type: "string" } } },
    nodes: [
      { id: "input", type: "input", config: {} },
      { id: "c", type: "code", config: { code: 'if (input.request.includes("fail")) throw new Error("the build failed"); return { agentId: "built", score: 0.9, passRate: 1, quality: "passed" }' } },
      { id: "output", type: "output", config: { value: "{{nodes.c.output}}" } },
    ],
    edges: [
      { from: "input", to: "c" },
      { from: "c", to: "output" },
    ],
  };
  const origStart = anvil.runs.start.bind(anvil.runs);
  anvil.runs.start = ((ref: never, input: unknown, o: never) => {
    inputs.push(input);
    return origStart(ref, input as never, o);
  }) as typeof anvil.runs.start;
  return { anvil, builder: { spec: builder } };
}

const write = (dir: string, name: string, data: unknown) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data));
  return p;
};

describe("task files", () => {
  it("loads a task with defaults, and names it after the file", () => {
    const dir = tmpDir();
    const t = loadTask(write(dir, "fx-weekly.json", { request: "Weekly rates." }));
    expect(t).toMatchObject({ id: "fx-weekly", request: "Weekly rates.", evaluate: true, optimize: true, files: [], maxBuildUsd: 10 });
    expect(() => loadTask(write(dir, "bad.json", { files: [] }))).toThrow(/bad\.json: request/);
    expect(() => loadTask(write(dir, "broken.json", "{"))).toThrow(/broken\.json/);
    write(dir, "notes.txt", "x");
    expect(taskFilesIn(dir).map((f) => path.basename(f))).toEqual(["bad.json", "broken.json", "fx-weekly.json"]);
  });

  it("builds one task without a person, attaches its files, and writes the agent file", async () => {
    const { anvil, builder } = await setup();
    const dir = tmpDir();
    write(dir, "invoice.txt", "Total: 42 EUR");
    const task = loadTask(write(dir, "inv.json", { request: "Read invoices.", files: ["invoice.txt"], maxBuildUsd: 2 }));
    const out = path.join(dir, "out", "inv.agent.json");
    const r = await buildTask(anvil, task, { outFile: out, builder });
    expect(r).toMatchObject({ id: "inv", status: "completed", agentId: "built", score: 0.9, quality: "passed", out });
    expect(JSON.parse(fs.readFileSync(out, "utf8")).id).toBe("built");
    const input = inputs.at(-1) as { clarify: boolean; askOnCost: boolean; confirmAboveUsd: number; files: string[] };
    expect(input).toMatchObject({ clarify: false, askOnCost: false, confirmAboveUsd: 2 });
    expect(anvil.files.get(input.files[0])?.content.text).toBe("Total: 42 EUR");
    const missing = await buildTask(anvil, loadTask(write(dir, "m.json", { request: "x", files: ["nope.txt"] })), { builder });
    expect(missing).toMatchObject({ status: "failed", error: expect.stringMatching(/file not found/) });
  });

  it("builds a folder of tasks, keeps going after a failed task, and writes a summary", async () => {
    const { anvil, builder } = await setup();
    const dir = tmpDir();
    write(dir, "a.json", { request: "Do task a." });
    write(dir, "b.json", { request: "This one should fail." });
    write(dir, "c.json", { nothing: true });
    const outDir = path.join(dir, "out");
    const results = await buildTasks(anvil, taskFilesIn(dir), { outDir, concurrency: 2, builder });
    expect(results.map((r) => [r.id, !!r.agentId])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
    expect(results[1].error).toMatch(/the build failed/);
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, "summary.json"), "utf8"));
    expect(summary).toMatchObject({ tasks: 3, published: 1 });
    expect(fs.existsSync(path.join(outDir, "a.agent.json"))).toBe(true);
  });
});

describe("API token", () => {
  const h = (headers: Record<string, string>) => (name: string) => headers[name];
  const q = (query: Record<string, string>) => (name: string) => query[name];
  it("allows every request without a configured token", () => {
    expect(apiTokenOk("", "/api/agents", h({}), q({}))).toBe(true);
  });
  it("needs the token in a header or, for event streams, in the query", () => {
    expect(apiTokenOk("s3cret", "/api/agents", h({}), q({}))).toBe(false);
    expect(apiTokenOk("s3cret", "/api/agents", h({ authorization: "Bearer s3cret" }), q({}))).toBe(true);
    expect(apiTokenOk("s3cret", "/api/agents", h({ "x-anvil-token": "s3cret" }), q({}))).toBe(true);
    expect(apiTokenOk("s3cret", "/api/runs/r/events", h({}), q({ token: "s3cret" }))).toBe(true);
    expect(apiTokenOk("s3cret", "/api/agents", h({ authorization: "Bearer wrong!" }), q({}))).toBe(false);
  });
  it("keeps the health check and the webhooks open", () => {
    expect(apiTokenOk("s3cret", "/api/health", h({}), q({}))).toBe(true);
    expect(apiTokenOk("s3cret", "/api/hooks/a/t", h({}), q({}))).toBe(true);
  });
});
