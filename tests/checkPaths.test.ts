import { describe, expect, it } from "vitest";
import { betterReport, readsLiveData, shrinkJson } from "../src/builder/nodes.js";
import type { AgentSpec, TestCase } from "../src/core/types.js";
import { agentOutputSchema, checkPathProblem, validateSpec } from "../src/core/validator.js";
import { validateAndRepair } from "../src/builder/repair.js";
import { qualityOf } from "../src/core/quality.js";
import { missingNamedUrls, missingPlannedSources, namedUrlPrefixes, namedUrls } from "../src/core/urls.js";
import { anvilWith, FakeClient } from "./helpers.js";

/** An agent whose output is one template: the spec output schema gives the shape. */
const invoice = (): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "inv",
  name: "inv",
  description: "Reads an invoice.",
  version: 1,
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  outputSchema: {
    type: "object",
    properties: { invoice: { type: "object", properties: { invoice_number: { type: "string" } } }, check: { type: "object" }, missing_fields: { type: "array" } },
  },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "assemble", type: "transform", config: { value: { invoice: { invoice_number: "A-1" }, check: {}, missing_fields: [] } } },
    { id: "output", type: "output", config: { value: "{{nodes.assemble.output}}" } },
  ],
  edges: [
    { from: "input", to: "assemble" },
    { from: "assemble", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 60_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
});

describe("check paths", () => {
  it("knows the output shape from the output node value or from the spec output schema", () => {
    const s = invoice();
    expect(Object.keys(agentOutputSchema(s)?.properties ?? {})).toEqual(["invoice", "check", "missing_fields"]);
    s.nodes[2].config = { value: { total: "{{nodes.assemble.output.check}}" } };
    expect(Object.keys(agentOutputSchema(s)?.properties ?? {})).toEqual(["total"]);
  });

  it("finds a path that is not in the output, and accepts paths that can exist", () => {
    const shape = agentOutputSchema(invoice());
    expect(checkPathProblem(shape, "invoice_number")).toBe('"invoice_number" is not in the agent output (fields there: invoice, check, missing_fields)');
    expect(checkPathProblem(shape, "invoice.invoice_number")).toBeNull();
    expect(checkPathProblem(shape, "invoice.seller")).toBe('"invoice.seller" is not in the agent output (fields there: invoice_number)');
    expect(checkPathProblem(shape, "check.matches_total")).toBeNull(); // no declared fields: anything can exist
    expect(checkPathProblem(shape, "missing_fields[0]")).toBeNull();
    expect(checkPathProblem(undefined, "anything")).toBeNull();
  });

  it("the validator warns about a test check path and rejects an acceptance path", async () => {
    const anvil = await anvilWith(new FakeClient());
    const s = invoice();
    s.tests = [{ id: "t", name: "t", input: {}, criteria: [], checks: [{ path: "invoice_number", op: "exists" }] }];
    s.acceptance = [{ id: "a", kind: "check", check: { path: "total", op: "exists" } }];
    const d = validateSpec(s, anvil.registry, { ste: "off" }).diagnostics;
    expect(d.filter((x) => x.code === "TEST_CHECK_PATH").map((x) => x.severity)).toEqual(["warning"]);
    expect(d.filter((x) => x.code === "ACCEPTANCE").map((x) => x.message)).toEqual([
      'acceptance rule "a": "total" is not in the agent output (fields there: invoice, check, missing_fields)',
    ]);
  });

  it("the test generator gets the output shape and removes checks on paths that the output does not have", async () => {
    const client = new FakeClient(() =>
      JSON.stringify({
        tests: [
          {
            name: "typical",
            input: { text: "Invoice A-1" },
            criteria: ["The invoice number is A-1."],
            checks: [
              { path: "invoice_number", op: "equals", value: "A-1" },
              { path: "invoice.invoice_number", op: "equals", value: "A-1" },
            ],
          },
        ],
      }),
    );
    const anvil = await anvilWith(client);
    const runner: AgentSpec = {
      ...invoice(),
      id: "tg",
      outputSchema: undefined,
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "tg", type: "anvil_testgen", config: { spec: invoice(), taskSpec: { name: "inv", goal: "g", successCriteria: ["c"], exampleInputs: [] }, count: 1 } },
        { id: "output", type: "output", config: { value: "{{nodes.tg.output.tests}}" } },
      ],
      edges: [
        { from: "input", to: "tg" },
        { from: "tg", to: "output" },
      ],
    };
    const r = await anvil.runs.run({ spec: runner }, {});
    expect(r.status).toBe("completed");
    expect((r.output as TestCase[])[0].checks).toEqual([{ path: "invoice.invoice_number", op: "equals", value: "A-1" }]);
    expect(String(client.chats[0].messages.at(-1)?.content)).toContain("OUTPUT SHAPE (a check path must exist in it)");
    expect(r.events.some((e) => e.type === "log" && /1 check\(s\) removed/.test(e.message))).toBe(true);
  });
});

