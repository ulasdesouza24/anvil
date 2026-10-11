import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeSourcePlan, jsonOutline, type SourcePlan } from "../src/builder/sources.js";
import { missingPlannedSources } from "../src/core/urls.js";
import type { AgentSpec, Answer, Question } from "../src/core/types.js";
import type { ChatRequest } from "../src/llm/openrouter.js";
import { anvilWith, defaultAnswer, FakeClient } from "./helpers.js";

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const html = (b: string) => res.writeHead(200, { "Content-Type": "text/html" }).end(b);
    if (url.pathname === "/blocked") return void html(`<html><head><title>Request Rejected</title></head><body>The requested URL was rejected.</body></html>`);
    if (url.pathname === "/js")
      return void html(
        `<html><body><div id="o">Loading</div><script>fetch("/api/rates?base=EUR").then(r=>r.json()).then(d=>{document.getElementById("o").textContent=JSON.stringify(d)})</script></body></html>`,
      );
    if (url.pathname === "/api/rates")
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ base: url.searchParams.get("base"), rates: { USD: 1.09, TRY: 38.2 } }));
    if (url.pathname === "/jsdata")
      return void html(
        `<html><body><nav>${"Home About Contact Login Register Help Terms Privacy ".repeat(12)}</nav><div id="o">Loading</div><script>fetch("/api/rates?base=EUR").then(r=>r.json()).then(d=>{document.getElementById("o").textContent=JSON.stringify(d)})</script></body></html>`,
      );
    if (url.pathname === "/api/stats") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ name: "repo", stars: 120, forks: 4 }));
    if (url.pathname === "/api/commits") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify([{ sha: "abc", last_commit: "2026-10-05" }]));
    if (url.pathname === "/api/direct") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ rates: { USD: 1.1 } }));
    if (url.pathname === "/api/slow") return void setTimeout(() => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ rates: { USD: 1.1 } })), 400);
    if (url.pathname === "/hang") return; // never answers
    res.writeHead(404).end("no");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const need = { id: "fx_rates", description: "EUR exchange rates", fields: ["currency", "rate"], freshness: "today", required: true };

/** The needs of these tests are specific APIs, so the answer to "is it open-ended web research?" is no. */
const notResearch = (decide: (id: string, q: Question, state: unknown) => Answer) => (id: string, q: Question, state: unknown): Answer =>
  /^w\d+$/.test(id) && String((q as { instructions?: string }).instructions).includes("open-ended web research") ? { type: "noul", noul: 0.05 } : decide(id, q, state);

function setup(urls: string[], decide?: (id: string, q: Question, state: unknown) => Answer) {
  const client = new FakeClient((req: ChatRequest) => {
    const user = String(req.messages.at(-1)?.content ?? "");
    if (user.includes("DATA NEED:")) return JSON.stringify({ candidates: urls.map((u) => ({ kind: "api", url: `${base}${u}`, description: u })) });
    return "{}";
  }, notResearch(decide ?? defaultAnswer));
  Object.assign(client.config, { searchProviders: [] }); // no network search in tests
  return client;
}

const sourcesSpec = (config: Record<string, unknown>): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "s",
  name: "s",
  description: "",
  version: 1,
  inputSchema: { type: "object", properties: {} },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "sources", type: "anvil_sources", config },
    { id: "output", type: "output", config: { value: "{{nodes.sources.output.sourcePlan}}" } },
  ],
  edges: [
    { from: "input", to: "sources" },
    { from: "sources", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 120_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
});

