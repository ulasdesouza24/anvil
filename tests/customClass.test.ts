import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateClassDef } from "../src/core/customClass.js";
import type { AgentSpec } from "../src/core/types.js";
import { validateSpec } from "../src/core/validator.js";
import { anvilWith, FakeClient } from "./helpers.js";

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.headers.authorization !== "Bearer s3cr3t-token") {
      res.writeHead(401).end("bad token s3cr3t-token");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: { city: url.searchParams.get("q"), temp_c: 21.5 } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.TEST_TOKEN = "s3cr3t-token";
});
afterAll(() => server.close());

const slugDef = {
  type: "x_slugify",
  title: "Slugify",
  category: "data",
  description: "Turns a title into a URL slug.",
  whenToUse: "Building URLs from titles.",
  configSchema: { type: "object", properties: { text: { type: "string" }, sep: { type: "string", default: "-" } }, required: ["text"] },
  outputSchema: { type: "object", properties: { slug: { type: "string" } }, required: ["slug"] },
  example: { text: "Hello World" },
  impl: { kind: "code", code: "return { slug: config.text.toLowerCase().trim().replace(/[^a-z0-9]+/g, config.sep).replace(/^-|-$/g, '') }" },
  tests: [{ name: "basic", config: { text: "Hello, World!" }, checks: [{ path: "slug", op: "equals", value: "hello-world" }] }],
};

const agentUsing = (type: string, config: Record<string, unknown>, field: string): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "uses-class",
  name: "uses",
  description: "",
  version: 1,
  inputSchema: { type: "object", properties: { t: { type: "string" } } },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "c", type, config },
    { id: "output", type: "output", config: { value: `{{nodes.c.output.${field}}}` } },
  ],
  edges: [
    { from: "input", to: "c" },
    { from: "c", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 50, timeoutMs: 60_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
});

