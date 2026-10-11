import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseToolDefinitions, toolClassDraft, toolClassType } from "../src/core/toolDefs.js";
import type { AgentSpec } from "../src/core/types.js";
import { validateSpec } from "../src/core/validator.js";
import { createRegistry } from "../src/runtime/anvil.js";
import { toolDataPrompt } from "../src/builder/toolsStep.js";
import { anvilWith, FakeClient } from "./helpers.js";

let server: http.Server;
let base = "";
const seen: { method: string; url: string; body: string }[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body });
      const json = (code: number, v: unknown) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(v));
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname.startsWith("/orders/")) return json(200, { id: u.pathname.split("/")[2], status: "shipped", verbose: u.searchParams.get("verbose") });
      if (u.pathname === "/orders" && req.method === "POST") return json(201, { created: JSON.parse(body) });
      if (u.pathname === "/tools/get_weather") return json(200, { city: JSON.parse(body).city, temp: 21 });
      json(404, { error: "no" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const openapi = () => ({
  openapi: "3.0.0",
  servers: [{ url: base }],
  components: { schemas: { NewOrder: { type: "object", properties: { item: { type: "string" }, qty: { type: "integer" } }, required: ["item"] } } },
  paths: {
    "/orders/{id}": {
      get: {
        operationId: "getOrder",
        summary: "Get an order by id",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "verbose", in: "query", schema: { type: "boolean" } },
        ],
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" }, status: { type: "string" } } } } } } },
      },
    },
    "/orders": {
      post: {
        operationId: "createOrder",
        summary: "Create an order",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NewOrder" } } } },
        responses: { "201": { description: "created" } },
      },
    },
  },
});

