import { describe, expect, it } from "vitest";
import type { AgentSpec } from "../src/core/types.js";
import { validateSpec } from "../src/core/validator.js";
import { createRegistry } from "../src/runtime/anvil.js";
import { anvilWith, FakeClient } from "./helpers.js";

/** An agent that asks for an approval before it gives its output. */
const approvalAgent: AgentSpec = {
  specVersion: "anvil/v1",
  id: "send",
  name: "send",
  description: "Sends a message after an approval.",
  version: 1,
  inputSchema: { type: "object", properties: {} },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "approve", type: "human_approval", config: { title: "Send the message?", payload: "hello" } },
    { id: "output", type: "output", config: { value: { sent: "{{nodes.approve.output.approved}}", comment: "{{nodes.approve.output.comment}}" } } },
  ],
  edges: [
    { from: "input", to: "approve" },
    { from: "approve", to: "output", port: "approved" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 10, timeoutMs: 10_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
};

async function unattended() {
  const client = new FakeClient();
  client.config.unattended = true;
  const anvil = await anvilWith(client);
  anvil.config.unattended = true;
  return { anvil, client };
}

describe("unattended mode", () => {
  it("approves a human step without a person, and leaves a record", async () => {
    const { anvil } = await unattended();
    const r = await anvil.runs.run({ spec: approvalAgent }, {});
    expect(r.status).toBe("completed");
    expect(r.output).toEqual({ sent: true, comment: "auto-approved (unattended mode)" });
    const log = r.events.find((e) => e.type === "log" && e.message.startsWith("auto-approved without a person"));
    expect(log).toMatchObject({ nodeId: "approve", level: "warn", message: "auto-approved without a person (unattended mode): Send the message?" });
  });

  it("waits for a person when the mode is off", async () => {
    const anvil = await anvilWith(new FakeClient());
    const rec = anvil.runs.start({ spec: approvalAgent }, {}, { kind: "run" });
    await new Promise((r) => setTimeout(r, 100));
    expect(anvil.runs.pendingRequests(rec.id).map((p) => p.nodeId)).toEqual(["approve"]);
    anvil.runs.cancel(rec.id);
  });

  it("the compiler rejects human steps in unattended builds", () => {
    const codes = (unattended: boolean) => validateSpec(approvalAgent, createRegistry(), { unattended }).diagnostics.map((d) => d.code);
    expect(codes(true)).toContain("HUMAN_STEP_UNATTENDED");
    expect(codes(false)).not.toContain("HUMAN_STEP_UNATTENDED");
  });

  it("the analysis asks no questions, and the architect gets the unattended note", async () => {
    const taskSpec = {
      name: "Sender",
      agentId: "sender",
      summary: "Sends.",
      goal: "Send a message.",
      inputs: [{ name: "text", type: "string", description: "The text", required: true }],
      outputs: [{ name: "sent", type: "boolean", description: "Sent" }],
      steps: ["send"],
      constraints: [],
      successCriteria: ["The message is sent.", "The output says it."],
      assumptions: [],
      clarifyingQuestions: ["Which channel?"],
      exampleInputs: [{ text: "a" }, { text: "b" }],
      dataNeeds: [],
      trigger: { kind: "manual", description: "A person runs it." },
    };
    const plan = { pattern: "pipeline", rationale: "r", steps: [{ id: "w", type: "llm", purpose: "write", dependsOn: ["input"] }], output: "w" };
    const { anvil, client } = await unattended();
    client.chat = (async (req: Parameters<typeof client.chat>[0]) => {
      client.chats.push(req);
      const sys = String(req.messages[0]?.content ?? "");
      const content = sys.includes("You are the architect") ? JSON.stringify(plan) : JSON.stringify(taskSpec);
      return { content, toolCalls: [], finishReason: "stop", model: "fake", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: 1 };
    }) as typeof client.chat;
    const spec: AgentSpec = {
      ...approvalAgent,
      id: "steps",
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "analyze", type: "anvil_analyze", config: { request: "Send messages.", triage: { pattern: "pipeline", clarity: 0.1 } } },
        { id: "architect", type: "anvil_architect", config: { taskSpec: "{{nodes.analyze.output.taskSpec}}", triage: { pattern: "pipeline" } } },
        { id: "output", type: "output", config: { value: "{{nodes.analyze.output.needsClarification}}" } },
      ],
      edges: [
        { from: "input", to: "analyze" },
        { from: "analyze", to: "architect" },
        { from: "architect", to: "output" },
      ],
    };
    const r = await anvil.runs.run({ spec }, {});
    expect(r.error).toBeUndefined();
    expect(r.output).toBe(false);
    const architect = client.chats.find((c) => String(c.messages[0]?.content).includes("You are the architect"));
    expect(String(architect?.messages.at(-1)?.content)).toContain("UNATTENDED: the agent runs without a person.");
  });
});
