import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { AGENT_TOOLS } from "../core/tools/agentTools.js";
import type { AgentSpec, RunEvent, RunRecord, StoredAgent } from "../core/types.js";
import { staticAllowlist } from "../core/tools/codeBridge.js";
import { validateSpec } from "../core/validator.js";
import { OpenRouterClient } from "../llm/openrouter.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { compareReports, listReports } from "../bench/runner.js";
import { createAnvil } from "../runtime/anvil.js";
import { allLessons, classifyLibrary, deleteLesson, exampleGate, knownDomains, taxonomyOf } from "../builder/library.js";
import { qualityOf } from "../core/quality.js";
import { createAnvilMcpServer, localBackend, toolNameFor } from "../runtime/mcpServer.js";
import { guardProcess } from "../runtime/processGuard.js";
import { apiTokenOk } from "./auth.js";
import { mountWebhooks } from "./webhooks.js";
import { SIGNATURE_HEADER, signWebhook, TIMESTAMP_HEADER } from "../runtime/triggers.js";
import { converse, isConversational, SessionService } from "../runtime/sessions.js";
import { HealthService } from "../runtime/health.js";
import { FeedbackService } from "../runtime/feedback.js";
import { sendSecretsOf } from "../core/nodes/send.js";
import { builderFor, checkModels } from "../builder/bestOf.js";
import { parseToolDefinitions } from "../core/toolDefs.js";
import { parseExternalTests } from "../core/externalTests.js";

guardProcess("server");

const anvil = await createAnvil();
const { store, runs, registry, config, classes, triggers, mcp, files, secrets } = anvil;
// The runs that waited for a person start again before the triggers, so a trigger sees them as active (docs/RECOVERY.md).
const recovered = await runs.recover();
if (recovered.length) console.log(`[runs] recovered ${recovered.length} waiting run(s) after the restart`);
await triggers.start();
void mcp.connectAll();
const sessions = new SessionService(store);
// Health checks of live data agents (docs/HEALTH.md).
const health = new HealthService({ store, kv: store, runs, config: config.health, log: (m) => console.log(m) });
health.start();
// Feedback becomes a test (docs/FEEDBACK.md).
const feedback = new FeedbackService({ store, kv: store, brain: runs.brain, runs });
const app = new Hono();

app.use("/api/*", cors({ origin: (o) => (o && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) ? o : null) }));

// The API token. Webhooks have their own token, and the health check is open.
app.use("/api/*", async (c, next) => {
  if (
    !apiTokenOk(
      config.apiToken,
      c.req.path,
      (h) => c.req.header(h),
      (q) => c.req.query(q),
    )
  )
    return c.json({ error: "unauthorized: give the API token (ANVIL_API_TOKEN)" }, 401);
  return next();
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

const summarizeAgent = (a: StoredAgent) => {
  const v = a.versions.find((x) => x.version === a.currentVersion);
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    system: !!a.system,
    currentVersion: a.currentVersion,
    versions: a.versions.length,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    score: v?.evaluation?.score ?? v?.score ?? null,
    passRate: v?.evaluation?.passRate ?? null,
    nodeCount: v?.spec.nodes.length ?? 0,
    nodeTypes: [...new Set(v?.spec.nodes.map((n) => n.type) ?? [])],
    tests: v?.spec.tests.length ?? 0,
    pattern: (v?.spec.meta?.pattern as string) ?? null,
    taxonomy: taxonomyOf(v?.spec) ?? null,
    quality: v?.evaluation ? qualityOf(v.evaluation) : "untested",
  };
};

const getAgent = (id: string) => store.getAgent(id);

/* --------------------------------- meta --------------------------------- */

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    keyConfigured: !!config.apiKey,
    models: { llm: config.llmModel, decision: config.decisionModel },
    tiers: config.tiers,
    providerSort: config.providerSort,
    providers: anvil.client instanceof OpenRouterClient ? anvil.client.health.snapshot() : null,
    agents: store.listAgents().length,
  }),
);

app.get("/api/registry", (c) =>
  c.json({
    classes: registry.manifest({ includeInternal: true }),
    tools: AGENT_TOOLS.map((t) => ({ name: t.name, description: t.description, sideEffects: t.sideEffects, parameters: t.parameters })),
  }),
);

/* -------------------------------- agents -------------------------------- */

app.get("/api/agents", (c) => c.json(store.listAgents().map(summarizeAgent)));

app.get("/api/agents/:id", (c) => {
  const a = store.getAgent(c.req.param("id"));
  return a ? c.json(a) : c.json({ error: "not found" }, 404);
});

