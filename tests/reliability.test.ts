import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeAgent } from "../src/core/engine.js";
import type { AgentSpec, RunEvent } from "../src/core/types.js";
import { createAnvil } from "../src/runtime/anvil.js";
import { signWebhook, TriggerManager } from "../src/runtime/triggers.js";
import { apiTokenOk } from "../src/server/auth.js";
import { mountWebhooks } from "../src/server/webhooks.js";
import { anvilWith, FakeClient } from "./helpers.js";

/* A receiver: each path gives a list of answers (status codes), then 200. */
const hits: Record<string, number> = {};
const plan: Record<string, number[]> = {};
const headersSeen: http.IncomingHttpHeaders[] = [];
let receiver: http.Server;
let base = "";

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const p = req.url ?? "/";
      hits[p] = (hits[p] ?? 0) + 1;
      headersSeen.push(req.headers);
      const status = plan[p]?.shift() ?? 200;
      res.writeHead(status).end(status === 200 ? "ok" : "no");
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
afterAll(() => receiver.close());

const policy = { maxCostUsd: 1, maxNodeExecutions: 50, timeoutMs: 60_000, requireApprovalForSideEffects: false };

/** input → calc → send (a webhook) → [hold (a person)] → output */
const sendSpec = (id: string, url: string, opts: { hold?: boolean; retry?: { maxAttempts: number; backoffMs: number } } = {}): AgentSpec => ({
  specVersion: "anvil/v1",
  id,
  name: id,
  description: "",
  version: 1,
  inputSchema: { type: "object", properties: { n: { type: "number", default: 1 } } },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "calc", type: "code", config: { code: "return { v: input.n * 2 }" } },
    { id: "send", type: "send_webhook", config: { url, body: { v: "{{nodes.calc.output.v}}" } }, ...(opts.retry ? { retry: opts.retry } : {}) },
    ...(opts.hold ? [{ id: "hold", type: "human_approval", config: { title: "hold" } }] : []),
    { id: "output", type: "output", config: { value: "{{nodes.calc.output}}" } },
  ],
  edges: [
    { from: "input", to: "calc" },
    { from: "calc", to: "send" },
    ...(opts.hold
      ? [
          { from: "send", to: "hold" },
          { from: "hold", to: "output", port: "approved" },
        ]
      : [{ from: "send", to: "output" }]),
  ],
  policy,
  tests: [],
  meta: {},
});

const waitFor = async (ok: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 400 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 10));
  expect(await ok()).toBe(true);
};

const execute = (anvil: Awaited<ReturnType<typeof anvilWith>>, spec: AgentSpec, runId: string, events: RunEvent[] = []) =>
  executeAgent(
    spec,
    { n: 2 },
    { registry: anvil.registry, brain: anvil.runs.brain, services: anvil.runs.services, maxParallel: 2 },
    { runId, emit: (e) => events.push(e), waitForHuman: async () => ({ approved: true }) },
  );

