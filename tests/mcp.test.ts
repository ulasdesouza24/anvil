import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentSpec } from "../src/core/types.js";
import { validateSpec } from "../src/core/validator.js";
import { createAnvil } from "../src/runtime/anvil.js";
import { createAnvilMcpServer, localBackend } from "../src/runtime/mcpServer.js";
import { FakeClient, tmpDir } from "./helpers.js";

function fakeMcpServer() {
  const notes: string[] = [];
  const s = new McpServer({ name: "calc", version: "0.1.0" });
  s.registerTool(
    "add",
    { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() }, outputSchema: { sum: z.number() }, annotations: { readOnlyHint: true } },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }], structuredContent: { sum: a + b } }),
  );
  s.registerTool("save_note", { description: "Store a note", inputSchema: { text: z.string() } }, async ({ text }) => {
    notes.push(text);
    return { content: [{ type: "text", text: JSON.stringify({ saved: true, count: notes.length }) }] };
  });
  s.registerTool("boom", { description: "Always fails", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
    content: [{ type: "text", text: "kaboom" }],
    isError: true,
  }));
  return { s, notes };
}

async function anvilWithMcp() {
  const fake = fakeMcpServer();
  const client = new FakeClient();
  const anvil = await createAnvil({
    client,
    config: { dataDir: client.config.dataDir },
    mcpTransport: async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await fake.s.connect(serverSide);
      return clientSide;
    },
  });
  return { anvil, fake };
}

const agentUsing = (type: string, config: Record<string, unknown>, value: string): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "mcp-user",
  name: "mcp user",
  description: "",
  version: 1,
  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "t", type, config },
    { id: "output", type: "output", config: { value } },
  ],
  edges: [
    { from: "input", to: "t" },
    { from: "t", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 30_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
});

describe("MCP: consuming external servers", () => {
  it("turns tools into classes with safe defaults and runs them inside agents", async () => {
    const { anvil, fake } = await anvilWithMcp();
    const sync = await anvil.mcp.addServer({ name: "calc", transport: "stdio", command: "unused-in-test" });
    expect(sync.added.sort()).toEqual(["x_mcp_calc_add", "x_mcp_calc_boom", "x_mcp_calc_save_note"]);
    const add = anvil.classes.get("x_mcp_calc_add")!;
    const note = anvil.classes.get("x_mcp_calc_save_note")!;
    expect([add.sideEffects, add.approved]).toEqual([false, true]); // read-only → usable
    expect([note.sideEffects, note.approved]).toEqual([true, false]); // may write → needs approval

    // Structured tools: the compiler knows their output fields.
    const spec = agentUsing("x_mcp_calc_add", { a: "{{input.a}}", b: "{{input.b}}" }, "{{nodes.t.output.sum}}");
    expect(validateSpec(spec, anvil.registry).valid).toBe(true);
    expect(
      validateSpec(agentUsing("x_mcp_calc_add", { a: 1, b: 2 }, "{{nodes.t.output.total}}"), anvil.registry).diagnostics.some((d) => d.code === "TEMPLATE_UNKNOWN_FIELD"),
    ).toBe(true);
    expect((await anvil.runs.run({ spec }, { a: 2, b: 40 })).output).toBe(42);

    const noteSpec = agentUsing("x_mcp_calc_save_note", { text: "hello" }, "{{nodes.t.output.json.count}}");
    expect((await anvil.runs.run({ spec: noteSpec }, {})).error).toMatch(/not been approved/);
    expect(await anvil.mcp.approveAll("calc")).toBe(1);
    expect((await anvil.runs.run({ spec: noteSpec }, {})).output).toBe(1);
    expect(fake.notes).toEqual(["hello"]);

    const boom = await anvil.runs.run({ spec: agentUsing("x_mcp_calc_boom", {}, "{{nodes.t.output.text}}") }, {});
    expect(boom.error).toMatch(/MCP tool error: kaboom/);

    const status = await anvil.mcp.status();
    expect(status[0]).toMatchObject({ connected: true });
    expect(status[0].tools).toHaveLength(3);
    await expect(anvil.mcp.removeServer("calc")).resolves.toBeUndefined();
    expect(anvil.registry.get("x_mcp_calc_add")).toBeUndefined();
  });
});

describe("MCP: exposing Anvil", () => {
  it("lists agents as tools with meta-tools, and runs them", async () => {
    const client = new FakeClient();
    const anvil = await createAnvil({ client, config: { dataDir: client.config.dataDir } });
    await anvil.store.saveVersion(
      {
        ...agentUsing("code", { code: "return { sum: input.a + input.b }" }, "{{nodes.t.output.sum}}"),
        id: "adder",
        name: "Adder",
        description: "Adds two numbers",
      },
      { note: "t" },
    );
    const server = createAnvilMcpServer(localBackend(anvil));
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const mcp = new Client({ name: "test", version: "1" });
    await mcp.connect(c);
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["anvil_build", "anvil_refine", "anvil_list_agents", "anvil_run_agent", "adder", "support-triage-example"]));
    const r = await mcp.callTool({ name: "adder", arguments: { a: 20, b: 22 } });
    expect((r.content as { text: string }[])[0].text).toBe("42");
    const list = await mcp.callTool({ name: "anvil_list_agents", arguments: {} });
    expect(JSON.stringify(list.structuredContent)).toContain("adder");
    const missing = await mcp.callTool({ name: "anvil_run_agent", arguments: { agentId: "nope" } });
    expect(missing.isError).toBe(true);
    await mcp.close();
  });

  it("serves over real stdio (embedded mode)", async () => {
    const dir = tmpDir();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("src/mcp-stdio.ts")],
      env: { ...(process.env as Record<string, string>), ANVIL_DATA_DIR: dir, ANVIL_URL: "http://127.0.0.1:9" },
      stderr: "ignore",
    });
    const mcp = new Client({ name: "stdio-test", version: "1" });
    await mcp.connect(transport);
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("anvil_build");
    expect(tools).toContain("support-triage-example"); // the bundled example is seeded into the fresh data dir
    await mcp.close();
  }, 60_000);
});