describe("custom classes", () => {
  it("validates, tests for real, registers, and runs a code class inside an agent", async () => {
    const anvil = await anvilWith(new FakeClient());
    const r = await anvil.classes.save(slugDef, { brain: anvil.runs.brain });
    expect(r.def?.status).toBe("passed");
    expect(anvil.registry.get("x_slugify")?.custom?.kind).toBe("code");

    const spec = agentUsing("x_slugify", { text: "{{input.t}}" }, "slug");
    expect(validateSpec(spec, anvil.registry).valid).toBe(true);
    const rec = await anvil.runs.run({ spec }, { t: "Hello Big World" });
    expect(rec.output).toBe("hello-big-world");

    // The compiler knows the class's config keys and output fields.
    const bad = validateSpec(agentUsing("x_slugify", { txt: "{{input.t}}" }, "slugg"), anvil.registry);
    const codes = bad.diagnostics.map((d) => d.code);
    expect(codes).toContain("UNKNOWN_CONFIG_KEY");
    expect(codes).toContain("TEMPLATE_UNKNOWN_FIELD");
    expect(codes).toContain("INVALID_CONFIG"); // missing required "text"
  });

  it("runs http classes with secrets, shapes responses, and redacts secrets from errors", async () => {
    const anvil = await anvilWith(new FakeClient());
    const def = {
      type: "x_local_weather",
      title: "Local weather",
      category: "tool",
      description: "Gets weather for a city from the local test API.",
      whenToUse: "Weather lookups.",
      configSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      outputSchema: { type: "object", properties: { city: { type: "string" }, tempC: { type: "number" } } },
      secrets: ["TEST_TOKEN"],
      impl: {
        kind: "http",
        request: { method: "GET", url: `${base}/weather`, headers: { Authorization: "Bearer {{secrets.TEST_TOKEN}}" }, query: { q: "{{config.city}}" } },
        transform: "return { city: response.data.city, tempC: response.data.temp_c }",
      },
      tests: [{ name: "istanbul", config: { city: "Istanbul" }, checks: [{ path: "tempC", op: "type", value: "number" }] }],
    };
    const r = await anvil.classes.save(def, { brain: anvil.runs.brain });
    expect(r.def?.status).toBe("passed");
    const rec = await anvil.runs.run({ spec: agentUsing("x_local_weather", { city: "{{input.t}}" }, "tempC") }, { t: "Ankara" });
    expect(rec.output).toBe(21.5);

    process.env.TEST_TOKEN = "wrong-but-long-token";
    const failed = await anvil.runs.run({ spec: agentUsing("x_local_weather", { city: "x" }, "tempC") }, { t: "x" });
    expect(failed.status).toBe("failed");
    process.env.TEST_TOKEN = "s3cr3t-token";
    // The server echoes the real token in its 401 body; it must never reach traces.
    expect(JSON.stringify(failed.events)).not.toContain("wrong-but-long-token");
  });

  it("runs llm classes as schema-typed skills", async () => {
    const client = new FakeClient(() => JSON.stringify({ rewritten: "Dear customer, we apologize.", tone: "formal" }));
    const anvil = await anvilWith(client);
    const r = await anvil.classes.save(
      {
        type: "x_formalize",
        title: "Formalize",
        category: "ai",
        description: "Rewrites text in a formal tone.",
        whenToUse: "Tone changes.",
        configSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        outputSchema: { type: "object", properties: { rewritten: { type: "string" }, tone: { type: "string" } }, required: ["rewritten"] },
        impl: { kind: "llm", prompt: "Rewrite formally:\n{{config.text}}" },
        tests: [{ name: "t", config: { text: "sorry lol" }, checks: [{ path: "rewritten", op: "minLength", value: 5 }] }],
      },
      { brain: anvil.runs.brain },
    );
    expect(r.def?.status).toBe("passed");
    expect(String(client.chats.at(-1)?.messages.at(-1)?.content)).toContain("sorry lol");
  });

  it("rejects unsafe or inconsistent definitions", async () => {
    const anvil = await anvilWith(new FakeClient());
    const { diagnostics } = validateClassDef(
      {
        ...slugDef,
        type: "x_poster",
        impl: {
          kind: "http",
          request: { method: "POST", url: "https://api.example.com/{{config.missing}}", headers: { Authorization: "Bearer sk-live-123" }, body: { t: "{{secrets.NOPE}}" } },
        },
      },
      anvil.registry,
    );
    const text = diagnostics.map((d) => d.message).join("\n");
    expect(text).toMatch(/undeclared config field "missing"/);
    expect(text).toMatch(/undeclared secret "NOPE"/);
    expect(text).toMatch(/looks like a credential/);
    expect(text).toMatch(/sideEffects/);
    expect(validateClassDef({ ...slugDef, type: "llm" }, anvil.registry).diagnostics.length).toBeGreaterThan(0);
  });

  it("blocks model-written side-effect classes until a person approves them", async () => {
    const anvil = await anvilWith(new FakeClient());
    const def = {
      type: "x_notify",
      title: "Notify",
      category: "tool",
      description: "Posts a notification to the local API.",
      whenToUse: "Notifications.",
      configSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
      outputSchema: { type: "object", properties: { data: { type: "object" } } },
      sideEffects: true,
      secrets: ["TEST_TOKEN"],
      impl: { kind: "http", request: { method: "POST", url: `${base}/notify`, headers: { Authorization: "Bearer {{secrets.TEST_TOKEN}}" }, body: { msg: "{{config.msg}}" } } },
    };
    const r = await anvil.classes.save(def, { brain: anvil.runs.brain, createdBy: "anvil" });
    expect(r.def?.approved).toBe(false);
    expect(r.def?.status).toBe("untested");
    const spec = agentUsing("x_notify", { msg: "hi" }, "data");
    const blocked = await anvil.runs.run({ spec }, {});
    expect(blocked.error).toMatch(/not been approved/);
    await anvil.classes.approve("x_notify", true);
    const ok = await anvil.runs.run({ spec }, {});
    expect(ok.status).toBe("completed");
  });

  it("the classsmith meta-agent generates, tests and registers a class from a description", async () => {
    let calls = 0;
    const client = new FakeClient((req) => {
      calls++;
      // First attempt: a class whose test fails → the generator must repair it from the real test report.
      const bug = calls === 1;
      return JSON.stringify({ ...slugDef, type: "x_slug", impl: { kind: "code", code: bug ? "return { slug: config.text }" : slugDef.impl.code } });
    });
    const anvil = await anvilWith(client);
    const rec = await anvil.runs.run({ agentId: "anvil-classsmith" }, { request: "make URL slugs from titles" });
    expect(rec.status).toBe("completed");
    expect(rec.output).toMatchObject({ type: "x_slug", ok: true, status: "passed", attempts: 2 });
    expect(anvil.registry.get("x_slug")).toBeDefined();
    const repairPrompt = JSON.stringify(client.chats.at(-1)?.messages);
    expect(repairPrompt).toContain("tests FAILED");
  });

  it("map(mode=node) runs any class — including custom ones — per item", async () => {
    const anvil = await anvilWith(new FakeClient());
    await anvil.classes.save(slugDef, { brain: anvil.runs.brain });
    const spec: AgentSpec = {
      ...agentUsing("x_slugify", { text: "x" }, "slug"),
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "m", type: "map", config: { items: ["Hello World", "Anvil Rocks"], mode: "node", nodeType: "x_slugify", nodeConfig: { text: "{{item}}" } } },
        { id: "output", type: "output", config: { value: "{{nodes.m.output.results}}" } },
      ],
      edges: [
        { from: "input", to: "m" },
        { from: "m", to: "output" },
      ],
    };
    expect(validateSpec(spec, anvil.registry).valid).toBe(true);
    const rec = await anvil.runs.run({ spec }, {});
    expect(rec.output).toEqual([{ slug: "hello-world" }, { slug: "anvil-rocks" }]);
    const bad = validateSpec({ ...spec, nodes: spec.nodes.map((n) => (n.id === "m" ? { ...n, config: { ...n.config, nodeType: "human_approval" } } : n)) }, anvil.registry);
    expect(bad.valid).toBe(false);
  });
});
