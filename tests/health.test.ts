import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { causeOf, HealthService } from "../src/runtime/health.js";
import type { AgentSpec, EvaluationReport } from "../src/core/types.js";
import { anvilWith, FakeClient } from "./helpers.js";

let server: http.Server;
let base = "";
let broken = false;
beforeAll(async () => {
  server = http.createServer((_req, res) => {
    if (broken) return res.writeHead(503, { "Content-Type": "text/plain" }).end("down for maintenance");
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ rate: 32.5 }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

/** A live data agent: it reads a rate from a source, and its test checks the rate. */
const rateAgent = (): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "rate-reader",
  name: "Rate reader",
  description: "Reads the rate from the source.",
  version: 1,
  inputSchema: { type: "object", properties: {} },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "get", type: "http", config: { url: `${base}/rate` } },
    { id: "output", type: "output", config: { value: { rate: "{{nodes.get.output.body.rate}}" } } },
  ],
  edges: [
    { from: "input", to: "get" },
    { from: "get", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 20_000, requireApprovalForSideEffects: false },
  tests: [{ id: "t1", name: "gives the rate", input: {}, criteria: [], checks: [{ path: "rate", op: "type", value: "number" }] }],
  meta: {},
});

const config = { everyMs: 86_400_000, minScore: 0.6, maxDrop: 0.25, budgetUsd: 1, evolve: false, historyMax: 5 };

describe("health checks", () => {
  it("a live data agent is healthy, and it is broken after its source breaks, with the cause", async () => {
    broken = false;
    const anvil = await anvilWith(new FakeClient());
    await anvil.store.saveVersion(rateAgent(), { note: "test", score: 1 });
    const health = new HealthService({ store: anvil.store, kv: anvil.store, runs: anvil.runs, config });
    expect(health.liveAgents().map((a) => a.id)).toEqual(["rate-reader"]);

    const ok = await health.check("rate-reader");
    expect(ok.status).toBe("healthy");
    expect(ok.last).toMatchObject({ status: "healthy", score: 1, baseline: 1, failed: [] });

    broken = true;
    const bad = await health.check("rate-reader");
    expect(bad.status).toBe("broken");
    expect(bad.last?.cause).toMatch(/the score 0 is below 0.6/);
    expect(bad.last?.cause).toMatch(/gives the rate/);
    expect(bad.history.map((h) => h.status)).toEqual(["broken", "healthy"]);
    expect((await health.list()).map((h) => [h.agentId, h.status])).toEqual([["rate-reader", "broken"]]);
  });

  it("checks only due agents, keeps the history short, and skips agents without live data or tests", async () => {
    broken = false;
    const anvil = await anvilWith(new FakeClient());
    await anvil.store.saveVersion(rateAgent(), { note: "test", score: 1 });
    await anvil.store.saveVersion({ ...rateAgent(), id: "offline", nodes: [{ id: "input", type: "input", config: {} }, { id: "output", type: "output", config: { value: { rate: 1 } } }], edges: [{ from: "input", to: "output" }] }, { note: "test" });
    await anvil.store.saveVersion({ ...rateAgent(), id: "untested", tests: [] }, { note: "test" });
    const health = new HealthService({ store: anvil.store, kv: anvil.store, runs: anvil.runs, config: { ...config, historyMax: 2 } });
    expect(health.liveAgents().map((a) => a.id)).toEqual(["rate-reader"]);
    const t0 = Date.now();
    expect(await health.tick(t0)).toEqual(["rate-reader"]);
    expect(await health.tick(t0 + 1000)).toEqual([]);
    await health.tick(t0 + config.everyMs + 1);
    await health.tick(t0 + 2 * config.everyMs + 2);
    expect((await health.get("rate-reader")).history).toHaveLength(2);
  });

  it("a large fall from the baseline is broken, and a check that the environment stopped keeps the status", async () => {
    const anvil = await anvilWith(new FakeClient());
    await anvil.store.saveVersion(rateAgent(), { note: "test", score: 0.95 });
    const report = (score: number, environment?: string): EvaluationReport =>
      ({ version: 1, passRate: score, score, costUsd: 0, at: 0, results: [{ testId: "t1", name: "gives the rate", passed: score > 0.9, score, criteria: [], checks: [], costUsd: 0, durationMs: 0, ...(environment ? { environment } : {}) }] }) as EvaluationReport;
    let next = report(0.65);
    const health = new HealthService({ store: anvil.store, kv: anvil.store, runs: anvil.runs, config, evaluate: async () => next });
    expect((await health.check("rate-reader")).last?.cause).toMatch(/the score fell from 0.95 to 0.65/);
    next = report(0, "a source refused more requests (rate limit)");
    const h = await health.check("rate-reader");
    expect(h.status).toBe("broken");
    expect(h.last).toMatchObject({ score: null, cause: expect.stringMatching(/^not measured: a source refused/) });
  });

  it("a broken agent starts one evolve run that saves a draft version", async () => {
    const anvil = await anvilWith(new FakeClient());
    await anvil.store.saveVersion(rateAgent(), { note: "test", score: 1 });
    const started: unknown[] = [];
    const runs = Object.create(anvil.runs) as typeof anvil.runs;
    runs.start = ((ref: unknown, input: unknown) => (started.push({ ref, input }), { id: "run_fix" })) as never;
    const bad = { version: 1, passRate: 0, score: 0, costUsd: 0, at: 0, results: [{ testId: "t1", name: "gives the rate", passed: false, score: 0, error: "HTTP 503", criteria: [], checks: [], costUsd: 0, durationMs: 0 }] } as EvaluationReport;
    const health = new HealthService({ store: anvil.store, kv: anvil.store, runs, config: { ...config, evolve: true }, evaluate: async () => bad });
    const h = await health.check("rate-reader");
    expect(h.last?.fixRunId).toBe("run_fix");
    expect(started).toEqual([{ ref: { agentId: "anvil-evolver" }, input: { agentId: "rate-reader", rounds: 2, draft: true } }]);
    // The agent is still broken in the next check: no second fix run.
    await health.check("rate-reader");
    expect(started).toHaveLength(1);
    expect(causeOf(bad)).toBe("1 of 1 test(s) failed. gives the rate: HTTP 503");
  });

  it("a draft version does not change the current version", async () => {
    const anvil = await anvilWith(new FakeClient());
    await anvil.store.saveVersion(rateAgent(), { note: "v1" });
    const saved = await anvil.store.saveVersion({ ...rateAgent(), name: "Rate reader 2" }, { note: "draft", keepCurrent: true });
    expect(saved.currentVersion).toBe(1);
    expect(saved.name).toBe("Rate reader");
    expect(saved.versions.map((v) => v.version)).toEqual([1, 2]);
  });
});