describe("tool definitions", () => {
  it("reads an OpenAPI 3 document: parameters, the body with a $ref, the base URL, and side effects", () => {
    const tools = parseToolDefinitions(openapi());
    expect(tools.map((t) => [t.name, t.sideEffects])).toEqual([
      ["getOrder", false],
      ["createOrder", true],
    ]);
    expect(tools[0].parameters).toMatchObject({ properties: { id: { type: "string" }, verbose: { type: "boolean" } }, required: ["id"] });
    expect(tools[1].parameters).toMatchObject({ properties: { body: { properties: { item: { type: "string" } } } }, required: ["body"] });
    expect(tools[0].http).toMatchObject({ method: "GET", url: `${base}/orders/{id}`, path: ["id"], query: ["verbose"] });
  });

  it("reads YAML, OpenAI, Anthropic, and plain function definitions", () => {
    const yaml = `openapi: 3.0.0\nservers:\n  - url: https://api.example.com\npaths:\n  /ping:\n    get:\n      operationId: ping\n      responses:\n        "200":\n          description: ok\n`;
    expect(parseToolDefinitions(yaml)[0]).toMatchObject({ name: "ping", http: { url: "https://api.example.com/ping" } });
    const fns = parseToolDefinitions([
      { type: "function", function: { name: "get_weather", description: "Weather of a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } },
      { name: "cancel_booking", description: "Cancel a booking", input_schema: { type: "object", properties: { id: { type: "string" } } } },
      { name: "lookup", description: "Look up", parameters: { type: "object", properties: {} }, sideEffects: false },
    ]);
    expect(fns.map((t) => [t.name, t.sideEffects, Object.keys(t.parameters.properties ?? {})])).toEqual([
      ["get_weather", false, ["city"]],
      ["cancel_booking", true, ["id"]],
      ["lookup", false, []],
    ]);
    expect(parseToolDefinitions({ tools: [{ name: "a", description: "A tool" }] })).toHaveLength(1);
    expect(() => parseToolDefinitions({ swagger: "2.0" })).toThrow(/Swagger 2/);
    expect(() => parseToolDefinitions({ foo: 1 })).toThrow(/Unknown tool definition/);
    // Two tools with one name and different definitions get different classes.
    expect(toolClassType(fns[2])).not.toBe(toolClassType({ ...fns[2], parameters: { type: "object", properties: { q: { type: "string" } } } }));
  });

  it("an OpenAPI tool becomes an http class that calls the API", async () => {
    const anvil = await anvilWith(new FakeClient());
    const [getOrder, createOrder] = parseToolDefinitions(openapi()).map(toolClassDraft);
    for (const d of [getOrder, createOrder]) expect((await anvil.classes.save(d, { test: false, createdBy: "given" })).def?.approved).toBe(true);
    const get = anvil.registry.get(getOrder.type)!;
    const ctx = { ...anvil.runs.services, services: anvil.runs.services, brain: anvil.runs.brain, signal: new AbortController().signal, runId: "r1", log: () => undefined, emit: () => undefined } as never;
    const out = await get.execute({ ...(ctx as object), config: { id: "A-7", verbose: true } } as never);
    expect(out.output).toMatchObject({ id: "A-7", status: "shipped", verbose: "true" });
    const post = anvil.registry.get(createOrder.type)!;
    const created = await post.execute({ ...(ctx as object), config: { body: { item: "bolt", qty: 3 } } } as never);
    expect(created.output).toEqual({ result: { created: { item: "bolt", qty: 3 } } });
    expect(post.sideEffects?.({} as never)).toBe(true);
  });
});

describe("call adapters", () => {
  const exec = async (anvil: Awaited<ReturnType<typeof anvilWith>>, type: string, config: Record<string, unknown>, runId = "r1") => {
    const ctx = { services: anvil.runs.services, brain: anvil.runs.brain, signal: new AbortController().signal, runId, log: () => undefined, emit: () => undefined };
    return (await anvil.registry.get(type)!.execute({ ...ctx, config } as never)).output;
  };

  it("the http adapter posts the arguments to <ANVIL_TOOL_ENDPOINT>/<name>", async () => {
    const client = new FakeClient();
    client.config.tools = { ...client.config.tools, adapter: "http", endpoint: `${base}/tools` };
    const anvil = await anvilWith(client);
    const [d] = parseToolDefinitions([{ name: "get_weather", description: "Weather of a city", parameters: { type: "object", properties: { city: { type: "string" } } } }]).map(toolClassDraft);
    await anvil.classes.save(d, { test: false, createdBy: "given" });
    expect(await exec(anvil, d.type, { city: "Izmir" })).toEqual({ result: { city: "Izmir", temp: 21 } });
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/tools/get_weather", body: '{"city":"Izmir"}' });
  });

  it("the mock adapter keeps a state for each run", async () => {
    const client = new FakeClient();
    client.config.tools = { ...client.config.tools, adapter: "mock", endpoint: "" };
    const anvil = await anvilWith(client);
    const book = {
      name: "book_seat",
      description: "Book a seat",
      parameters: { type: "object", properties: { seat: { type: "string" } } },
      mock: "state.booked = state.booked || []; if (state.booked.includes(args.seat)) return { ok: false, reason: 'taken' }; state.booked.push(args.seat); return { ok: true, booked: state.booked.length };",
    };
    const [d] = parseToolDefinitions([book]).map(toolClassDraft);
    await anvil.classes.save(d, { test: false, createdBy: "given" });
    expect(await exec(anvil, d.type, { seat: "1A" }, "run-a")).toEqual({ result: { ok: true, booked: 1 } });
    expect(await exec(anvil, d.type, { seat: "1A" }, "run-a")).toEqual({ result: { ok: false, reason: "taken" } });
    // Another run has its own state.
    expect(await exec(anvil, d.type, { seat: "1A" }, "run-b")).toEqual({ result: { ok: true, booked: 1 } });
  });
});

describe("a closed build", () => {
  it("the tools step saves the given tools as classes and closes the build", async () => {
    const anvil = await anvilWith(new FakeClient());
    const spec: AgentSpec = {
      specVersion: "anvil/v1",
      id: "t",
      name: "t",
      description: "",
      version: 1,
      inputSchema: { type: "object", properties: {} },
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "tools", type: "anvil_tools", config: { tools: "{{input.tools}}" } },
        { id: "output", type: "output", config: { value: "{{nodes.tools.output}}" } },
      ],
      edges: [
        { from: "input", to: "tools" },
        { from: "tools", to: "output" },
      ],
      policy: { maxCostUsd: 1, maxNodeExecutions: 10, timeoutMs: 10_000, requireApprovalForSideEffects: false },
      tests: [],
      meta: {},
    };
    const r = await anvil.runs.run({ spec }, { tools: openapi() });
    expect(r.output).toMatchObject({ closed: true, tools: [{ name: "getOrder", sideEffects: false }, { name: "createOrder", sideEffects: true }] });
    const open = await anvil.runs.run({ spec }, {});
    expect(open.output).toEqual({ closed: false, tools: [] });
  });

  it("the compiler rejects web steps, web tools, and classes that are not given", () => {
    const spec = (nodes: AgentSpec["nodes"]): AgentSpec => ({
      specVersion: "anvil/v1",
      id: "c",
      name: "c",
      description: "",
      version: 1,
      inputSchema: { type: "object", properties: {} },
      nodes: [{ id: "input", type: "input", config: {} }, ...nodes, { id: "output", type: "output", config: { value: { ok: true } } }],
      edges: [{ from: "input", to: nodes[0].id }, { from: nodes[0].id, to: "output" }],
      policy: { maxCostUsd: 1, maxNodeExecutions: 10, timeoutMs: 10_000, requireApprovalForSideEffects: false },
      tests: [],
      meta: { givenTools: ["x_tool_get_order_abc123"] },
    });
    const codes = (s: AgentSpec) => validateSpec(s, createRegistry()).diagnostics.filter((d) => d.code === "CLOSED_TOOLS").map((d) => d.message);
    expect(codes(spec([{ id: "s", type: "web_search", config: { query: "x" } }]))).toEqual(['s: "web_search" reaches the web, but the agent may use only its given tools']);
    expect(codes(spec([{ id: "a", type: "agent", config: { task: "Do it.", tools: ["fetch_url"], classes: ["x_tool_other_000000"] } }]))).toEqual([
      'a: the tool "fetch_url" reaches the web',
      'a: the class "x_tool_other_000000" is not a given tool',
    ]);
    expect(codes(spec([{ id: "a", type: "agent", config: { task: "Do it.", tools: ["calculator"], classes: ["x_tool_get_order_abc123"] } }]))).toEqual([]);
  });

  it("an agent step calls a given tool as a function", async () => {
    let step = 0;
    const client = new FakeClient((req) => {
      step++;
      if (step === 1) return { content: "", toolCalls: [{ id: "c1", type: "function", function: { name: req.tools!.find((t) => t.function.name.startsWith("x_tool_getorder"))!.function.name, arguments: '{"id":"B-9"}' } }] };
      return `The order ${JSON.parse(String(req.messages.at(-1)?.content).replace(/^[\s\S]*?(\{)/, "$1")).id} is shipped.`;
    });
    client.config.tools = { ...client.config.tools, adapter: "http", endpoint: "" };
    const anvil = await anvilWith(client);
    const [getOrder] = parseToolDefinitions(openapi()).map(toolClassDraft);
    await anvil.classes.save(getOrder, { test: false, createdBy: "given" });
    const spec: AgentSpec = {
      specVersion: "anvil/v1",
      id: "ag",
      name: "ag",
      description: "",
      version: 1,
      inputSchema: { type: "object", properties: {} },
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "a", type: "agent", config: { task: "Give the status of order B-9.", classes: [getOrder.type], style: "plain" } },
        { id: "output", type: "output", config: { value: { text: "{{nodes.a.output.answer}}" } } },
      ],
      edges: [
        { from: "input", to: "a" },
        { from: "a", to: "output" },
      ],
      policy: { maxCostUsd: 1, maxNodeExecutions: 10, timeoutMs: 20_000, requireApprovalForSideEffects: false },
      tests: [],
      meta: {},
    };
    const r = await anvil.runs.run({ spec }, {});
    expect(r.error).toBeUndefined();
    expect(r.output).toEqual({ text: "The order B-9 is shipped." });
    expect(seen.some((s) => s.url === "/orders/B-9")).toBe(true);
  });
});

