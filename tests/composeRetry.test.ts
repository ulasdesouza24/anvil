import { describe, expect, it } from "vitest";
import { AnvilComposeNode } from "../src/builder/nodes.js";
import { anvilWith, FakeClient } from "./helpers.js";

const spec = (value: unknown) => ({
  id: "echo",
  name: "Echo",
  description: "Echoes the text.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "output", type: "output", config: { value } },
  ],
  edges: [{ from: "input", to: "output" }],
});

describe("compose", () => {
  it("writes a new draft with the errors when the repair loop cannot fix the first draft", async () => {
    const users: string[] = [];
    const client = new FakeClient((req) => {
      const system = String(req.messages[0]?.content ?? "");
      const user = String(req.messages.at(-1)?.content ?? "");
      if (system.startsWith("You write Anvil agent specs")) {
        users.push(user);
        // The first draft computes inside a template: the compiler rejects it.
        return JSON.stringify(user.includes("AN EARLIER DRAFT DID NOT COMPILE") ? spec({ echo: "{{input.text}}" }) : spec({ same: '{{input.text == "x"}}' }));
      }
      return "{}";
    });
    client.config.repairMaxAttempts = 1;
    client.config.composeRetries = 1;
    const anvil = await anvilWith(client);
    const ctx = {
      services: anvil.runs.services,
      brain: anvil.runs.brain,
      signal: new AbortController().signal,
      runId: "r",
      node: { id: "compose", type: "anvil_compose", config: {} },
      log: () => undefined,
      emit: () => undefined,
      config: {
        taskSpec: { name: "Echo", agentId: "echo", summary: "Echoes the text.", goal: "Echo", inputs: [{ name: "text", type: "string", description: "t", required: true }], outputs: [{ name: "echo", type: "string", description: "e" }], steps: ["echo"], constraints: [], successCriteria: ["a", "b"], assumptions: [], clarifyingQuestions: [], exampleInputs: [] },
        plan: { pattern: "pipeline", rationale: "r", steps: [], output: "echo" },
      },
    };
    const r = await AnvilComposeNode.execute(ctx as never);
    expect((r.output as { spec: { nodes: { config: unknown }[] } }).spec.nodes[1].config).toEqual({ value: { echo: "{{input.text}}" } });
    expect(users).toHaveLength(2);
    expect(users[1]).toMatch(/AN EARLIER DRAFT DID NOT COMPILE[\s\S]*TEMPLATE_SYNTAX/);
  });
});