describe("source plan", () => {
  it("probes candidates for real and makes the best API a tested class", async () => {
    const anvil = await anvilWith(setup(["/blocked", "/js", "/api/direct", "/missing"]));
    const r = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "fx", dataNeeds: [need] } }) }, {});
    expect(r.error).toBeUndefined();
    const plan = r.output as SourcePlan;
    const n = plan.needs[0];
    const byUrl = Object.fromEntries(n.tried.map((x) => [x.candidate.url!.replace(base, ""), x]));
    expect(byUrl["/blocked"].blocked).toBe("web application firewall");
    expect(byUrl["/js"]).toMatchObject({ access: "http", reachable: true, note: "API captured in the browser" });
    expect(byUrl["/js"].endpoint?.url).toContain("/api/rates?base=EUR");
    expect(byUrl["/api/direct"]).toMatchObject({ access: "http", reachable: true });
    expect(byUrl["/missing"].reachable).toBe(false);
    expect(n.primary?.candidate.url).toBe(`${base}/js`);
    expect(n.use?.nodeType).toBe("x_src_fx_rates");
    expect(anvil.classes.get("x_src_fx_rates")?.status).toBe("passed");
    expect(n.fallbacks.map((f) => f.candidate.url)).toContain(`${base}/api/direct`);
    expect(plan.unresolved).toEqual([]);
    await anvil.browser.close();
  }, 120_000);

  it("uses the source lessons of the library: a blocked source is not probed again, a tested source is in the prompt", async () => {
    const client = setup(["/blocked", "/api/direct"]);
    const anvil = await anvilWith(client);
    const lesson = (kind: string, url: string) => ({ id: kind, domain: "currency_exchange", pattern: "pipeline", kind, text: `${url} (${kind})`, source: `${base}${url}`, count: 1, firstAt: 0, lastAt: 0 });
    const library = {
      enabled: true,
      taxonomy: { pattern: "pipeline", domain: "currency_exchange", sourceKind: "api", outputKind: "table" },
      examples: [],
      lessons: [lesson("source_blocked", "/blocked"), lesson("source_ok", "/api/direct")],
    };
    const r = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "fx", dataNeeds: [need] }, library }) }, {});
    const plan = r.output as SourcePlan;
    expect(plan.needs[0].tried.map((x) => x.candidate.url?.replace(base, ""))).toEqual(["/api/direct"]);
    const prompt = String(client.chats.find((c) => String(c.messages.at(-1)?.content).includes("DATA NEED:"))?.messages.at(-1)?.content);
    expect(prompt).toContain(`TESTED SOURCES FROM THE LIBRARY`);
    expect(prompt).toContain(`${base}/api/direct`);
    expect(prompt).toContain(`SOURCES THAT DID NOT WORK in earlier builds (do not give them):\n- ${base}/blocked`);
  }, 60_000);

  it("saves the source lessons of the domain: the selected source worked, a blocked source did not", async () => {
    const anvil = await anvilWith(setup(["/blocked", "/api/direct"]));
    const library = { enabled: true, taxonomy: { pattern: "pipeline", domain: "currency_exchange", sourceKind: "api", outputKind: "table" }, examples: [], lessons: [] };
    await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "fx", dataNeeds: [need] }, library }) }, {});
    const lessons = ((await anvil.store.get("library-lessons", "currency_exchange")) ?? []) as { kind: string; source: string }[];
    expect(lessons.map((l) => [l.kind, l.source.replace(base, "")]).sort()).toEqual([
      ["source_blocked", "/blocked"],
      ["source_ok", "/api/direct"],
    ]);
  }, 60_000);

  it("proposes new candidates with the reasons when no candidate gives the data", async () => {
    const prompts: string[] = [];
    const client = new FakeClient((req: ChatRequest) => {
      const user = String(req.messages.at(-1)?.content ?? "");
      if (!user.includes("DATA NEED:")) return "{}";
      prompts.push(user);
      const url = user.includes("THESE CANDIDATES DID NOT GIVE THE DATA") ? "/api/direct" : "/v2/missing";
      return JSON.stringify({ candidates: [{ kind: "api", url: `${base}${url}`, description: url }] });
    }, notResearch(defaultAnswer));
    Object.assign(client.config, { searchProviders: [] });
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "fx", dataNeeds: [need] } }) }, {});
    const plan = r.output as SourcePlan;
    expect(plan.needs[0].primary?.candidate.url).toBe(`${base}/api/direct`);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(`- ${base}/v2/missing → `);
    expect(prompts[1]).toContain("(HTTP 404)");
    // With no retry round, the plan has no source.
    client.config.sourceRetryRounds = 0;
    const r0 = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "fx", dataNeeds: [need] }, allowUnresolved: true }) }, {});
    expect((r0.output as SourcePlan).unresolved).toEqual(["fx_rates"]);
  }, 60_000);

  it("scores a slow source lower, so a fast source with the same data wins", async () => {
    const client = setup(["/api/slow", "/api/direct"]);
    client.config.sourceWeights = { ...client.config.sourceWeights, slowMs: 200 };
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "fx", dataNeeds: [need] } }) }, {});
    const n = (r.output as SourcePlan).needs[0];
    expect(n.tried.find((x) => x.candidate.url?.endsWith("/api/slow"))?.latencyMs).toBeGreaterThanOrEqual(400);
    expect(n.primary?.candidate.url).toBe(`${base}/api/direct`);
  }, 60_000);

  it("a class that does not get an answer in time says that it timed out", async () => {
    const anvil = await anvilWith(new FakeClient());
    const saved = await anvil.classes.save(
      {
        type: "x_hang",
        title: "Hang",
        category: "data",
        description: "A source that does not answer.",
        whenToUse: "Never.",
        configSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { rates: { type: "object" } } },
        impl: { kind: "http", request: { method: "GET", url: `${base}/hang` }, timeoutMs: 600 },
        tests: [],
      },
      { brain: anvil.runs.brain, test: false },
    );
    expect(saved.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const s = sourcesSpec({});
    s.nodes = [
      { id: "input", type: "input", config: {} },
      { id: "h", type: "x_hang", config: {} },
      { id: "output", type: "output", config: { value: "{{nodes.h.output}}" } },
    ];
    s.edges = [
      { from: "input", to: "h" },
      { from: "h", to: "output" },
    ];
    const r = await anvil.runs.run({ spec: s }, {});
    expect(r.error).toMatch(/timed out after 1 s: 127\.0\.0\.1:\d+ did not answer/);
  }, 30_000);

  it("prefers a tested class that the library has already", async () => {
    const client = setup(["/api/direct"], (id, q) => (id === "c0" ? { type: "noul", noul: 0.95 } : defaultAnswer(id, q)));
    const anvil = await anvilWith(client);
    await anvil.classes.save(
      {
        type: "x_rates",
        title: "Rates",
        category: "data",
        description: "Exchange rates for a base currency.",
        whenToUse: "Rates.",
        configSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { rates: { type: "object" } } },
        impl: { kind: "code", code: "return { rates: { USD: 1 } }" },
        tests: [{ name: "t", config: {}, checks: [{ path: "rates", op: "exists" }] }],
      },
      { brain: anvil.runs.brain },
    );
    const r = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "fx", dataNeeds: [need] } }) }, {});
    const n = (r.output as SourcePlan).needs[0];
    expect(n.primary?.access).toBe("class");
    expect(n.use).toEqual({ nodeType: "x_rates" });
  }, 60_000);

  it("stops the build early when a required need has no working source, and says why", async () => {
    const anvil = await anvilWith(setup(["/blocked", "/missing"]));
    const r = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "fx", dataNeeds: [need] } }) }, {});
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/No working data source for: fx_rates/);
    expect(r.error).toMatch(/blocked \(web application firewall\)/);
    // allowUnresolved continues, and the plan marks the gap for the architect.
    const ok = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "fx", dataNeeds: [need] }, allowUnresolved: true }) }, {});
    expect((ok.output as SourcePlan).unresolved).toEqual(["fx_rates"]);
    expect(describeSourcePlan(ok.output as SourcePlan)).toMatch(/NO WORKING SOURCE/);
    await anvil.browser.close();
  }, 120_000);

  it("asks a person to approve the plan when the build may ask questions", async () => {
    const anvil = await anvilWith(setup(["/api/direct"]));
    const started = anvil.runs.start({ spec: sourcesSpec({ taskSpec: { name: "fx", dataNeeds: [need] }, approve: true }) }, {});
    for (let i = 0; i < 200 && !anvil.runs.pendingRequests(started.id).length; i++) await new Promise((r) => setTimeout(r, 20));
    const req = anvil.runs.pendingRequests(started.id)[0];
    expect(String(req.request.payload)).toContain("fx_rates");
    anvil.runs.resume(started.id, "sources", { approved: false, comment: "use the ECB" });
    const done = await anvil.runs.waitForRun(started.id);
    expect(done?.error).toMatch(/source plan was rejected: use the ECB/);
  }, 60_000);

  it("gives the scorer the time of the check, and asks about the meaning of the fields", async () => {
    const client = setup(["/api/direct"]);
    const anvil = await anvilWith(client);
    await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "fx", dataNeeds: [need] } }) }, {});
    const d = client.decisions.find((x) => "samples" in (x.state as object))!;
    expect(Date.now() - Date.parse((d.state as { now: string }).now)).toBeLessThan(60_000);
    expect(String(d.questions.r0.instructions)).toMatch(/Judge the meaning of the data, not the field names/);
    expect(String(d.questions.f0.instructions)).toMatch(/Compare its dates with "now"/);
    // The model that proposes sources also knows the time, so it can set date parameters.
    const proposer = client.chats.find((c) => String(c.messages.at(-1)?.content).includes("DATA NEED:"))!;
    expect(String(proposer.messages.at(-1)?.content)).toMatch(/^NOW: \d{4}-\d{2}-\d{2}T/);
  }, 60_000);

  it("the source score weights come from the config", async () => {
    const client = setup(["/api/direct"]);
    client.config.sourceWeights = { ...client.config.sourceWeights, freshness: 0 };
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "fx", dataNeeds: [need] } }) }, {});
    const p = (r.output as SourcePlan).needs[0].primary!;
    // With a freshness weight of 0, the score is the relevance alone.
    expect(p.score).toBeCloseTo(p.relevance, 5);
  }, 60_000);

  it("takes the fields of one need from several sources, and names the fields that no source has", async () => {
    const repo = { id: "repo_health", description: "Health data of a code repository", fields: ["stars", "last_commit", "license"], required: true };
    // Jev: each sample is about the topic. A sample has a field when its text has the field name.
    const byField = (id: string, q: Question, state: unknown): Answer => {
      const m = /^c(\d+)_(\d+)$/.exec(id);
      if (!m) return defaultAnswer(id, q);
      const sample = (state as { samples: { sample: string }[] }).samples[Number(m[1])].sample;
      return { type: "noul", noul: sample.includes(repo.fields[Number(m[2])]) ? 0.9 : 0.05 };
    };
    const anvil = await anvilWith(setup(["/api/stats", "/api/commits"], byField));
    const r = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "repo", dataNeeds: [repo] } }) }, {});
    const n = (r.output as SourcePlan).needs[0];
    expect(n.primary?.fields).toEqual(["stars"]);
    expect(n.complements?.map((c) => [c.source.candidate.url?.replace(base, ""), c.fields, c.use.nodeType])).toEqual([["/api/commits", ["last_commit"], "http"]]);
    expect(n.missingFields).toEqual(["license"]);
    const text = describeSourcePlan(r.output as SourcePlan);
    expect(text).toContain('Also use node type "http"');
    expect(text).toContain("for the fields last_commit");
    expect(text).toContain("No tested source has the fields license: the agent must report them as gaps.");
    // A spec that uses the complement source also passes the planned source check.
    expect(missingPlannedSources(r.output as SourcePlan, [{ type: "http", config: { url: `${base}/api/commits` } }])).toEqual([]);
    await anvil.browser.close();
  }, 120_000);

  it("goes on when most required needs have a source, and stops when the main part of the data is missing", async () => {
    const rates = { id: "fx_rates", description: "EUR exchange rates", fields: ["rate"], required: true };
    const pop = { id: "population", description: "City population", fields: ["population"], required: true };
    const area = { id: "area", description: "City area", fields: ["area_km2"], required: true };
    // A sample has a field when its text has the field name: /api/direct has "rates", nothing has population or area.
    const byField = (id: string, q: Question, state: unknown): Answer => {
      const m = /^c(\d+)_(\d+)$/.exec(id);
      if (!m) return defaultAnswer(id, q);
      const st = state as { fields: string[]; samples: { sample: string }[] };
      return { type: "noul", noul: st.samples[Number(m[1])].sample.includes(st.fields[Number(m[2])]) ? 0.9 : 0.05 };
    };
    const anvil = await anvilWith(setup(["/api/direct"], byField));
    const half = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "x", dataNeeds: [rates, pop] } }) }, {});
    expect(half.status).toBe("completed");
    expect((half.output as SourcePlan).unresolved).toEqual(["population"]);
    expect(describeSourcePlan(half.output as SourcePlan)).toContain("population (population): NO WORKING SOURCE");
    expect(half.events.some((e) => e.type === "log" && /the build goes on, and the agent must report these needs as gaps/.test(e.message))).toBe(true);

    const third = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "x", dataNeeds: [rates, pop, area] } }) }, {});
    expect(third.status).toBe("failed");
    expect(third.error).toMatch(/No working data source for: population, area/);
    await anvil.browser.close();
  }, 120_000);

  it("serves open-ended web research with the built-in tools, and probes no source for it", async () => {
    const research = { id: "competitors", description: "The main competitors of a product category, found by a web search", fields: ["name", "url"], required: true };
    const client = new FakeClient(() => "{}", defaultAnswer); // Jev says yes: open-ended research
    Object.assign(client.config, { searchProviders: [] });
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "scan", dataNeeds: [research] } }) }, {});
    const n = (r.output as SourcePlan).needs[0];
    expect(n.use).toEqual({ nodeType: "web_search" });
    expect(n.primary).toMatchObject({ access: "class", note: "open-ended web research: no source to probe" });
    expect(n.tried).toEqual([]);
    expect(client.chats.some((c) => String(c.messages.at(-1)?.content).includes("DATA NEED:"))).toBe(false);
    // An agent node with the web_search tool uses this plan.
    expect(missingPlannedSources(r.output as SourcePlan, [{ type: "agent", config: { tools: ["web_search", "fetch_url"] } }])).toEqual([]);
    expect(missingPlannedSources(r.output as SourcePlan, [{ type: "llm", config: {} }])).toEqual(["competitors"]);
  }, 60_000);

  it("shows all data fields of a large JSON sample, also when link fields come first", () => {
    const sample: Record<string, unknown> = { id: 1, owner: { login: "x", id: 2 } };
    for (let i = 0; i < 60; i++) sample[`link_${i}_url`] = `https://api.example.com/repos/x/y/${"segment/".repeat(4)}${i}`;
    Object.assign(sample, { stargazers_count: 1234, open_issues_count: 56, pushed_at: "2026-10-06T10:00:00Z" });
    const o = jsonOutline(sample);
    expect(o).toMatch(/^FIELDS: id, owner, stargazers_count, open_issues_count, pushed_at \(and 60 link fields\)/);
    expect(o).toContain("stargazers_count: 1234");
    expect(o).toContain('owner: {login: "x", id: 2}');
    expect(jsonOutline([{ a: 1 }, { a: 2 }])).toMatch(/^A list of 2 records/);
    // A time series keyed by dates shows its size, a key, and the first entry.
    const series = { base: "EUR", rates: Object.fromEntries(["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"].map((d) => [d, { USD: 1.17, TRY: 48.2 }])) };
    expect(jsonOutline(series)).toContain('rates: map of 4 entries, keys like "2026-09-08". First entry: {USD: 1.17, TRY: 48.2}');
    // A field in a nested object (for example commit.author.date) is visible to a depth of 3.
    const commits = [{ sha: "abc", commit: { author: { name: "A", date: "2026-10-05T09:00:00Z" }, message: "fix" }, url: "https://api.example.com/c/abc" }];
    expect(jsonOutline(commits)).toContain('commit: {author: {name: "A", date: "2026-10-05T09:00:00Z"}, message: "fix"}');
  });

  it("prefers a URL that the request names, when it works", async () => {
    const client = setup(["/js", "/api/direct"]);
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "fx", dataNeeds: [need] }, request: `Get the EUR rates from ${base}/api/direct.` }) }, {});
    const n = (r.output as SourcePlan).needs[0];
    expect(n.primary?.candidate).toMatchObject({ url: `${base}/api/direct`, named: true });
    expect(n.tried.map((x) => x.candidate.url!.replace(base, ""))).toEqual(["/api/direct", "/js"]);
    await anvil.browser.close();
  }, 120_000);

  it("opens a static page without the data in the browser, and finds the data there", async () => {
    // The sample has the data only when it contains the rates.
    const client = setup(["/jsdata"], (id, q, state) => {
      const samples = (state as { samples?: { sample: string }[] }).samples;
      if (samples && /^r\d+$/.test(id)) return { type: "noul", noul: samples[Number(id.slice(1))].sample.includes("USD") ? 0.9 : 0.1 };
      return defaultAnswer(id, q);
    });
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "fx", dataNeeds: [need] } }) }, {});
    const n = (r.output as SourcePlan).needs[0];
    expect(n.primary).toMatchObject({ access: "http", note: "API captured in the browser" });
    expect(n.primary?.endpoint?.url).toContain("/api/rates?base=EUR");
    await anvil.browser.close();
  }, 120_000);

  it("with a person, a need without a source is a question: approve to build with the gap, or reject to stop", async () => {
    const anvil = await anvilWith(setup(["/blocked"]));
    const ask = async () => {
      const started = anvil.runs.start({ spec: sourcesSpec({ taskSpec: { name: "fx", dataNeeds: [need] }, approve: true }) }, {});
      for (let i = 0; i < 500 && !anvil.runs.pendingRequests(started.id).length; i++) await new Promise((r) => setTimeout(r, 20));
      return { id: started.id, req: anvil.runs.pendingRequests(started.id)[0] };
    };
    const a = await ask();
    expect(a.req.request).toMatchObject({ title: "Some data has no working source" });
    anvil.runs.resume(a.id, "sources", { approved: true });
    const ok = await anvil.runs.waitForRun(a.id);
    expect(ok?.status).toBe("completed");
    expect((ok?.output as SourcePlan).unresolved).toEqual(["fx_rates"]);
    const b = await ask();
    anvil.runs.resume(b.id, "sources", { approved: false });
    expect((await anvil.runs.waitForRun(b.id))?.error).toMatch(/No working data source for: fx_rates/);
    await anvil.browser.close();
  }, 120_000);

  it("does nothing when the task has no data needs, and the architect sees the plan", async () => {
    const anvil = await anvilWith(setup([]));
    const r = await anvil.runs.run({ spec: sourcesSpec({ taskSpec: { name: "x", dataNeeds: [] } }) }, {});
    expect(r.output).toBeNull();

    const plan: SourcePlan = {
      needs: [
        {
          need,
          primary: {
            candidate: { id: "a", kind: "api", url: "https://api.test/rates", description: "" },
            access: "http",
            status: 200,
            reachable: true,
            sampleKeys: ["rates"],
            sampleText: "",
            relevance: 0.9,
            freshness: 1,
            score: 0.9,
          },
          fallbacks: [],
          tried: [],
          use: { nodeType: "x_src_fx_rates" },
        },
      ],
      unresolved: [],
    };
    const client = new FakeClient(() =>
      JSON.stringify({ pattern: "pipeline", rationale: "r", steps: [{ id: "get", type: "http", purpose: "p", dependsOn: ["input"] }], output: "o" }),
    );
    const a2 = await anvilWith(client);
    const arch: AgentSpec = {
      ...sourcesSpec({}),
      nodes: [
        { id: "input", type: "input", config: {} },
        {
          id: "sources",
          type: "anvil_architect",
          config: { taskSpec: { name: "fx", goal: "g", inputs: [], outputs: [], successCriteria: [] }, triage: { pattern: "pipeline", flags: {} }, sourcePlan: plan },
        },
        { id: "output", type: "output", config: { value: "{{nodes.sources.output.plan}}" } },
      ],
    };
    const out = await a2.runs.run({ spec: arch }, {});
    expect(out.status).toBe("completed");
    expect(String(client.chats[0].messages.at(-1)?.content)).toContain("DATA SOURCE PLAN");
    expect(String(client.chats[0].messages.at(-1)?.content)).toContain('use node type "x_src_fx_rates"');
    expect((out.output as { sourcePlan?: SourcePlan }).sourcePlan?.needs[0].use?.nodeType).toBe("x_src_fx_rates");
  }, 60_000);
});