describe("required arguments", () => {
  it("a required text argument of a tool cannot be empty", () => {
    const [d] = parseToolDefinitions([{ name: "get_order", description: "Gets an order", parameters: { type: "object", properties: { order_id: { type: "string" }, note: { type: "string" } }, required: ["order_id"] } }]).map(toolClassDraft);
    const props = (d.configSchema as { properties: Record<string, { minLength?: number }> }).properties;
    expect(props.order_id.minLength).toBe(1);
    expect(props.note.minLength).toBeUndefined();
  });
});

describe("tool data for testgen", () => {
  it("shows the start data of mock tools and the result of read-only tools without arguments", async () => {
    const client = new FakeClient();
    client.config.tools = { ...client.config.tools, adapter: "mock", endpoint: "" };
    const anvil = await anvilWith(client);
    const defs = parseToolDefinitions([
      { name: "list_flights", description: "Lists the flights", parameters: { type: "object", properties: {} }, sideEffects: false, mock: "return [{ flight: 'AN100' }, { flight: 'AN102' }];" },
      { name: "get_order", description: "Gets an order", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, mock: "return { id: args.id, known: ['A-100'] };" },
      { name: "cancel_order", description: "Cancels an order", parameters: { type: "object", properties: {} }, mock: "state.cancelled = true; return { ok: true };" },
    ]);
    const tools = [];
    for (const d of defs) {
      const draft = toolClassDraft(d);
      await anvil.classes.save(draft, { test: false, createdBy: "given" });
      tools.push({ type: draft.type, name: d.name, description: d.description, sideEffects: d.sideEffects, parameters: d.parameters, mock: d.mock });
    }
    const ctx = { services: anvil.runs.services, brain: anvil.runs.brain, signal: new AbortController().signal, runId: "probe", input: {}, log: () => undefined, emit: () => undefined };
    const text = await toolDataPrompt(ctx as never, { closed: true, tools }, 4000);
    expect(text).toMatch(/DATA THAT THE TOOLS KNOW/);
    expect(text).toContain("known: ['A-100']");
    // A read-only tool without arguments is called. A tool with side effects or with required arguments is not.
    expect(text).toContain('list_flights() gives: {"result":[{"flight":"AN100"},{"flight":"AN102"}]}');
    expect(text).not.toContain("cancel_order() gives");
    expect(text).not.toContain("get_order() gives");
    expect(await toolDataPrompt(ctx as never, { closed: false, tools: [] }, 4000)).toBe("");
  });
});