describe("live data in tests", () => {
  it("knows when an agent gets its data at run time", () => {
    const s = invoice();
    expect(readsLiveData(s, {})).toBe(false);
    expect(readsLiveData(s, { dataNeeds: [{}] })).toBe(true);
    s.nodes[1] = { id: "assemble", type: "x_rates", config: {} };
    expect(readsLiveData(s, {}, () => "code")).toBe(false);
    expect(readsLiveData(s, {}, () => "http")).toBe(true);
    s.nodes[1] = { id: "assemble", type: "agent", config: { task: "t", tools: ["browse"] } };
    expect(readsLiveData(s, {})).toBe(true);
  });

  it("tells the test generator not to expect exact values from a live source", async () => {
    const client = new FakeClient(() => JSON.stringify({ tests: [{ name: "t", input: {}, criteria: ["c"], checks: [] }] }));
    const anvil = await anvilWith(client);
    const live = invoice();
    live.nodes[1] = { id: "assemble", type: "web_fetch", config: { url: "https://example.com" } };
    const runner: AgentSpec = {
      ...invoice(),
      id: "tg",
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "tg", type: "anvil_testgen", config: { spec: live, taskSpec: { name: "inv", goal: "g", successCriteria: ["c"], exampleInputs: [] }, count: 1 } },
        { id: "output", type: "output", config: { value: "{{nodes.tg.output.tests}}" } },
      ],
      edges: [
        { from: "input", to: "tg" },
        { from: "tg", to: "output" },
      ],
    };
    await anvil.runs.run({ spec: runner }, {});
    expect(String(client.chats[0].messages.at(-1)?.content)).toContain("LIVE DATA: this agent gets its data from external sources");
    expect(String(client.chats[0].messages.at(-1)?.content)).toContain("Do not invent an item and expect data for it.");
    expect(String(client.chats[0].messages[0]?.content)).toContain("A criterion must not need data that the output does not show.");
    expect(String(client.chats[0].messages.at(-1)?.content)).toContain(`TODAY: ${new Date().toISOString().slice(0, 10)}`);
  });
});

describe("critic evidence", () => {
  it("keeps the type and the shape of a large value", () => {
    const big = { invoice: { number: "A-1", lines: Array.from({ length: 200 }, (_, i) => ({ i, text: "x".repeat(50) })) }, ok: true };
    const s = shrinkJson(big, 600) as { invoice: { number: string; lines: unknown[] }; ok: boolean };
    expect(typeof s).toBe("object");
    expect(s.ok).toBe(true);
    expect(s.invoice.number).toBe("A-1");
    expect(Array.isArray(s.invoice.lines)).toBe(true);
    expect(String(s.invoice.lines.at(-1))).toMatch(/more items, 200 in total/);
    expect(shrinkJson({ a: 1 })).toEqual({ a: 1 });
    expect(shrinkJson("y".repeat(3000), 100)).toMatch(/…\[3000 chars\]$/);
  });
});

