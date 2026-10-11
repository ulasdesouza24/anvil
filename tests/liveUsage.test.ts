import { describe, expect, it } from "vitest";
import type { AgentSpec, RunEvent } from "../src/core/types.js";
import type { ChatRequest, ChatResult } from "../src/llm/openrouter.js";
import { createAnvil } from "../src/runtime/anvil.js";
import { FakeClient } from "./helpers.js";

/** A model that answers after a short time, so a nested run works for a while. */
class SlowClient extends FakeClient {
  async chat(req: ChatRequest): Promise<ChatResult> {
    await new Promise((r) => setTimeout(r, 250));
    return super.chat(req);
  }
}

const base = (id: string, nodes: AgentSpec["nodes"], edges: AgentSpec["edges"]): AgentSpec => ({
  specVersion: "anvil/v1",
  id,
  name: id,
  description: "",
  version: 1,
  inputSchema: { type: "object", properties: {} },
  nodes,
  edges,
  policy: { maxCostUsd: 1, maxNodeExecutions: 50, timeoutMs: 30_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
});

/** Two LLM steps, one after the other. */
const child = base(
  "child",
  [
    { id: "input", type: "input", config: {} },
    { id: "a", type: "llm", config: { prompt: "one" } },
    { id: "b", type: "llm", config: { prompt: "two" } },
    { id: "output", type: "output", config: { value: "{{nodes.b.output.text}}" } },
  ],
  [
    { from: "input", to: "a" },
    { from: "a", to: "b" },
    { from: "b", to: "output" },
  ],
);

async function setup() {
  const client = new SlowClient();
  const anvil = await createAnvil({ client, config: { dataDir: client.config.dataDir, maxParallel: 4, liveUsageMs: 10 } });
  await anvil.store.saveVersion(child, { note: "t" });
  return anvil;
}

describe("the cost of nested runs (docs/RUNS.md)", () => {
  it("goes to the parent while a sub-agent works, and the final total counts each call one time", async () => {
    const anvil = await setup();
    const parent = base(
      "parent",
      [
        { id: "input", type: "input", config: {} },
        { id: "sub", type: "subagent", config: { agentId: "child", input: {} } },
        { id: "output", type: "output", config: { value: "{{nodes.sub.output}}" } },
      ],
      [
        { from: "input", to: "sub" },
        { from: "sub", to: "output" },
      ],
    );
    const live: number[] = [];
    const rec = anvil.runs.start({ spec: parent }, {});
    anvil.runs.subscribe(rec.id, (e: RunEvent, r) => {
      if (e.type === "usage") live.push(r.usage.llmCalls);
    });
    const done = await anvil.runs.waitForRun(rec.id);
    expect(done?.status).toBe("completed");
    // The parent saw the cost of the first call before the sub-agent ended.
    expect(live.length).toBeGreaterThan(0);
    expect(live[0]).toBeGreaterThanOrEqual(1);
    expect(done?.usage.llmCalls).toBe(2);
  });

  it("goes to the parent from a recorded nested run", async () => {
    const anvil = await setup();
    const waiting = base(
      "waiting",
      [
        { id: "input", type: "input", config: {} },
        { id: "hold", type: "human_approval", config: { title: "hold" } },
        { id: "output", type: "output", config: { value: "ok" } },
      ],
      [
        { from: "input", to: "hold" },
        { from: "hold", to: "output", port: "approved" },
      ],
    );
    const p = anvil.runs.start({ spec: waiting }, {});
    await anvil.runs.run({ agentId: "child" }, {}, { parentRunId: p.id });
    for (let i = 0; i < 100 && anvil.runs.activeRecord(p.id)!.usage.llmCalls < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(anvil.runs.activeRecord(p.id)!.usage.llmCalls).toBe(2);
    expect(anvil.runs.activeRecord(p.id)!.events.some((e) => e.type === "usage")).toBe(true);
    anvil.runs.cancel(p.id);
  });
});
