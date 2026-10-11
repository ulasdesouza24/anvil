import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeSchedule, nextCronTime, parseCron, parseEvery } from "../src/core/schedule.js";
import { parseFeed } from "../src/core/tools/feeds.js";
import type { AgentSpec, Trigger } from "../src/core/types.js";
import { validateSpec } from "../src/core/validator.js";
import { signWebhook, TriggerManager } from "../src/runtime/triggers.js";
import { anvilWith, FakeClient } from "./helpers.js";

const spec = (id: string, triggers: Trigger[] = [], extraNodes: AgentSpec["nodes"] = []): AgentSpec => ({
  specVersion: "anvil/v1",
  id,
  name: id,
  description: "",
  version: 1,
  inputSchema: { type: "object", properties: { n: { type: "number", default: 1 }, title: { type: "string" } } },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "calc", type: "code", config: { code: "return { v: (input.n || 0) * 2, title: input.title || null }" } },
    ...extraNodes,
    { id: "output", type: "output", config: { value: "{{nodes.calc.output}}" } },
  ],
  edges: [
    { from: "input", to: "calc" },
    ...(extraNodes.length
      ? [
          { from: "calc", to: extraNodes[0].id },
          { from: extraNodes[0].id, to: "output", port: "approved" },
        ]
      : [{ from: "calc", to: "output" }]),
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 50, timeoutMs: 60_000, requireApprovalForSideEffects: false },
  tests: [],
  triggers,
  meta: {},
});

let feedXml = "";
let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((_req, res) => res.writeHead(200, { "Content-Type": "application/rss+xml" }).end(feedXml));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const rss = (items: { id: string; title: string }[]) =>
  `<?xml version="1.0"?><rss><channel><title>T</title>${items.map((i) => `<item><title><![CDATA[${i.title}]]></title><link>https://x.test/${i.id}</link><guid>${i.id}</guid><description>&lt;p&gt;hi&lt;/p&gt;</description></item>`).join("")}</channel></rss>`;

async function setup(specs: AgentSpec[]) {
  const anvil = await anvilWith(new FakeClient());
  for (const s of specs) await anvil.store.saveVersion(s, { note: "t" });
  let clock = Date.parse("2026-09-26T10:00:00Z"); // a Saturday
  const mgr = new TriggerManager({ store: anvil.store, runs: anvil.runs, now: () => clock });
  await mgr.load();
  const unsub = anvil.runs.onFinished(() => undefined);
  unsub();
  return { anvil, mgr, advance: (ms: number) => (clock += ms), now: () => clock };
}

const waitFor = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(ok()).toBe(true);
};