describe("sources that the request names", () => {
  const req = "Read the quotes on https://quotes.toscrape.com/js/page/{n}/ and list the authors.";

  it("finds the fixed part of a named URL and checks that the spec uses it", () => {
    expect(namedUrlPrefixes(req)).toEqual(["https://quotes.toscrape.com/js/page/"]);
    expect(namedUrls(req)).toEqual(["https://quotes.toscrape.com/js/page/1/"]);
    expect(missingNamedUrls(req, [{ url: "https://quotes.toscrape.com/js/page/{{input.n}}/" }])).toEqual([]);
    expect(missingNamedUrls(req, [{ url: "https://quotes.toscrape.com/page/{{input.n}}/" }])).toEqual(["https://quotes.toscrape.com/js/page/"]);
    expect(missingNamedUrls(undefined, [{}])).toEqual([]);
  });

  it("the compiler reports a named source that no node uses, and the repair loop puts it back", async () => {
    const spec = invoice();
    spec.nodes[1] = { id: "assemble", type: "web_fetch", config: { url: "https://quotes.toscrape.com/page/1/" } };
    const anvil = await anvilWith(
      new FakeClient(() => JSON.stringify({ operations: [{ op: "replace", path: "/nodes/1/config/url", value: "https://quotes.toscrape.com/js/page/1/" }] })),
    );
    const d = validateSpec(spec, anvil.registry, { request: req, ste: "off" }).diagnostics.filter((x) => x.code === "NAMED_SOURCE");
    expect(d).toMatchObject([{ severity: "warning", message: "The request names the source https://quotes.toscrape.com/js/page/, but no node uses it" }]);
    const out = await validateAndRepair(spec, { brain: anvil.runs.brain, registry: anvil.registry, maxAttempts: 2, request: req });
    expect(out.spec?.nodes[1].config.url).toBe("https://quotes.toscrape.com/js/page/1/");
  });

  it("a named source that the repair cannot put back does not block the build", async () => {
    const spec = invoice();
    const anvil = await anvilWith(new FakeClient(() => JSON.stringify({ operations: [{ op: "replace", path: "/name", value: "x" }] })));
    const out = await validateAndRepair(spec, { brain: anvil.runs.brain, registry: anvil.registry, maxAttempts: 1, request: req });
    expect(out.spec).not.toBeNull();
    expect(out.result.diagnostics.filter((x) => x.code === "NAMED_SOURCE").map((x) => x.severity)).toEqual(["warning"]);
  });
});

describe("evolve comparison", () => {
  const rep = (score: number, passRate: number, skippedTests = 0) => ({ version: 1, score, passRate, skippedTests, results: [], costUsd: 0, at: 0 });
  it("a candidate that runs all tests and passes more wins over a best with skipped tests", () => {
    // The best has a score from the smoke test only.
    expect(betterReport(rep(0.816, 0.667, 0), rep(0.885, 0, 2))).toBe(true);
    // A candidate that skips more tests and passes no more does not win.
    expect(betterReport(rep(0.95, 0, 2), rep(0.8, 0.667, 0))).toBe(false);
    // The same number of tests: the score decides.
    expect(betterReport(rep(0.9, 0.667), rep(0.8, 0.667))).toBe(true);
    expect(betterReport(rep(0.8, 0.667), rep(0.9, 0.667))).toBe(false);
  });

  it("a candidate with a higher score but fewer passed tests does not win", () => {
    // The evolve round of a collections build: 50% passed at 0.83, then 0% passed at 0.85.
    expect(betterReport(rep(0.85, 0), rep(0.83, 0.5))).toBe(false);
    // A configured pass drop lets a small loss through.
    expect(betterReport(rep(0.9, 0.45), rep(0.83, 0.5), { evolveMinGain: 0.005, evolveScoreTolerance: 0.02, evolvePassDrop: 0.1 })).toBe(true);
  });
});

