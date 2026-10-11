import { describe, expect, it } from "vitest";
import type { AgentSpec } from "../src/core/types.js";
import { anvilWith, FakeClient } from "./helpers.js";

const spec: AgentSpec = {
  specVersion: "anvil/v1",
  id: "calc",
  name: "calc",
  description: "",
  version: 1,
  inputSchema: { type: "object", properties: {} },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "a", type: "agent", config: { task: "Compute 2+2.", tools: ["calculator"], maxSteps: 2, style: "plain" } },
    { id: "output", type: "output", config: { value: { text: "{{nodes.a.output.answer}}" } } },
  ],
  edges: [
    { from: "input", to: "a" },
    { from: "a", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 20_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
};

describe("the last step of an agent", () => {
  it("keeps the tools with tool_choice none and asks for the final answer", async () => {
    const client = new FakeClient((req) =>
      req.toolChoice === "none" ? "The answer is 4." : { content: "", toolCalls: [{ id: `c${Math.random()}`, type: "function", function: { name: "calculator", arguments: '{"expression":"2+2"}' } }] },
    );
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec }, {});
    expect(r.output).toEqual({ text: "The answer is 4." });
    const last = client.chats.at(-1)!;
    expect(last.toolChoice).toBe("none");
    expect(last.tools?.length).toBeGreaterThan(0);
    expect(String(last.messages.at(-1)?.content)).toMatch(/^This is the last step\. Do not call a tool\./);
    expect(client.chats[0].toolChoice).toBe("auto");
  });
});