describe("side effects (docs/EFFECTS.md)", () => {
  it("does not retry a send that reached the receiver and failed", async () => {
    const anvil = await anvilWith(new FakeClient());
    plan["/e500"] = [500];
    const r = await execute(anvil, sendSpec("e500", `${base}/e500`, { retry: { maxAttempts: 3, backoffMs: 1 } }), "run-e500");
    expect(r.status).toBe("failed");
    expect(hits["/e500"]).toBe(1);
  });

  it("retries a send that did not go out (429)", async () => {
    const anvil = await anvilWith(new FakeClient());
    plan["/e429"] = [429];
    const r = await execute(anvil, sendSpec("e429", `${base}/e429`, { retry: { maxAttempts: 2, backoffMs: 1 } }), "run-e429");
    expect(r.status).toBe("completed");
    expect(hits["/e429"]).toBe(2);
  });

  it("sends an Idempotency-Key that stays the same for the same action of a run", async () => {
    const anvil = await anvilWith(new FakeClient());
    headersSeen.length = 0;
    await execute(anvil, sendSpec("key", `${base}/key`), "run-key");
    expect(headersSeen.at(-1)?.["idempotency-key"]).toBe("anvil-run-key-send");
  });

  it("does not send again when the same run executes again, and gives the recorded result", async () => {
    const anvil = await anvilWith(new FakeClient());
    const spec = sendSpec("once", `${base}/once`);
    const first = await execute(anvil, spec, "run-once");
    const events: RunEvent[] = [];
    const second = await execute(anvil, spec, "run-once", events);
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    expect(hits["/once"]).toBe(1);
    expect(second.nodeOutputs.send).toEqual(first.nodeOutputs.send);
    expect(events.some((e) => e.type === "log" && /already done in this run/.test(e.message))).toBe(true);
    // Another run sends.
    await execute(anvil, spec, "run-other");
    expect(hits["/once"]).toBe(2);
  });

  it("does not send again when an earlier send of the run has no clear result", async () => {
    const anvil = await anvilWith(new FakeClient());
    plan["/unclear"] = [503];
    const spec = sendSpec("unclear", `${base}/unclear`);
    expect((await execute(anvil, spec, "run-unclear")).status).toBe("failed");
    const again = await execute(anvil, spec, "run-unclear");
    expect(again.status).toBe("failed");
    expect(again.error).toMatch(/did not give a clear result/);
    expect(hits["/unclear"]).toBe(1);
  });

  it("keeps no record in an evaluation run", async () => {
    const anvil = await anvilWith(new FakeClient());
    const deps = { registry: anvil.registry, brain: anvil.runs.brain, services: { ...anvil.runs.services, runKind: "eval" as const }, maxParallel: 2 };
    const r = await executeAgent(sendSpec("dry", `${base}/dry`), { n: 1 }, deps, { runId: "run-dry", emit: () => undefined, waitForHuman: async () => ({}) });
    expect(r.nodeOutputs.send).toMatchObject({ dryRun: true });
    expect(await anvil.store.list("effects")).toEqual({});
  });
});

describe("recovery of a waiting run (docs/RECOVERY.md)", () => {
  it("starts a waiting run again after a restart, replays the finished steps, and does not send again", async () => {
    const client = new FakeClient();
    const first = await createAnvil({ client, config: { dataDir: client.config.dataDir, maxParallel: 4 } });
    await first.store.saveVersion(sendSpec("wait", `${base}/wait`, { hold: true }), { note: "t" });
    const rec = first.runs.start({ agentId: "wait" }, { n: 4 });
    await waitFor(() => first.runs.pendingRequests(rec.id).length > 0);
    expect(hits["/wait"]).toBe(1);
    const file = path.join(client.config.dataDir, "runs", `${rec.id}.json`);
    await waitFor(() => fs.existsSync(file) && !!JSON.parse(fs.readFileSync(file, "utf8")).checkpoint);

    // The server stops: its process is gone. A new server loads the store.
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.status).toBe("waiting");
    expect(Object.keys(saved.checkpoint.nodes).sort()).toEqual(["calc", "input", "send"]);
    fs.writeFileSync(file, JSON.stringify({ ...saved, pid: 2 ** 22 + 12345 }));
    const second = await createAnvil({ client, config: { dataDir: client.config.dataDir, maxParallel: 4 } });
    expect(second.store.listRuns().find((r) => r.id === rec.id)?.status).toBe("waiting");
    expect(await second.runs.recover()).toEqual([rec.id]);
    await waitFor(() => second.runs.pendingRequests(rec.id).length > 0);
    expect(second.runs.resume(rec.id, "hold", { approved: true })).toBe(true);
    const done = await second.runs.waitForRun(rec.id);
    expect(done?.status).toBe("completed");
    expect(done?.output).toEqual({ v: 8 });
    expect(done?.checkpoint).toBeUndefined();
    expect(hits["/wait"]).toBe(1);
    expect(done?.events.some((e) => e.type === "log" && /recovered after a restart/.test(e.message))).toBe(true);
    // The finished steps replay from the checkpoint: the send step does not run again.
    const replayed = done!.events.flatMap((e) => (e.type === "log" && /^replayed/.test(e.message) ? [e.nodeId] : []));
    expect(replayed.sort()).toEqual(["calc", "input", "send"]);
    first.runs.cancel(rec.id);
  });

  it("marks a running run (not waiting) as interrupted", async () => {
    const client = new FakeClient();
    const a = await createAnvil({ client, config: { dataDir: client.config.dataDir } });
    const dir = path.join(client.config.dataDir, "runs");
    fs.mkdirSync(dir, { recursive: true });
    const stale = {
      id: "run_stale",
      pid: 2 ** 22 + 54321,
      agentId: "x",
      agentName: "x",
      version: 1,
      kind: "run",
      status: "running",
      input: {},
      startedAt: 1,
      usage: {},
      nodeStates: {},
      events: [],
    };
    fs.writeFileSync(path.join(dir, "run_stale.json"), JSON.stringify(stale));
    void a;
    const b = await createAnvil({ client, config: { dataDir: client.config.dataDir } });
    expect((await b.store.getRun("run_stale"))?.status).toBe("failed");
    expect(await b.runs.recover()).toEqual([]);
  });
});