describe("sources that the source plan tested", () => {
  const plan = {
    needs: [
      {
        need: { id: "quakes" },
        primary: { candidate: { url: "http://koeri.boun.edu.tr/scripts/lasteq.asp" } },
        fallbacks: [{ candidate: { url: "https://deprem.afad.gov.tr/apiv2/event/filter?start=x" } }],
        use: { nodeType: "web_fetch" },
      },
      { need: { id: "rates" }, primary: { candidate: { url: "https://api.x/rates" } }, fallbacks: [], use: { nodeType: "x_src_rates" } },
      { need: { id: "gap" }, primary: null, fallbacks: [] },
    ],
  };

  it("a need is covered by its class type, its primary URL, or a fallback URL with other parameters", () => {
    const usgs = [{ type: "web_fetch", config: { url: "https://earthquake.usgs.gov/fdsnws/event/1/query" } }];
    expect(missingPlannedSources(plan, usgs)).toEqual(["quakes", "rates"]);
    const ok = [
      { type: "http", config: { url: "https://deprem.afad.gov.tr/apiv2/event/filter", query: { start: "{{x}}" } } },
      { type: "x_src_rates", config: {} },
    ];
    expect(missingPlannedSources(plan, ok)).toEqual([]);
    expect(missingPlannedSources(undefined, usgs)).toEqual([]);
  });

  it("the compiler reports an untested source, and the repair loop goes back to the plan", async () => {
    const spec = invoice();
    spec.nodes[1] = { id: "assemble", type: "web_fetch", config: { url: "https://earthquake.usgs.gov/fdsnws/event/1/query" } };
    const one = { needs: [plan.needs[0]] };
    const anvil = await anvilWith(
      new FakeClient(() => JSON.stringify({ operations: [{ op: "replace", path: "/nodes/1/config/url", value: "http://koeri.boun.edu.tr/scripts/lasteq.asp" }] })),
    );
    const d = validateSpec(spec, anvil.registry, { sourcePlan: one, ste: "off" }).diagnostics.filter((x) => x.code === "PLANNED_SOURCE");
    expect(d).toMatchObject([{ severity: "warning", message: 'No node uses the tested source of the data need "quakes"' }]);
    // The plan in spec.meta also counts.
    expect(validateSpec({ ...spec, meta: { plan: { sourcePlan: one } } }, anvil.registry, { ste: "off" }).diagnostics.some((x) => x.code === "PLANNED_SOURCE")).toBe(true);
    const out = await validateAndRepair(spec, { brain: anvil.runs.brain, registry: anvil.registry, maxAttempts: 2, sourcePlan: one });
    expect(out.spec?.nodes[1].config.url).toBe("http://koeri.boun.edu.tr/scripts/lasteq.asp");
  });
});

describe("quality of a published version", () => {
  it("gives a label from the pass rate", () => {
    expect(qualityOf(undefined)).toBe("untested");
    expect(qualityOf({ passRate: 1, results: [{}] })).toBe("passed");
    expect(qualityOf({ passRate: 0.67, results: [{}] })).toBe("partial");
    expect(qualityOf({ passRate: 0, results: [{}] })).toBe("failed");
    expect(qualityOf({ passRate: 0, results: [] })).toBe("untested");
  });

  it("the publish step writes the quality in the note, the artifact, and the output", async () => {
    const anvil = await anvilWith(new FakeClient());
    const evaluation = { version: 1, passRate: 0, score: 0.85, results: [{}], costUsd: 0, at: 0 };
    const runner: AgentSpec = {
      ...invoice(),
      id: "pub",
      outputSchema: undefined,
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "p", type: "anvil_publish", config: { spec: invoice(), evaluation } },
        { id: "output", type: "output", config: { value: "{{nodes.p.output}}" } },
      ],
      edges: [
        { from: "input", to: "p" },
        { from: "p", to: "output" },
      ],
    };
    const r = await anvil.runs.run({ spec: runner }, {});
    expect(r.output).toMatchObject({ quality: "failed" });
    const saved = anvil.store.getAgent((r.output as { agentId: string }).agentId)!;
    expect(saved.versions[0].note).toBe("built by Anvil (failed)");
    expect(r.events.some((e) => e.type === "log" && /published with quality "failed"/.test(e.message))).toBe(true);
  });
});
