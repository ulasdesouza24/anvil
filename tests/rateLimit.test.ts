import { describe, expect, it } from "vitest";
import { evaluateSpec } from "../src/builder/evaluate.js";
import { betterReport } from "../src/builder/nodes.js";
import { loadConfig } from "../src/core/config.js";
import { qualityOf } from "../src/core/quality.js";
import { rateLimitOf } from "../src/core/rateLimit.js";
import type { AgentSpec, EvaluationReport, TestCase } from "../src/core/types.js";
import { anvilWith, FakeClient } from "./helpers.js";

const pattern = loadConfig().rateLimitPattern;
const GITHUB = 'HTTP 403 from api.github.com: {"message":"API rate limit exceeded for 95.3.29.110."}';

/** An agent with one code node. The node fails with the error, or returns the value. */
const agent = (error: string | null): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "repo",
  name: "repo",
  description: "Gets the stars of a repository.",
  version: 1,
  inputSchema: { type: "object", properties: {} },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "api", type: "code", config: { code: error ? `throw new Error(${JSON.stringify(error)})` : "return { stars: 5 }" } },
    { id: "output", type: "output", config: { value: { stars: "{{nodes.api.output.stars}}" } } },
  ],
  edges: [
    { from: "input", to: "api" },
    { from: "api", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 50, timeoutMs: 60_000, requireApprovalForSideEffects: false },
  acceptance: [{ id: "stars", kind: "check", check: { path: "stars", op: "exists" } }],
  tests: [],
  meta: {},
});

const test = (id: string): TestCase => ({ id, name: id, input: {}, criteria: [], checks: [{ path: "stars", op: "exists" }] });

describe("rate limit detection", () => {
  it("finds the rate limit messages of common sources, and not other errors", () => {
    expect(rateLimitOf(GITHUB, pattern)).toMatch(/rate limit exceeded/);
    expect(rateLimitOf("HTTP 429 from api.example.com: Too Many Requests", pattern)).toMatch(/429/);
    expect(rateLimitOf("daily quota exceeded for this key", pattern)).toMatch(/quota exceeded/);
    expect(rateLimitOf('HTTP 404 from api.github.com: {"message":"Not Found"}', pattern)).toBeNull();
    expect(rateLimitOf("HTTP 403 Forbidden: login required", pattern)).toBeNull();
    // The value 4290 is not the status 429.
    expect(rateLimitOf("the price is 4290 EUR", pattern)).toBeNull();
  });

  it("uses the pattern of the config, and a bad pattern finds nothing", () => {
    expect(rateLimitOf("Slow down: request budget used", "request budget used")).toMatch(/request budget used/);
    expect(rateLimitOf(GITHUB, "([")).toBeNull();
  });
});

describe("rate limit in the harness", () => {
  it("classifies a rate limit without a model call, and takes only a different source", async () => {
    const client = new FakeClient(() => "x");
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: agent(GITHUB) }, {});
    expect(r.harness).toMatchObject({ failureClass: "rate_limited" });
    expect(client.decisions.some((d) => "failure" in d.questions)).toBe(false);
  });
});

describe("rate limit in the evaluation", () => {
  it("does not score a test that a rate limit stopped, and does not diagnose it", async () => {
    const client = new FakeClient(() => "x");
    const anvil = await anvilWith(client);
    const out = await evaluateSpec(agent(GITHUB), [test("t1"), test("t2")], { services: anvil.runs.services, brain: anvil.runs.brain });
    expect(out.report.results.every((r) => r.environment && /rate limit/.test(r.environment))).toBe(true);
    expect(out.report.results.every((r) => !r.diagnosis)).toBe(true);
    expect(out.report.environmentTests).toBe(2);
    expect(client.decisions.some((d) => "d0" in d.questions)).toBe(false);
    // No test has a score: the version is untested, and it cannot win over another version.
    expect(qualityOf(out.report)).toBe("untested");
    const best: EvaluationReport = { version: 1, passRate: 0, score: 0.2, results: [], costUsd: 0, at: 0 };
    expect(betterReport({ ...out.report, score: 0.9, passRate: 1 }, best)).toBe(false);
  });

  it("runs the other tests when a rate limit stops the smoke test", async () => {
    const anvil = await anvilWith(new FakeClient(() => "x"));
    const notes: string[] = [];
    const out = await evaluateSpec(agent(GITHUB), [test("t1"), test("t2")], { services: anvil.runs.services, brain: anvil.runs.brain, smokeFirst: true, onSmokeNote: (n) => notes.push(n) });
    expect(out.report.results.map((r) => r.skipped ?? null)).toEqual([null, null]);
    expect(notes[0]).toMatch(/because of the environment/);
  });

  it("scores the other tests as usual: the pass rate counts only the scored tests", async () => {
    const anvil = await anvilWith(new FakeClient(() => "x"));
    // The source refuses the request only when the input asks for the limited repository.
    const mixed = agent(null);
    mixed.nodes[1].config = { code: `if (input.limited) throw new Error(${JSON.stringify(GITHUB)}); return { stars: 5 };` };
    const out = await evaluateSpec(mixed, [test("t1"), { ...test("t2"), input: { limited: true } }], { services: anvil.runs.services, brain: anvil.runs.brain });
    expect(out.report.results.map((r) => [r.passed, r.environment ? "env" : null])).toEqual([
      [true, null],
      [false, "env"],
    ]);
    expect(out.report).toMatchObject({ passRate: 1, score: 1, environmentTests: 1 });
    expect(qualityOf(out.report)).toBe("passed");
  });
});