describe("webhook HTTP entry (docs/TRIGGERS.md)", () => {
  const webhookSpec = (id: string): AgentSpec => ({ ...sendSpec(id, `${base}/hook-${id}`), triggers: [{ id: "in", type: "webhook", respond: false, enabled: true }] });

  async function app(maxBodyBytes = 200) {
    const anvil = await anvilWith(new FakeClient());
    await anvil.store.saveVersion(webhookSpec("wh"), { note: "t" });
    const triggers = new TriggerManager({ store: anvil.store, runs: anvil.runs });
    await triggers.load();
    const hono = new Hono();
    mountWebhooks(hono, triggers, maxBodyBytes);
    return { hono, triggers, secret: await triggers.webhookToken("wh", "in") };
  }

  it("rejects a body over the limit, a JSON body that is not valid, and a token in the URL", async () => {
    const { hono, secret } = await app();
    const big = await hono.request("/api/hooks/wh/in", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anvil-token": secret },
      body: JSON.stringify({ x: "y".repeat(500) }),
    });
    expect(big.status).toBe(413);
    const bad = await hono.request("/api/hooks/wh/in", { method: "POST", headers: { "content-type": "application/json", "x-anvil-token": secret }, body: "{nope" });
    expect(bad.status).toBe(400);
    const query = await hono.request(`/api/hooks/wh/in?token=${secret}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(query.status).toBe(401);
  });

  it("accepts a signed request of the raw body", async () => {
    const { hono, secret } = await app();
    const body = '{"n":5}';
    const ts = String(Math.floor(Date.now() / 1000));
    const ok = await hono.request("/api/hooks/wh/in", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anvil-timestamp": ts, "x-anvil-signature": signWebhook(secret, ts, body) },
      body,
    });
    expect(ok.status).toBe(202);
    expect(await ok.json()).toHaveProperty("runId");
  });
});

describe("the API token in a URL", () => {
  it("is accepted only for an event stream", () => {
    const h = () => undefined;
    expect(apiTokenOk("s3cret", "/api/runs/r/events", h, (q) => (q === "token" ? "s3cret" : undefined))).toBe(true);
    expect(apiTokenOk("s3cret", "/api/agents", h, (q) => (q === "token" ? "s3cret" : undefined))).toBe(false);
    expect(apiTokenOk("s3cret", "/api/runs/r/resume", h, (q) => (q === "token" ? "s3cret" : undefined))).toBe(false);
  });
});