app.get("/api/agents/:id/export", (c) => {
  const v = c.req.query("version");
  const spec = store.getSpec(c.req.param("id"), v ? Number(v) : undefined);
  if (!spec) return c.json({ error: "not found" }, 404);
  c.header("Content-Disposition", `attachment; filename="${spec.id}.v${spec.version}.anvil.json"`);
  return c.json(spec);
});

app.post("/api/validate", async (c) => {
  const { spec } = await c.req.json<{ spec: unknown }>();
  const system = (spec as { id?: string })?.id ? store.getAgent(String((spec as { id: string }).id))?.system : false;
  return c.json(validateSpec(spec, registry, { getAgent, allowInternal: !!system }));
});

/** Import a spec as a new agent. */
app.post("/api/agents", async (c) => {
  const { spec, note } = await c.req.json<{ spec: AgentSpec; note?: string }>();
  const r = validateSpec(spec, registry, { getAgent });
  if (!r.valid) return c.json({ error: "Spec has errors", diagnostics: r.diagnostics }, 400);
  const s = { ...r.spec!, id: store.uniqueId(r.spec!.id) };
  const saved = await store.saveVersion(s, { note: note ?? "imported" });
  return c.json(summarizeAgent(saved), 201);
});

/** Save an edited spec as a new version. */
app.put("/api/agents/:id", async (c) => {
  const id = c.req.param("id");
  const existing = store.getAgent(id);
  if (!existing) return c.json({ error: "not found" }, 404);
  if (existing.system) return c.json({ error: "System agents are defined in code (src/builder/systemAgents.ts)" }, 403);
  const { spec, note } = await c.req.json<{ spec: AgentSpec; note?: string }>();
  const r = validateSpec({ ...spec, id }, registry, { getAgent });
  if (!r.valid) return c.json({ error: "Spec has errors", diagnostics: r.diagnostics }, 400);
  const saved = await store.saveVersion({ ...r.spec!, id }, { note: note ?? "edited in Anvil UI" });
  return c.json(summarizeAgent(saved));
});

app.post("/api/agents/:id/current", async (c) => {
  const { version } = await c.req.json<{ version: number }>();
  return c.json(summarizeAgent(await store.setCurrentVersion(c.req.param("id"), version)));
});

app.delete("/api/agents/:id", async (c) => {
  const ok = await store.deleteAgent(c.req.param("id"));
  return ok ? c.json({ ok }) : c.json({ error: "not found or system agent" }, 400);
});

/* --------------------------------- runs --------------------------------- */

const runResponse = (r: RunRecord) => ({ runId: r.id, status: r.status, output: r.output, error: r.error, usage: r.usage, durationMs: (r.endedAt ?? Date.now()) - r.startedAt });

/** The instant API endpoint every built agent gets. */
app.post("/api/agents/:id/run", async (c) => {
  const id = c.req.param("id");
  if (!store.getAgent(id)) return c.json({ error: `agent "${id}" not found` }, 404);
  const body = await c.req.json<{ input?: unknown; version?: number; wait?: boolean }>().catch(() => ({}) as { input?: unknown; version?: number; wait?: boolean });
  const input = body.input ?? {};
  if (body.wait || c.req.query("wait") === "true") {
    const r = await runs.run({ agentId: id }, input, { version: body.version, kind: "run" });
    return c.json(runResponse(r), r.status === "completed" ? 200 : 422);
  }
  const r = runs.start({ agentId: id }, input, { version: body.version, kind: "run" });
  return c.json({ runId: r.id }, 202);
});