const settle = async (anvil: Awaited<ReturnType<typeof anvilWith>>, agentId?: string) => {
  for (let i = 0; i < 100; i++) {
    const active = anvil.store.listAgents().flatMap((a) => anvil.runs.activeRunsOf(agentId ?? a.id));
    if (!active.length) return;
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("schedule primitives", () => {
  it("parses intervals and cron, and computes the next time in a timezone", () => {
    expect(parseEvery("15m")).toBe(900_000);
    expect(parseEvery("2 hours")).toBe(7_200_000);
    expect(() => parseEvery("soon")).toThrow();
    const sat = Date.parse("2026-09-26T10:00:00Z");
    // Weekdays 09:00 Istanbul (UTC+3) → Monday 06:00Z
    expect(new Date(nextCronTime("0 9 * * MON-FRI", sat, "Europe/Istanbul")).toISOString()).toBe("2026-09-28T06:00:00.000Z");
    expect(new Date(nextCronTime("*/15 * * * *", Date.parse("2026-09-26T10:07:30Z"), "UTC")).toISOString()).toBe("2026-09-26T10:15:00.000Z");
    expect(new Date(nextCronTime("@daily", sat, "UTC")).toISOString()).toBe("2026-09-27T00:00:00.000Z");
    expect(new Date(nextCronTime("0 12 1 * *", sat, "UTC")).toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(() => parseCron("61 * * * *")).toThrow(/out of range/);
    expect(describeSchedule({ cron: "0 9 * * 1-5", timezone: "Europe/Istanbul" })).toBe("weekdays at 09:00 (Europe/Istanbul)");
  });

  it("parses RSS and Atom", () => {
    const r = parseFeed(rss([{ id: "a", title: "Hello & <b>bye</b>" }]));
    expect(r.items[0]).toMatchObject({ id: "a", link: "https://x.test/a", summary: "hi" });
    const atom = parseFeed(
      `<feed><title>F</title><entry><id>urn:1</id><title>E1</title><link href="https://e.test/1"/><updated>2026-01-01</updated><summary>S</summary></entry></feed>`,
    );
    expect(atom.items[0]).toMatchObject({ id: "urn:1", title: "E1", link: "https://e.test/1", summary: "S" });
  });
});

describe("trigger validation", () => {
  it("catches bad schedules, roots, loops and unmapped required inputs", async () => {
    const anvil = await anvilWith(new FakeClient());
    const s = spec("v", [
      { id: "a", type: "schedule", cron: "0 9 * * *", every: "5m", enabled: true },
      { id: "b", type: "schedule", every: "10s", timezone: "Mars/Olympus", enabled: true },
      { id: "c", type: "webhook", respond: false, enabled: true, input: { n: "{{item.x}}" } },
      { id: "d", type: "agent", agentId: "v", on: "completed", enabled: true },
    ]);
    s.inputSchema = { type: "object", properties: { n: { type: "number" } }, required: ["n"] };
    const text = validateSpec(s, anvil.registry, { getAgent: (id) => anvil.store.getAgent(id) })
      .diagnostics.filter((d) => d.code === "TRIGGER")
      .map((d) => d.message)
      .join("\n");
    expect(text).toMatch(/exactly one of "cron" or "every"/);
    expect(text).toMatch(/minimum interval is 30s/);
    expect(text).toMatch(/unknown timezone/);
    expect(text).toMatch(/a webhook trigger can use/);
    expect(text).toMatch(/cannot trigger itself/);
    expect(text).toMatch(/empty input, but the agent requires n/);
  });
});

describe("trigger manager", () => {
  it("fires schedules when due and records the run", async () => {
    const { anvil, mgr, advance } = await setup([spec("sched", [{ id: "tick", type: "schedule", every: "1m", enabled: true, input: { n: 21 } }])]);
    await mgr.tick(); // computes nextAt
    expect(anvil.runs.activeRunsOf("sched").length).toBe(0);
    advance(61_000);
    await mgr.tick();
    await settle(anvil);
    const view = mgr.list("sched")[0];
    expect(view.state.fireCount).toBe(1);
    const rec = await anvil.runs.getRun(view.state.lastRunId!);
    expect(rec?.kind).toBe("trigger");
    expect(rec?.trigger).toMatchObject({ triggerId: "tick", type: "schedule" });
    expect(rec?.output).toEqual({ v: 42, title: null });
    // disabled → no fire
    await mgr.setEnabled("sched", "tick", false);
    advance(120_000);
    await mgr.tick();
    expect(mgr.list("sched")[0].state.fireCount).toBe(1);
  });

  it("queues an event while the run of its trigger is active, and starts it when the run ends", async () => {
    const approval = [{ id: "hold", type: "human_approval", config: { title: "hold" } }];
    const { anvil, mgr } = await setup([spec("slow", [{ id: "go", type: "webhook", respond: false, enabled: true }], approval)]);
    const first = await mgr.fireNow("slow", "go", { n: 1 });
    expect("run" in first).toBe(true);
    const second = await mgr.fireNow("slow", "go", { n: 2 });
    expect(second).toMatchObject({ queued: { position: 1 } });
    expect(mgr.list("slow")[0].state.queued).toBe(1);
    const firstId = (first as { run: { id: string } }).run.id;
    await waitFor(() => anvil.runs.pendingRequests(firstId).length > 0);
    anvil.runs.resume(firstId, "hold", { approved: true });
    await waitFor(() => mgr.list("slow")[0].state.fireCount === 2);
    expect(mgr.list("slow")[0].state.queued).toBe(0);
    const secondRun = mgr.list("slow")[0].state.lastRunId!;
    expect(secondRun).not.toBe(firstId);
    expect((await anvil.runs.getRun(secondRun))?.input).toEqual({ n: 2 });
    anvil.runs.cancel(secondRun);
  });

  it("rejects an event when the queue is full, and keeps one waiting event for a schedule", async () => {
    const approval = [{ id: "hold", type: "human_approval", config: { title: "hold" } }];
    const { anvil } = await setup([spec("full", [{ id: "go", type: "webhook", respond: false, enabled: true }], approval)]);
    const mgr = new TriggerManager({ store: anvil.store, runs: anvil.runs, config: { triggers: { queueMax: 1, queueTtlMs: 60_000 }, webhook: anvil.config.webhook } });
    await mgr.load();
    const first = await mgr.fireNow("full", "go", { n: 1 });
    expect(await mgr.fireNow("full", "go", { n: 2 })).toMatchObject({ queued: { position: 1 } });
    expect(await mgr.fireNow("full", "go", { n: 3 })).toEqual({ rejected: "queue_full" });
    expect(mgr.list("full")[0].state.skippedOverlap).toBe(1);
    anvil.runs.cancel((first as { run: { id: string } }).run.id);
  });

  it("keeps the queue on disk, so a new manager (a restart) starts the waiting event", async () => {
    const { anvil, now } = await setup([spec("disk", [{ id: "go", type: "webhook", respond: false, enabled: true }])]);
    // The state that a stopped server left: one event waits in the queue.
    await anvil.store.set("triggers", "disk:go", { fireCount: 0, skippedOverlap: 0, queue: [{ id: "evt_1", at: now(), natural: { n: 7 }, label: "webhook" }] });
    const fresh = new TriggerManager({ store: anvil.store, runs: anvil.runs, now });
    await fresh.load();
    await fresh.tick();
    await waitFor(() => fresh.list("disk")[0].state.fireCount === 1);
    expect(fresh.list("disk")[0].state.queued).toBe(0);
    const run = await anvil.runs.waitForRun(fresh.list("disk")[0].state.lastRunId!);
    expect(run?.input).toEqual({ n: 7 });
  });

  it("authenticates webhooks and maps the payload", async () => {
    const { anvil, mgr } = await setup([
      spec("hook", [{ id: "in", type: "webhook", respond: true, enabled: true, input: { n: "{{payload.amount}}", title: "{{headers.x-src}}" } }]),
    ]);
    const bad = await mgr.handleWebhook("hook", "in", { rawBody: "{}", payload: {}, headers: { "x-anvil-token": "nope" }, query: {} });
    expect(bad.status).toBe(401);
    const token = await mgr.webhookToken("hook", "in");
    const ok = await mgr.handleWebhook("hook", "in", { rawBody: '{"amount":5}', payload: { amount: 5 }, headers: { "x-anvil-token": token, "x-src": "shop" }, query: {} });
    expect(ok.status).toBe(200);
    expect((ok.body as { output: unknown }).output).toEqual({ v: 10, title: "shop" });
    await settle(anvil);
  });

  it("checks the HMAC signature, the time window, and replays of a signed webhook", async () => {
    const { anvil, mgr, now } = await setup([spec("signed", [{ id: "in", type: "webhook", respond: false, enabled: true }])]);
    const secret = await mgr.webhookToken("signed", "in");
    const body = '{"n":3}';
    const ts = String(Math.floor(now() / 1000));
    const headers = { "x-anvil-timestamp": ts, "x-anvil-signature": signWebhook(secret, ts, body) };
    const ok = await mgr.handleWebhook("signed", "in", { rawBody: body, payload: { n: 3 }, headers, query: {} });
    expect(ok.status).toBe(202);
    await settle(anvil);
    expect((await mgr.handleWebhook("signed", "in", { rawBody: body, payload: { n: 3 }, headers, query: {} })).status).toBe(409);
    const changed = await mgr.handleWebhook("signed", "in", { rawBody: '{"n":4}', payload: { n: 4 }, headers, query: {} });
    expect(changed).toMatchObject({ status: 401, body: { error: "invalid signature" } });
    const oldTs = String(Math.floor(now() / 1000) - 3600);
    const stale = await mgr.handleWebhook("signed", "in", {
      rawBody: body,
      payload: {},
      headers: { "x-anvil-timestamp": oldTs, "x-anvil-signature": signWebhook(secret, oldTs, body) },
      query: {},
    });
    expect(stale.status).toBe(401);
    expect((stale.body as { error: string }).error).toMatch(/time window/);
  });

  it("accepts only signed webhooks in hmac mode", async () => {
    const { anvil } = await setup([spec("strict", [{ id: "in", type: "webhook", respond: false, enabled: true }])]);
    const mgr = new TriggerManager({ store: anvil.store, runs: anvil.runs, config: { triggers: anvil.config.triggers, webhook: { ...anvil.config.webhook, auth: "hmac" } } });
    await mgr.load();
    const secret = await mgr.webhookToken("strict", "in");
    const r = await mgr.handleWebhook("strict", "in", { rawBody: "{}", payload: {}, headers: { "x-anvil-token": secret }, query: {} });
    expect(r.status).toBe(401);
    expect((r.body as { error: string }).error).toMatch(/only signed/);
  });

  it("drops a second delivery with the same delivery id", async () => {
    const { anvil, mgr } = await setup([spec("dedupe", [{ id: "in", type: "webhook", respond: false, enabled: true }])]);
    const token = await mgr.webhookToken("dedupe", "in");
    const req = { rawBody: '{"n":1}', payload: { n: 1 }, headers: { "x-anvil-token": token, "Idempotency-Key": "order-42" }, query: {} };
    const first = await mgr.handleWebhook("dedupe", "in", req);
    expect(first.status).toBe(202);
    await settle(anvil);
    const again = await mgr.handleWebhook("dedupe", "in", req);
    expect(again).toMatchObject({ status: 200, body: { duplicate: true, runId: (first.body as { runId: string }).runId } });
    expect(mgr.list("dedupe")[0].state.fireCount).toBe(1);
  });

  it("polls RSS: skips existing items, then fires once per new item", async () => {
    feedXml = rss([{ id: "1", title: "old" }]);
    const { anvil, mgr, advance } = await setup([spec("feed", [])]);
    const s = spec("feed", [
      {
        id: "posts",
        type: "poll",
        source: { kind: "rss", url: `${base}/feed` },
        every: "1m",
        skipExisting: true,
        maxPerCheck: 5,
        enabled: true,
        input: { title: "{{item.title}}" },
      },
    ]);
    await anvil.store.saveVersion(s, { note: "t" });
    await mgr.tick();
    expect(mgr.list("feed")[0].state.fireCount).toBe(0);
    feedXml = rss([
      { id: "3", title: "newest" },
      { id: "2", title: "newer" },
      { id: "1", title: "old" },
    ]);
    advance(30_000);
    await mgr.tick(); // too soon
    expect(mgr.list("feed")[0].state.fireCount).toBe(0);
    advance(31_000);
    await mgr.tick();
    await settle(anvil);
    const fired = mgr.list("feed")[0].state;
    expect(fired.fireCount).toBe(2); // processed one at a time — none lost
    const last = await anvil.runs.getRun(fired.lastRunId!);
    expect((last?.output as { title: string }).title).toBe("newest"); // oldest first → newest last
    advance(61_000);
    await mgr.tick();
    expect(mgr.list("feed")[0].state.fireCount).toBe(2); // nothing new
  });

  it("chains agents on completion and stops runaway loops", async () => {
    const { anvil, mgr } = await setup([
      spec("ping", [{ id: "from_pong", type: "agent", agentId: "pong", on: "completed", enabled: true, input: { n: "{{output.v}}" } }]),
      spec("pong", [{ id: "from_ping", type: "agent", agentId: "ping", on: "completed", enabled: true, input: { n: "{{output.v}}" } }]),
    ]);
    await mgr.start();
    await anvil.runs.run({ agentId: "ping" }, { n: 1 });
    for (let i = 0; i < 200; i++) {
      await settle(anvil);
      await new Promise((r) => setTimeout(r, 5));
    }
    mgr.stop();
    const total = mgr.list().reduce((a, v) => a + v.state.fireCount, 0);
    expect(total).toBe(5); // depth-limited
    const lastPing = await anvil.runs.getRun(mgr.list("ping")[0].state.lastRunId!);
    expect(lastPing?.trigger?.chainDepth).toBeGreaterThan(1);
  });
});