app.post("/api/build", async (c) => {
  const body = await c.req.json<{
    request: string;
    answers?: Record<string, string>;
    clarify?: boolean;
    evaluate?: boolean;
    optimize?: boolean;
    testCount?: number;
    useLibrary?: boolean;
    examples?: string[];
    excludeExamples?: string[];
    files?: string[];
    tools?: unknown;
    tests?: unknown;
    candidates?: unknown;
  }>();
  if (!body.request?.trim()) return c.json({ error: "request is required" }, 400);
  // Bad tool definitions fail here, before the build starts.
  if (body.tools !== undefined && body.tools !== null && body.tools !== "") {
    try {
      if (!parseToolDefinitions(body.tools).length) return c.json({ error: "The tool definitions give no tool" }, 400);
    } catch (e) {
      return c.json({ error: `tools: ${(e as Error).message}` }, 400);
    }
  }
  const unknown = (body.files ?? []).filter((id) => !files.get(id));
  if (unknown.length) return c.json({ error: `Unknown file id(s): ${unknown.join(", ")}. Upload the files with POST /api/files first.` }, 400);
  // Bad given tests fail here, before the build starts (docs/TESTS.md).
  if (body.tests !== undefined && body.tests !== null && body.tests !== "") {
    try {
      body.tests = parseExternalTests(body.tests, null);
    } catch (e) {
      return c.json({ error: `tests: ${(e as Error).message}` }, 400);
    }
  }
  // Best-of-N (docs/SELECTION.md): the request, or ANVIL_BEST_OF.
  let target: ReturnType<typeof builderFor>;
  try {
    target = builderFor(body.candidates, config.bestOf.enabled);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const r = runs.start({ agentId: target.agentId }, { ...body, ...(target.candidates ? { candidates: target.candidates } : { candidates: undefined }) }, { kind: "build" });
  return c.json({ runId: r.id }, 202);
});

// Health of live data agents (docs/HEALTH.md). These paths need the API token: only /api/health is open.
app.get("/api/health/agents", async (c) => c.json(await health.list()));
app.get("/api/health/agents/:id", async (c) => c.json(await health.get(c.req.param("id"))));
app.post("/api/health/agents/:id/check", async (c) => {
  try {
    return c.json(await health.check(c.req.param("id")));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// Secrets and host headers from the UI (docs/SECRETS.md). The API never gives a value back.
const secretState = () => ({
  enabled: secrets.enabled,
  secrets: secrets.list(),
  needed: secrets.needed(
    Object.fromEntries([
      ...store.listClassDefs().map((d) => [`class ${String(d.type)}`, (d.secrets as string[] | undefined) ?? []]),
      ...store
        .listAgents()
        .filter((a) => !a.system)
        .map((a) => [`agent ${a.id}`, sendSecretsOf(store.getSpec(a.id)?.nodes ?? [])]),
    ]),
    config.live.hostHeaders,
  ),
  hostHeaders: secrets.hostHeaders(),
  envHostHeaders: Object.keys(config.live.hostHeaders),
});
app.get("/api/secrets", (c) => c.json(secretState()));
app.put("/api/secrets/:name", async (c) => {
  const body = await c.req.json<{ value?: string }>().catch(() => ({}) as { value?: string });
  try {
    secrets.set(c.req.param("name"), body.value ?? "");
    return c.json(secretState());
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
app.delete("/api/secrets/:name", (c) => {
  try {
    secrets.remove(c.req.param("name"));
    return c.json(secretState());
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
app.put("/api/host-headers/:host", async (c) => {
  const body = await c.req.json<{ headers?: Record<string, string> }>().catch(() => ({}) as { headers?: Record<string, string> });
  try {
    secrets.setHostHeaders(c.req.param("host"), body.headers ?? {});
    return c.json(secretState());
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// The builder models of best-of-N, and which of them answer (docs/SELECTION.md).
app.get("/api/models/check", async (c) => {
  const r = await checkModels(runs.brain, [...config.bestOf.models, config.bestOf.judgeModel]);
  return c.json({ enabled: config.bestOf.enabled, builders: config.bestOf.models, judge: config.bestOf.judgeModel, ...r });
});

// Feedback on a run output becomes a test (docs/FEEDBACK.md).
app.post("/api/runs/:id/feedback", async (c) => {
  const body = await c.req.json<{ reason?: string; expected?: string }>().catch(() => ({}) as { reason?: string });
  try {
    return c.json(await feedback.add(c.req.param("id"), { reason: body.reason ?? "", expected: (body as { expected?: string }).expected }), 201);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
app.get("/api/agents/:id/feedback", async (c) => c.json(await feedback.list(c.req.param("id"))));
app.post("/api/agents/:id/improve", async (c) => {
  const body = await c.req.json<{ rounds?: number }>().catch(() => ({}) as { rounds?: number });
  try {
    return c.json({ runId: feedback.improve(c.req.param("id"), body.rounds ?? 2).id }, 202);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// Conversations with a conversation agent.
app.post("/api/agents/:id/sessions", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ version?: number; message?: string }>().catch(() => ({}) as { version?: number; message?: string });
  const agent = store.getAgent(id);
  if (!agent) return c.json({ error: "agent not found" }, 404);
  const version = body.version ?? agent.currentVersion;
  if (!isConversational(store.getSpec(id, version))) return c.json({ error: "This agent is not a conversation agent: its input has no messages" }, 400);
  const s = await sessions.create(id, version);
  if (!body.message?.trim()) return c.json({ session: s }, 201);
  return c.json(await converse({ sessions, runs }, s.id, body.message), 201);
});

app.get("/api/agents/:id/sessions", async (c) => c.json(await sessions.list(c.req.param("id"))));

app.get("/api/sessions/:sid", async (c) => {
  const s = await sessions.get(c.req.param("sid"));
  return s ? c.json(s) : c.json({ error: "session not found" }, 404);
});

app.post("/api/sessions/:sid/messages", async (c) => {
  const body = await c.req.json<{ content?: string; message?: string }>().catch(() => ({}) as { content?: string });
  const content = (body.content ?? (body as { message?: string }).message ?? "").trim();
  if (!content) return c.json({ error: "content is required" }, 400);
  if (!(await sessions.get(c.req.param("sid")))) return c.json({ error: "session not found" }, 404);
  return c.json(await converse({ sessions, runs }, c.req.param("sid"), content));
});

app.delete("/api/sessions/:sid", async (c) => {
  await sessions.remove(c.req.param("sid"));
  return c.json({ ok: true });
});

app.post("/api/agents/:id/refine", async (c) => {
  const body = await c.req.json<{ instruction: string; evaluate?: boolean; optimize?: boolean }>();
  if (!body.instruction?.trim()) return c.json({ error: "instruction is required" }, 400);
  const r = runs.start({ agentId: "anvil-refiner" }, { ...body, agentId: c.req.param("id") }, { kind: "refine" });
  return c.json({ runId: r.id }, 202);
});

app.post("/api/agents/:id/evaluate", async (c) => {
  const body = await c.req.json<{ version?: number }>().catch(() => ({}) as { version?: number });
  const r = runs.start({ agentId: "anvil-evaluator" }, { agentId: c.req.param("id"), version: body.version }, { kind: "eval" });
  return c.json({ runId: r.id }, 202);
});

app.post("/api/agents/:id/evolve", async (c) => {
  const body = await c.req.json<{ rounds?: number }>().catch(() => ({}) as { rounds?: number });
  const r = runs.start({ agentId: "anvil-evolver" }, { agentId: c.req.param("id"), rounds: body.rounds ?? 2 }, { kind: "refine" });
  return c.json({ runId: r.id }, 202);
});

app.get("/api/runs", (c) => {
  const q = c.req.query();
  if (q.parent)
    return c.json(
      store
        .allRunSummaries()
        .filter((r) => r.parentRunId === q.parent)
        .sort((a, b) => a.startedAt - b.startedAt),
    );
  return c.json(
    store
      .listRuns({ agentId: q.agentId, kind: q.kind, limit: q.limit ? Number(q.limit) : 100 })
      .map((r) => (runs.isActive(r.id) ? { ...r, status: runs.activeRecord(r.id)!.status } : r)),
  );
});

app.get("/api/runs/:id", async (c) => {
  const r = await runs.getRun(c.req.param("id"));
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json({ ...r, active: runs.isActive(r.id), pending: runs.pendingRequests(r.id) });
});

app.get("/api/runs/:id/events", async (c) => {
  const id = c.req.param("id");
  const rec = await runs.getRun(id);
  if (!rec) return c.json({ error: "not found" }, 404);
  return streamSSE(c, async (stream) => {
    let closed = false;
    stream.onAbort(() => {
      closed = true;
    });
    const send = (e: RunEvent) => stream.writeSSE({ event: "event", data: JSON.stringify(e) });
    if (!runs.isActive(id)) {
      for (const e of rec.events) await send(e);
      await stream.writeSSE({ event: "end", data: JSON.stringify(runResponse(rec)) });
      return;
    }
    // Subscribe and snapshot in the same tick so no event is lost or duplicated.
    const queue: RunEvent[] = [];
    let final: RunRecord | null = null;
    let wake: (() => void) | null = null;
    const unsub = runs.subscribe(id, (e, r) => {
      if (e.type === "log" && e.message === "__final__") final = r;
      else queue.push(e);
      wake?.();
    });
    const snapshot = (runs.activeRecord(id) ?? rec).events.slice();
    if (!unsub) {
      const r = await runs.getRun(id);
      for (const e of r?.events ?? []) await send(e);
      await stream.writeSSE({ event: "end", data: JSON.stringify(runResponse(r!)) });
      return;
    }
    for (const e of snapshot) await send(e);
    try {
      while (!closed) {
        while (queue.length) await send(queue.shift()!);
        if (final) {
          await stream.writeSSE({ event: "end", data: JSON.stringify(runResponse(final)) });
          break;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 15_000); // heartbeat
        });
        wake = null;
        if (!queue.length && !final) await stream.writeSSE({ event: "ping", data: String(Date.now()) });
      }
    } finally {
      unsub();
    }
  });
});

app.post("/api/runs/:id/resume", async (c) => {
  const { nodeId, value } = await c.req.json<{ nodeId: string; value: unknown }>();
  const ok = runs.resume(c.req.param("id"), nodeId, value);
  return ok ? c.json({ ok }) : c.json({ error: "no pending request for that node" }, 409);
});

app.post("/api/runs/:id/cancel", (c) => {
  const ok = runs.cancel(c.req.param("id"));
  return ok ? c.json({ ok }) : c.json({ error: "run is not active" }, 409);
});

/* ---------------------------------- MCP ---------------------------------- */

// Consume: external MCP servers whose tools become node classes.
/* -------------------------------- sandbox -------------------------------- */

app.get("/api/sandbox/status", async (c) => {
  const st = await anvil.sandbox.status();
  const cfg = config.sandbox;
  return c.json({
    ...st,
    mode: cfg.mode,
    network: cfg.network,
    image: cfg.image,
    pool: cfg.pool,
    timeoutMs: cfg.timeoutMs,
    memory: cfg.memory,
    cpus: cfg.cpus,
    maxSecondsPerRun: cfg.maxSecondsPerRun,
    gate: { index: cfg.packageIndex, vulnCheck: cfg.vulnCheck, allow: cfg.packageAllow, deny: cfg.packageDeny },
    decisions: anvil.sandbox.gate.decisions.slice(-30).reverse(),
  });
});

/** The allowlist of an agent for its programs, in groups. */
app.get("/api/agents/:id/sandbox", (c) => {
  const a = store.getAgent(c.req.param("id"));
  const spec = a?.versions.find((v) => v.version === a.currentVersion)?.spec;
  if (!spec) return c.json({ error: "not found" }, 404);
  return c.json({ allowlist: staticAllowlist(spec), maxSeconds: spec.policy.sandbox?.maxSeconds ?? null, network: config.sandbox.network });
});

/** A person approves domains for the programs of an agent. This saves a new version. */
app.put("/api/agents/:id/sandbox", async (c) => {
  const a = store.getAgent(c.req.param("id"));
  if (!a || a.system) return c.json({ error: "not found or system agent" }, 404);
  const spec = a.versions.find((v) => v.version === a.currentVersion)!.spec;
  const { allowDomains } = await c.req.json<{ allowDomains: string[] }>();
  const domains = [
    ...new Set(
      (allowDomains ?? []).map((d) =>
        String(d)
          .toLowerCase()
          .trim()
          .replace(/^https?:\/\//, "")
          .replace(/\/.*$/, "")
          .replace(/^www\./, ""),
      ),
    ),
  ].filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$|^\d+\.\d+\.\d+\.\d+$/.test(d));
  const next = { ...spec, policy: { ...spec.policy, sandbox: { ...(spec.policy.sandbox ?? {}), allowDomains: domains } } };
  const saved = await store.saveVersion(next, {
    note: `sandbox allowlist: ${domains.join(", ") || "(none)"}`,
    score: a.versions.find((v) => v.version === a.currentVersion)?.score,
  });
  return c.json({ agent: summarizeAgent(saved), allowlist: staticAllowlist(next) });
});

app.get("/api/mcp/servers", async (c) => c.json(await mcp.status()));

app.post("/api/mcp/servers", async (c) => {
  const { server } = await c.req.json<{ server: unknown }>();
  try {
    const sync = await mcp.addServer(server);
    return c.json({ sync, servers: await mcp.status() }, 201);
  } catch (e) {
    return c.json({ error: (e as Error).message, servers: await mcp.status() }, 400);
  }
});

app.post("/api/mcp/servers/:name/refresh", async (c) => {
  try {
    return c.json({ sync: await mcp.sync(c.req.param("name")), servers: await mcp.status() });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

app.post("/api/mcp/servers/:name/approve", async (c) => {
  const { approved = true } = await c.req.json<{ approved?: boolean }>().catch(() => ({ approved: true }));
  return c.json({ changed: await mcp.approveAll(c.req.param("name"), approved), servers: await mcp.status() });
});

app.delete("/api/mcp/servers/:name", async (c) => {
  try {
    await mcp.removeServer(c.req.param("name"), c.req.query("force") === "true");
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, ((e as { status?: number }).status ?? 400) as 400);
  }
});

// Expose: Anvil itself as an MCP server (Streamable HTTP, stateless).
const mcpBackend = localBackend(anvil);
app.all("/mcp", async (c) => {
  const token = process.env.ANVIL_MCP_TOKEN || config.apiToken;
  if (token && c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
  const server = createAnvilMcpServer(mcpBackend);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

app.get("/api/mcp/expose", async (c) => {
  const url = `http://127.0.0.1:${config.port}/mcp`;
  const agents = await mcpBackend.listAgents();
  const stdio = path.resolve("src/mcp-stdio.ts");
  return c.json({
    url,
    tokenRequired: !!process.env.ANVIL_MCP_TOKEN,
    tools: ["anvil_build", "anvil_refine", "anvil_list_agents", "anvil_run_agent", ...agents.map((a) => toolNameFor(a.id))],
    snippets: {
      claudeCode: `claude mcp add --transport http anvil ${url}`,
      claudeDesktop: JSON.stringify({ mcpServers: { anvil: { command: "npx", args: ["-y", "tsx", stdio] } } }, null, 2),
      cursor: JSON.stringify({ mcpServers: { anvil: { url } } }, null, 2),
    },
  });
});

/* -------------------------------- triggers ------------------------------- */

app.get("/api/triggers", (c) => c.json(triggers.list(c.req.query("agentId") || undefined)));

/** Add (or replace) a trigger — saved as a new, validated version of the agent. */
app.post("/api/agents/:id/triggers", async (c) => {
  const id = c.req.param("id");
  const spec = store.getSpec(id);
  if (!spec || store.getAgent(id)?.system) return c.json({ error: "not found" }, 404);
  const { trigger } = await c.req.json<{ trigger: { id: string } }>();
  const next = { ...spec, triggers: [...(spec.triggers ?? []).filter((t) => t.id !== trigger.id), trigger] };
  const r = validateSpec(next, registry, { getAgent });
  if (!r.valid) return c.json({ error: "Trigger has errors", diagnostics: r.diagnostics.filter((d) => d.severity === "error") }, 400);
  // Triggers don't change behavior, so the current evaluation still describes this version.
  const cur = store.getAgent(id)?.versions.find((v) => v.version === spec.version);
  await store.saveVersion(r.spec!, { note: `trigger ${trigger.id} saved`, score: cur?.score, evaluation: cur?.evaluation });
  await triggers.tick();
  return c.json(triggers.list(id), 201);
});

app.delete("/api/agents/:id/triggers/:tid", async (c) => {
  const id = c.req.param("id");
  const spec = store.getSpec(id);
  if (!spec) return c.json({ error: "not found" }, 404);
  const next = { ...spec, triggers: (spec.triggers ?? []).filter((t) => t.id !== c.req.param("tid")) };
  const cur = store.getAgent(id)?.versions.find((v) => v.version === spec.version);
  await store.saveVersion(next, { note: `trigger ${c.req.param("tid")} removed`, score: cur?.score, evaluation: cur?.evaluation });
  return c.json(triggers.list(id));
});

app.patch("/api/agents/:id/triggers/:tid", async (c) => {
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  await triggers.setEnabled(c.req.param("id"), c.req.param("tid"), !!enabled);
  return c.json(triggers.list(c.req.param("id")));
});

app.post("/api/agents/:id/triggers/:tid/fire", async (c) => {
  const body = await c.req.json<{ input?: unknown }>().catch(() => ({}) as { input?: unknown });
  const r = await triggers.fireNow(c.req.param("id"), c.req.param("tid"), body.input);
  if ("run" in r) return c.json({ runId: r.run.id }, 202);
  if ("queued" in r) return c.json({ queued: true, eventId: r.queued.eventId, position: r.queued.position }, 202);
  return c.json({ error: r.rejected === "queue_full" ? "the queue of this trigger is full" : "a scheduled event already waits" }, 429);
});

app.get("/api/agents/:id/triggers/:tid/webhook", async (c) => {
  const secret = await triggers.webhookToken(c.req.param("id"), c.req.param("tid"), c.req.query("rotate") === "true");
  const url = `http://127.0.0.1:${config.port}/api/hooks/${c.req.param("id")}/${c.req.param("tid")}`;
  const body = '{"hello":"world"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const signed = `curl -s -X POST '${url}' -H 'Content-Type: application/json' -H '${TIMESTAMP_HEADER}: ${ts}' -H '${SIGNATURE_HEADER}: ${signWebhook(secret, ts, body)}' -H 'Idempotency-Key: delivery-1' -d '${body}'`;
  const plain = `curl -s -X POST '${url}' -H 'X-Anvil-Token: ${secret}' -H 'Content-Type: application/json' -d '${body}'`;
  return c.json({
    url,
    token: secret,
    auth: triggers.webhookConfig.auth,
    signature: `${SIGNATURE_HEADER}: sha256=HMAC_SHA256(secret, "<${TIMESTAMP_HEADER}>.<raw body>") in hex`,
    // A signed example is valid only in the replay window, so the stable example uses the token when the server accepts it.
    curl: triggers.webhookConfig.auth === "hmac" ? signed : plain,
    ...(triggers.webhookConfig.auth === "either" ? { curlSigned: signed } : {}),
  });
});

// Public webhook entry point (docs/TRIGGERS.md).
mountWebhooks(app, triggers, config.webhook.maxBodyBytes);

/* -------------------------------- classes -------------------------------- */

const classView = (type: string) => {
  const def = classes.get(type);
  return def ? { ...def, usedBy: classes.usedBy(type), missingSecrets: def.secrets.filter((n) => !process.env[n]) } : null;
};

app.get("/api/classes", (c) => c.json(classes.list().map((d) => classView(d.type))));

app.get("/api/classes/:type", (c) => {
  const v = classView(c.req.param("type"));
  return v ? c.json(v) : c.json({ error: "not found" }, 404);
});

/* --------------------------------- files --------------------------------- */

/** A short view of a stored file: its metadata and the start of its content (docs/FILES.md). */
const fileView = (f: NonNullable<ReturnType<typeof files.get>>) => ({
  id: f.id,
  name: f.name,
  mime: f.mime,
  size: f.size,
  createdAt: f.createdAt,
  kind: f.content.kind,
  pages: f.content.pages ?? null,
  sheets: f.content.sheets?.map((s) => ({ name: s.name, columns: s.columns, totalRows: s.totalRows })) ?? null,
  chars: f.content.text.length,
  truncated: f.content.truncated,
  note: f.content.note ?? null,
  preview: f.content.text.slice(0, 600),
});

/** Upload files (multipart form, field "file", one or more). Each file is read now: its text, its tables, or why it cannot be read. */
app.post("/api/files", async (c) => {
  const body = await c.req.parseBody({ all: true });
  const raw = body.file ?? body.files;
  const list = (Array.isArray(raw) ? raw : [raw]).filter((x): x is File => typeof x === "object" && x !== null && "arrayBuffer" in x);
  if (!list.length) return c.json({ error: 'Send the files as multipart form data in the field "file"' }, 400);
  const saved = [];
  for (const f of list) {
    try {
      saved.push(fileView(await files.save(f.name, f.type, Buffer.from(await f.arrayBuffer()))));
    } catch (e) {
      return c.json({ error: (e as Error).message, saved }, 413);
    }
  }
  return c.json({ files: saved }, 201);
});

app.get("/api/files/:id", (c) => {
  const f = files.get(c.req.param("id"));
  return f ? c.json(fileView(f)) : c.json({ error: "not found" }, 404);
});

/** The full content that an agent gets for the file. */
app.get("/api/files/:id/content", (c) => {
  const v = files.value(c.req.param("id"));
  return v ? c.json(v) : c.json({ error: "not found" }, 404);
});

app.delete("/api/files/:id", (c) => (files.delete(c.req.param("id")) ? c.json({ deleted: true }) : c.json({ error: "not found" }, 404)));

/* -------------------------------- library -------------------------------- */

/** The classes of the library agents, which of them can be examples, and the lessons of each domain. */
app.get("/api/library", async (c) => {
  const agents = store
    .listAgents()
    .filter((a) => !a.system)
    .map((a) => {
      const gate = exampleGate(a, registry, config.thresholds, getAgent);
      return { id: a.id, name: a.name, taxonomy: taxonomyOf(gate.spec) ?? null, example: gate.ok, reason: gate.reason ?? null };
    });
  return c.json({ enabled: config.library.examples, domains: knownDomains(store, config.library.domains), agents, lessons: await allLessons(store) });
});

/** Gives a class to each agent that has none (force: to all agents). One Jev call for each agent. */
app.post("/api/library/classify", async (c) => {
  const { force = false } = await c.req.json<{ force?: boolean }>().catch(() => ({ force: false }));
  const done = await classifyLibrary({ brain: runs.brain, store, cfg: config.library }, { force });
  return c.json({ classified: done });
});

app.delete("/api/library/lessons/:domain/:id", async (c) => {
  const ok = await deleteLesson(store, c.req.param("domain"), c.req.param("id"));
  return ok ? c.json({ deleted: true }) : c.json({ error: "not found" }, 404);
});

/** Save a hand-written (or edited) class definition; it is validated and tested for real. */
app.post("/api/classes", async (c) => {
  const { def } = await c.req.json<{ def: unknown }>();
  const r = await classes.save(def, { brain: runs.brain, test: true, createdBy: "user" });
  if (!r.def) return c.json({ error: "Class definition has errors", diagnostics: r.diagnostics }, 400);
  return c.json({ class: classView(r.def.type), diagnostics: r.diagnostics }, 201);
});

/** Let the classsmith meta-agent write a class from a description. */
app.post("/api/classes/generate", async (c) => {
  const { request } = await c.req.json<{ request: string }>();
  if (!request?.trim()) return c.json({ error: "request is required" }, 400);
  const r = runs.start({ agentId: "anvil-classsmith" }, { request }, { kind: "build" });
  return c.json({ runId: r.id }, 202);
});

app.post("/api/classes/:type/approve", async (c) => {
  const { approved = true } = await c.req.json<{ approved?: boolean }>().catch(() => ({ approved: true }));
  return c.json(await classes.approve(c.req.param("type"), approved));
});

app.post("/api/classes/:type/test", async (c) => c.json(await classes.retest(c.req.param("type"), runs.brain)));

app.delete("/api/classes/:type", async (c) => {
  const type = c.req.param("type");
  const used = classes.usedBy(type);
  if (used.length && c.req.query("force") !== "true") return c.json({ error: `Used by: ${used.join(", ")}. Pass ?force=true to delete anyway.`, usedBy: used }, 409);
  return (await classes.remove(type)) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
});

/* ------------------------------- benchmark ------------------------------- */

app.get("/api/bench", (c) => {
  const reports = listReports(config.dataDir);
  return c.json(reports.map((r, i) => ({ ...r, delta: compareReports(r, reports[i + 1]) })));
});

/* --------------------------------- usage -------------------------------- */

app.get("/api/usage", (c) => {
  const all = store.allRunSummaries().filter((r) => !r.parentRunId);
  const byKind: Record<string, { runs: number; costUsd: number; llmCalls: number; decisionCalls: number; tokens: number }> = {};
  const byDay: Record<string, { costUsd: number; runs: number }> = {};
  const byAgent: Record<string, { name: string; runs: number; costUsd: number; failures: number }> = {};
  const totals = { runs: 0, costUsd: 0, llmCalls: 0, decisionCalls: 0, inputTokens: 0, outputTokens: 0, failures: 0 };
  for (const r of all) {
    const u = r.usage;
    totals.runs++;
    totals.costUsd += u.costUsd;
    totals.llmCalls += u.llmCalls;
    totals.decisionCalls += u.decisionCalls;
    totals.inputTokens += u.inputTokens;
    totals.outputTokens += u.outputTokens;
    if (r.status === "failed") totals.failures++;
    const k = (byKind[r.kind] ??= { runs: 0, costUsd: 0, llmCalls: 0, decisionCalls: 0, tokens: 0 });
    k.runs++;
    k.costUsd += u.costUsd;
    k.llmCalls += u.llmCalls;
    k.decisionCalls += u.decisionCalls;
    k.tokens += u.inputTokens + u.outputTokens;
    const day = new Date(r.startedAt).toISOString().slice(0, 10);
    const d = (byDay[day] ??= { costUsd: 0, runs: 0 });
    d.costUsd += u.costUsd;
    d.runs++;
    const a = (byAgent[r.agentId] ??= { name: r.agentName, runs: 0, costUsd: 0, failures: 0 });
    a.runs++;
    a.costUsd += u.costUsd;
    if (r.status === "failed") a.failures++;
  }
  return c.json({ totals, byKind, byDay, byAgent });
});

/* ------------------------------ static web UI ---------------------------- */

const dist = path.resolve("dist");
if (fs.existsSync(path.join(dist, "index.html"))) {
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), dist) }));
  app.get("*", (c) => c.html(fs.readFileSync(path.join(dist, "index.html"), "utf8")));
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`\n  ⚒  Anvil API on http://${config.host}:${info.port}`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && !config.apiToken)
    console.log("     WARNING: the server listens on all addresses without ANVIL_API_TOKEN. Anyone on the network can use it.");
  console.log(`     LLM: ${config.llmModel}   decisions: ${config.decisionModel}   key: ${config.apiKey ? "configured" : "MISSING (set OPENROUTER_API_KEY in .env)"}\n`);
  // The sandbox gets its containers ready, so the first program does not wait.
  void anvil.sandbox.status().then((st) => {
    console.log(`     Python sandbox: ${st.available ? `ready (network: ${config.sandbox.network})` : `not available: ${st.reason}`}`);
    if (st.available) void anvil.sandbox.warm();
  });
});

const shutdown = async () => {
  triggers.stop();
  await mcp.closeAll();
  await anvil.browser.close();
  await anvil.sandbox.dispose().catch(() => undefined);
  await store.flush();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
