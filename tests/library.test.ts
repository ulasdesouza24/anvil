import { describe, expect, it } from "vitest";
import { classify, classifyLibrary, knownDomains, subjectOfSpec, taxonomyOf } from "../src/builder/library.js";
import type { AgentSpec, Answer, EvaluationReport, Question, Taxonomy } from "../src/core/types.js";
import { anvilWith, defaultAnswer, FakeClient } from "./helpers.js";

/** A small valid agent of the library. */
export const libAgent = (id: string, description: string, meta: Record<string, unknown> = {}): AgentSpec => ({
  specVersion: "anvil/v1",
  id,
  name: id,
  description,
  version: 1,
  inputSchema: { type: "object", properties: { base: { type: "string" } } },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "w", type: "llm", config: { prompt: "Write the rates for {{input.base}}." } },
    { id: "output", type: "output", config: { value: { text: "{{nodes.w.output.text}}" } } },
  ],
  edges: [
    { from: "input", to: "w" },
    { from: "w", to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 50, timeoutMs: 60_000, requireApprovalForSideEffects: false },
  tests: [],
  meta,
});

export const evaluation = (score: number, passRate = 1): EvaluationReport => ({ version: 1, passRate, score, results: [{ testId: "t", name: "t", passed: passRate >= 1, score, criteria: [], checks: [], costUsd: 0, durationMs: 0 }], costUsd: 0, at: 0 });

export const FX: Taxonomy = { pattern: "pipeline", domain: "currency_exchange", sourceKind: "api", outputKind: "table" };

/** Jev: the domain is currency_exchange when the listed domains have it, the source kind is api, the output kind is table. */
export const classifier =
  (domain = "currency_exchange") =>
  (id: string, q: Question, s: unknown): Answer => {
    if (q.type === "choice" && id === "domain") return { type: "choice", choice: domain in q.criteria ? domain : "other", confidence: 0.9, probabilities: {} };
    if (q.type === "choice" && id === "sourceKind") return { type: "choice", choice: "api", confidence: 0.9, probabilities: {} };
    if (q.type === "choice" && id === "outputKind") return { type: "choice", choice: "table", confidence: 0.9, probabilities: {} };
    return defaultAnswer(id, q);
  };

describe("classification", () => {
  it("puts an agent into a class with one Jev call, and keeps the pattern of the triage", async () => {
    const client = new FakeClient(() => "x", classifier());
    const anvil = await anvilWith(client);
    const t = await classify(anvil.runs.brain, { name: "fx", goal: "Show the exchange rates.", pattern: "map_reduce" }, ["finance", "currency_exchange"]);
    expect(t).toEqual({ pattern: "map_reduce", domain: "currency_exchange", sourceKind: "api", outputKind: "table" });
    expect(client.decisions).toHaveLength(1);
    expect(Object.keys(client.decisions[0].questions).sort()).toEqual(["domain", "outputKind", "sourceKind"]);
  });

  it("names a new domain when no known domain fits, and the library then knows it", async () => {
    const client = new FakeClient(() => JSON.stringify({ domain: "Job Listings" }), classifier("none_of_them"));
    const anvil = await anvilWith(client);
    const t = await classify(anvil.runs.brain, { name: "jobs", goal: "Find job posts." }, ["finance"]);
    expect(t.domain).toBe("job_listings");
    expect(t.pattern).toBe("pipeline");
    await anvil.store.saveVersion({ ...libAgent("jobs", "Finds job posts."), meta: { taxonomy: t } }, { note: "x" });
    expect(knownDomains(anvil.store, ["finance"])).toEqual(["finance", "job_listings"]);
  });

  it("classifies the library agents without a class, in place, and again only with force", async () => {
    const client = new FakeClient(() => "x", classifier());
    const anvil = await anvilWith(client);
    await anvil.store.saveVersion(libAgent("fx-a", "Gives exchange rates."), { note: "x" });
    await anvil.store.saveVersion(libAgent("fx-b", "Gives exchange rates.", { taxonomy: { ...FX, domain: "finance" } }), { note: "x" });
    const done = await classifyLibrary({ brain: anvil.runs.brain, store: anvil.store, cfg: anvil.config.library });
    // The bundled example agent has no class either.
    expect(done.map((d) => d.agentId).sort()).toEqual(["fx-a", "support-triage-example"]);
    const a = anvil.store.getAgent("fx-a")!;
    // No new version: the class goes into the current version.
    expect(a.versions).toHaveLength(1);
    expect(taxonomyOf(a.versions[0].spec)).toMatchObject({ domain: "currency_exchange", sourceKind: "api", outputKind: "table" });
    // System agents never get a class.
    expect(taxonomyOf(anvil.store.getSpec("anvil-builder"))).toBeUndefined();
    const again = await classifyLibrary({ brain: anvil.runs.brain, store: anvil.store, cfg: anvil.config.library }, { force: true });
    expect(again.map((d) => d.agentId).sort()).toEqual(["fx-a", "fx-b", "support-triage-example"]);
    expect(taxonomyOf(anvil.store.getSpec("fx-b"))?.domain).toBe("currency_exchange");
  });

  it("the subject of a spec uses its task, its inputs, and its node types", () => {
    const s = subjectOfSpec(libAgent("fx", "Gives rates.", { taskSpec: { goal: "G", steps: ["a"], dataNeeds: [{ description: "rates" }] }, pattern: "pipeline" }));
    expect(s).toMatchObject({ goal: "G", steps: ["a"], dataNeeds: ["rates"], inputs: ["base"], nodeTypes: ["llm"], pattern: "pipeline" });
  });

  it("the publish step gives a class to an agent that has none", async () => {
    const anvil = await anvilWith(new FakeClient(() => "x", classifier()));
    const runner: AgentSpec = {
      ...libAgent("pub", ""),
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "p", type: "anvil_publish", config: { spec: libAgent("fx-new", "Gives exchange rates."), evaluation: evaluation(0.9) } },
        { id: "output", type: "output", config: { value: "{{nodes.p.output}}" } },
      ],
      edges: [
        { from: "input", to: "p" },
        { from: "p", to: "output" },
      ],
    };
    const r = await anvil.runs.run({ spec: runner }, {});
    const id = (r.output as { agentId: string }).agentId;
    expect(taxonomyOf(anvil.store.getSpec(id))).toMatchObject({ domain: "currency_exchange" });
  });
});

/* --------------------------------- examples -------------------------------- */

import { exampleGate, findExamples, libraryPrompt, sourceHints, type LibraryContext } from "../src/builder/library.js";

/** Jev: the similarity of a library agent comes from its name; the class questions use the classifier. */
const similar = (sims: Record<string, number>) => (id: string, q: Question, s: unknown): Answer => {
  if (q.type === "noul" && /^s\d+$/.test(id)) {
    const name = /library agent #\d+ \("([^"]+)"\)/.exec(String(q.instructions))?.[1] ?? "";
    return { type: "noul", noul: sims[name] ?? 0.1 };
  }
  return classifier()(id, q, s);
};

const task = { goal: "Show the daily exchange rates of a currency.", steps: ["get the rates", "write a table"], inputs: ["base"], outputs: ["table"], dataNeeds: ["exchange rates"] };

async function library(sims: Record<string, number>) {
  const client = new FakeClient(() => "x", similar(sims));
  const anvil = await anvilWith(client);
  const save = (spec: AgentSpec, ev?: EvaluationReport) => anvil.store.saveVersion(spec, { note: "x", evaluation: ev, score: ev?.score });
  await save(libAgent("fx-good", "Gives exchange rates.", { taxonomy: FX, plan: { sourcePlan: { needs: [{ need: { id: "rates" }, primary: { candidate: { url: "https://api.example.com/rates" } } }] } } }), evaluation(0.95));
  await save(libAgent("fx-partial", "Gives exchange rates.", { taxonomy: FX }), evaluation(0.9, 0.5));
  await save(libAgent("fx-low", "Gives exchange rates.", { taxonomy: FX }), evaluation(0.7));
  await save(libAgent("fx-old", "Gives the history of exchange rates."), evaluation(0.9));
  await save(libAgent("weather", "Gives the weather.", { taxonomy: { pattern: "research_agent", domain: "weather_climate", sourceKind: "api", outputKind: "report" } }), evaluation(0.99));
  const broken = libAgent("fx-broken", "Gives exchange rates.", { taxonomy: FX });
  broken.nodes[1] = { id: "w", type: "no_such_node", config: {} };
  await save(broken, evaluation(0.99));
  const deps = { brain: anvil.runs.brain, store: anvil.store, registry: anvil.registry, cfg: anvil.config.library, th: anvil.config.thresholds };
  return { anvil, client, deps };
}

describe("examples from the library", () => {
  it("the quality gate takes only passed, high-score agents that compile with the current rules", async () => {
    const { anvil } = await library({});
    const gate = (id: string) => exampleGate(anvil.store.getAgent(id)!, anvil.registry, anvil.config.thresholds);
    expect(gate("fx-good").ok).toBe(true);
    expect(gate("fx-partial")).toMatchObject({ ok: false, reason: "quality is partial" });
    expect(gate("fx-low").reason).toMatch(/score 0.70 is below 0.85/);
    expect(gate("fx-broken").reason).toMatch(/does not compile with the current rules/);
  });

  it("selects the most similar agents of the same class, and gives a class to an old agent on the way", async () => {
    const { anvil, deps } = await library({ "fx-good": 0.9, "fx-old": 0.7 });
    const { examples, candidates } = await findExamples(deps, FX, task);
    expect(examples.map((e) => e.agentId)).toEqual(["fx-good", "fx-old"]);
    expect(examples[0]).toMatchObject({ similarity: 0.9, score: 0.95, sources: [{ needId: "rates", url: "https://api.example.com/rates" }] });
    expect(examples[0].text).toContain('EXAMPLE "fx-good"');
    expect(examples[0].text).toContain("Tested sources: rates → https://api.example.com/rates");
    // The example shows the cost of one run from its tests, so the architect can choose a cheaper design.
    expect(examples[0].runCostUsd).toBe(0);
    expect(examples[0].text).toMatch(/cost of one run about \$0\.00000, 1 model step\(s\)/);
    // The weak, broken, and other-class agents are not candidates.
    expect(candidates.map((c) => c.agentId).sort()).toEqual(["fx-good", "fx-old"]);
    // The old agent got a class, in its current version.
    expect(taxonomyOf(anvil.store.getSpec("fx-old"))?.domain).toBe("currency_exchange");
  });

  it("does not use a candidate below the similarity threshold, and says why", async () => {
    const { deps } = await library({ "fx-good": 0.9, "fx-old": 0.4 });
    const { examples, candidates } = await findExamples(deps, FX, task);
    expect(examples.map((e) => e.agentId)).toEqual(["fx-good"]);
    expect(candidates.find((c) => c.agentId === "fx-old")).toMatchObject({ selected: false, reason: "similarity 0.40 is below 0.6" });
    const strict = await findExamples({ ...deps, th: { ...deps.th, exampleMatch: 0.95 } }, FX, task);
    expect(strict.examples).toEqual([]);
  });

  it("uses the examples that the person selects, and never the ones that the person removes", async () => {
    const { client, deps } = await library({ "fx-good": 0.9, "fx-old": 0.9 });
    const { examples } = await findExamples(deps, FX, task, { include: ["weather"], exclude: ["fx-good"] });
    expect(examples.map((e) => [e.agentId, e.similarity, e.forced ?? false])).toEqual([
      ["weather", null, true],
      ["fx-old", 0.9, false],
    ]);
    // A selected example skips the similarity question.
    const asked = client.decisions.flatMap((d) => Object.values(d.questions).map((q) => String((q as { instructions?: string }).instructions)));
    expect(asked.some((q) => q.includes('"weather"'))).toBe(false);
  });

  it("the build prompts get the examples and the lessons that each step can use", () => {
    const lib: LibraryContext = {
      enabled: true,
      taxonomy: FX,
      examples: [{ agentId: "fx-good", version: 1, name: "fx-good", description: "", score: 0.95, similarity: 0.9, classes: [], sources: [], text: 'EXAMPLE "fx-good"' }],
      lessons: [
        { id: "a", domain: "currency_exchange", pattern: "pipeline", kind: "agent_fix", text: "Compare dates as dates.", count: 2, firstAt: 0, lastAt: 0 },
        { id: "b", domain: "currency_exchange", pattern: "pipeline", kind: "test_problem", text: "A test expected an exact rate.", count: 1, firstAt: 0, lastAt: 0 },
      ],
    };
    const arch = libraryPrompt(lib, "architect");
    expect(arch).toContain('LIBRARY EXAMPLES (tested agents of the same class "pipeline / currency_exchange")');
    expect(arch).toContain("Compare dates as dates. (2 builds)");
    expect(arch).not.toContain("exact rate");
    expect(libraryPrompt(lib, "testgen")).toContain("A test expected an exact rate.");
    expect(libraryPrompt(lib, "testgen")).not.toContain("EXAMPLE");
    expect(libraryPrompt(lib, "critic")).toContain("Compare dates as dates.");
    expect(libraryPrompt({ ...lib, enabled: false }, "architect")).toBe("");
  });

  it("source hints: the tested sources of the examples and of the lessons, without the blocked ones", () => {
    const lesson = (kind: "source_ok" | "source_blocked", source: string) => ({ id: source, domain: "d", pattern: "p", kind, text: `${source} ${kind}`, source, count: 1, firstAt: 0, lastAt: 0 });
    const h = sourceHints({
      enabled: true,
      taxonomy: FX,
      examples: [{ agentId: "fx-good", version: 1, name: "", description: "", score: 1, similarity: 1, classes: [], sources: [{ needId: "rates", url: "https://a.test/rates" }, { needId: "x", url: "https://b.test/x" }], text: "" }],
      lessons: [lesson("source_ok", "https://c.test/ok"), lesson("source_blocked", "https://b.test/x")],
    });
    expect(h.good.map((g) => g.url)).toEqual(["https://a.test/rates", "https://c.test/ok"]);
    expect([...h.blocked]).toEqual(["https://b.test/x"]);
  });
});

describe("the library step of a build", () => {
  const stepSpec = (config: Record<string, unknown>): AgentSpec => ({
    ...libAgent("lib-step", ""),
    nodes: [
      { id: "input", type: "input", config: {} },
      { id: "library", type: "anvil_library", config },
      { id: "output", type: "output", config: { value: "{{nodes.library.output}}" } },
    ],
    edges: [
      { from: "input", to: "library" },
      { from: "library", to: "output" },
    ],
  });
  const taskSpec = { name: "fx", summary: "Rates.", goal: task.goal, steps: task.steps, inputs: [{ name: "base" }], outputs: [{ name: "table" }], dataNeeds: [{ description: "exchange rates" }] };

  it("finds the class, the examples, and the lessons, and shows them in an artifact", async () => {
    const { anvil } = await library({ "fx-good": 0.9 });
    const r = await anvil.runs.run({ spec: stepSpec({ taskSpec, triage: { pattern: "pipeline" } }) }, {});
    expect(r.error).toBeUndefined();
    const out = r.output as LibraryContext;
    expect(out).toMatchObject({ enabled: true, taxonomy: FX });
    expect(out.examples.map((e) => e.agentId)).toEqual(["fx-good"]);
    const art = r.events.find((e) => e.type === "artifact" && e.kind === "library") as { data: { examples: object[]; candidates: object[] } } | undefined;
    expect(art?.data.examples[0]).not.toHaveProperty("text");
    expect(art?.data.candidates.length).toBeGreaterThan(0);
  });

  it("uses only the lessons of the domain that Jev finds relevant to the new task, and shows the others", async () => {
    const client = new FakeClient(() => "x", (id, q, st) => {
      if (q.type === "noul" && /^l\d+$/.test(id)) {
        const i = Number(id.slice(1));
        const text = (st as { lessons: { i: number; text: string }[] }).lessons[i].text;
        return { type: "noul", noul: text.includes("moderation") ? 0.1 : 0.9 };
      }
      return similar({})(id, q, st);
    });
    const anvil = await anvilWith(client);
    await recordLessons(anvil.store, anvil.config.library, FX, [
      { kind: "agent_fix", text: "Compare dates as dates." },
      { kind: "test_problem", text: "A moderation test expected a human review." },
    ]);
    const r = await anvil.runs.run({ spec: stepSpec({ taskSpec, triage: { pattern: "pipeline" } }) }, {});
    expect((r.output as LibraryContext).lessons.map((l) => l.text)).toEqual(["Compare dates as dates."]);
    const art = r.events.find((e) => e.type === "artifact" && e.kind === "library") as { data: { droppedLessons: { text: string; p: number }[] } };
    expect(art.data.droppedLessons).toEqual([{ text: "A moderation test expected a human review.", kind: "test_problem", p: 0.1 }]);
  });

  it("gives no examples when the build or the config turns the library off, but still finds the class", async () => {
    const { anvil, client } = await library({ "fx-good": 0.9 });
    const r = await anvil.runs.run({ spec: stepSpec({ taskSpec, enabled: false }) }, {});
    expect(r.output).toMatchObject({ enabled: false, taxonomy: { domain: "currency_exchange" }, examples: [], lessons: [] });
    // The model client gives the config of the brain.
    client.config.library = { ...client.config.library, examples: false };
    const r2 = await anvil.runs.run({ spec: stepSpec({ taskSpec }) }, {});
    expect(r2.output).toMatchObject({ enabled: false, examples: [] });
  });

  it("the builder runs the library step between the analysis and the source plan", async () => {
    const { anvil } = await library({});
    const b = anvil.store.getSpec("anvil-builder")!;
    expect(b.edges).toEqual(expect.arrayContaining([{ from: "library", to: "sources" }, { from: "reanalyze", to: "library" }, { from: "need_info", to: "library", port: "proceed" }]));
    for (const id of ["sources", "architect", "compose"]) expect(JSON.stringify(b.nodes.find((n) => n.id === id)!.config)).toContain("nodes.library.output");
  });
});

describe("examples in the architect and compose steps", () => {
  it("the architect and compose prompts have the examples, and the spec keeps the class and the examples", async () => {
    const plan = { pattern: "pipeline", rationale: "r", steps: [{ id: "w", type: "llm", purpose: "write the rates", dependsOn: ["input"] }], output: "w" };
    const client = new FakeClient((req) => {
      const sys = String(req.messages[0]?.content ?? "");
      if (sys.includes("You are the architect")) return JSON.stringify(plan);
      if (sys.includes("You write Anvil agent specs")) return JSON.stringify(libAgent("fx-new", "Gives exchange rates."));
      return "x";
    }, classifier());
    const anvil = await anvilWith(client);
    await anvil.store.saveVersion(libAgent("fx-good", "Gives exchange rates."), { note: "x" });
    await anvil.store.saveVersion(libAgent("fx-other", "Converts prices."), { note: "x" });
    const lib: LibraryContext = {
      enabled: true,
      taxonomy: FX,
      examples: [{ agentId: "fx-good", version: 3, name: "fx-good", description: "", score: 0.95, similarity: 0.9, classes: ["x_src_rates"], sources: [], text: 'EXAMPLE "fx-good" with x_src_rates' }],
      lessons: [],
    };
    const taskSpec = { name: "fx-new", agentId: "fx-new", summary: "Rates.", goal: "Rates.", inputs: [{ name: "base", type: "string", description: "b", required: true }], outputs: [{ name: "text", type: "string", description: "t" }], steps: [], constraints: [], successCriteria: [], assumptions: [], clarifyingQuestions: [], exampleInputs: [] };
    const spec: AgentSpec = {
      ...libAgent("steps", ""),
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "architect", type: "anvil_architect", config: { taskSpec, triage: { pattern: "pipeline" }, library: lib } },
        { id: "compose", type: "anvil_compose", config: { taskSpec, plan: "{{nodes.architect.output.plan}}", library: lib } },
        { id: "output", type: "output", config: { value: "{{nodes.compose.output.spec.meta}}" } },
      ],
      edges: [
        { from: "input", to: "architect" },
        { from: "architect", to: "compose" },
        { from: "compose", to: "output" },
      ],
    };
    const r = await anvil.runs.run({ spec }, {});
    expect(r.error).toBeUndefined();
    const user = (part: string) => String(client.chats.find((c) => String(c.messages[0]?.content).includes(part))?.messages.at(-1)?.content);
    expect(user("You are the architect")).toContain('EXAMPLE "fx-good" with x_src_rates');
    expect(user("You write Anvil agent specs")).toContain('EXAMPLE "fx-good" with x_src_rates');
    // The new agent is built with its own steps: an example is not in the list of subagents.
    const catalog = user("You are the architect").split("AVAILABLE AGENTS (reusable via subagent):")[1].split("\n\n")[0];
    expect(catalog).toContain("fx-other");
    expect(catalog).not.toContain("fx-good");
    expect(user("You are the architect")).toContain("do not call an example agent with a subagent step");
    expect(r.output).toMatchObject({ taxonomy: FX, examples: [{ agentId: "fx-good", version: 3, similarity: 0.9 }] });
  });
});

/* --------------------------------- lessons --------------------------------- */

import { allLessons, deleteLesson, lessonsFor, recordLessons } from "../src/builder/library.js";
import type { TestCase } from "../src/core/types.js";

describe("lessons of a domain", () => {
  const cfg = { maxLessons: 3, lessonsInPrompt: 2, lessonMaxAgeDays: 120 };

  it("counts the same lesson again, and a source lesson replaces the opposite lesson for the same source", async () => {
    const { anvil } = await library({});
    await recordLessons(anvil.store, cfg, FX, [{ kind: "agent_fix", text: "Compare  dates as dates." }]);
    await recordLessons(anvil.store, cfg, FX, [{ kind: "agent_fix", text: "compare dates as dates." }]);
    await recordLessons(anvil.store, cfg, FX, [{ kind: "source_blocked", source: "https://a.test", text: "a blocked" }]);
    await recordLessons(anvil.store, cfg, FX, [{ kind: "source_ok", source: "https://a.test", text: "a works" }]);
    const list = (await allLessons(anvil.store)).currency_exchange;
    // Two lessons of the same millisecond have no fixed order.
    expect(list.map((l) => [l.kind, l.count]).sort()).toEqual([
      ["agent_fix", 2],
      ["source_ok", 1],
    ]);
  });

  it("keeps the newest lessons of a domain, and a prompt gets the same pattern first, then the most frequent", async () => {
    const { anvil } = await library({});
    await recordLessons(anvil.store, cfg, { domain: "currency_exchange", pattern: "map_reduce" }, [{ kind: "agent_fix", text: "other pattern" }]);
    await recordLessons(anvil.store, cfg, FX, [{ kind: "agent_fix", text: "once" }]);
    await recordLessons(anvil.store, cfg, FX, [{ kind: "agent_fix", text: "twice" }]);
    await recordLessons(anvil.store, cfg, FX, [{ kind: "agent_fix", text: "twice" }]);
    const inPrompt = await lessonsFor(anvil.store, cfg, FX);
    expect(inPrompt.map((l) => l.text)).toEqual(["twice", "once"]);
    await recordLessons(anvil.store, cfg, FX, [{ kind: "agent_fix", text: "fourth" }]);
    expect((await allLessons(anvil.store)).currency_exchange).toHaveLength(3);
    // An old lesson is not used.
    const later = Date.now() + 200 * 86_400_000;
    expect(await lessonsFor(anvil.store, cfg, FX, later)).toEqual([]);
  });

  it("a person can delete a wrong lesson", async () => {
    const { anvil } = await library({});
    const [l] = await recordLessons(anvil.store, cfg, FX, [{ kind: "test_problem", text: "wrong" }]);
    expect(await deleteLesson(anvil.store, "currency_exchange", l.id)).toBe(true);
    expect(await deleteLesson(anvil.store, "currency_exchange", l.id)).toBe(false);
    expect((await allLessons(anvil.store)).currency_exchange).toBeUndefined();
  });
});

describe("lessons from evolve", () => {
  const GOOD = "The text names at least one earthquake.";
  const LIVE = "The list has exactly 3 earthquakes.";
  const quakes = (prompt: string): AgentSpec => ({
    ...libAgent("quakes", "Lists the earthquakes of the last 24 hours.", { taxonomy: { ...FX, domain: "earthquakes_geology" }, taskSpec: { dataNeeds: [{ id: "q" }] } }),
    nodes: [
      { id: "input", type: "input", config: {} },
      { id: "w", type: "llm", config: { prompt } },
      { id: "output", type: "output", config: { value: { text: "{{nodes.w.output.text}}" } } },
    ],
  });
  const evolver = (tests: TestCase[], library?: unknown): AgentSpec => ({
    ...libAgent("ev", ""),
    nodes: [
      { id: "input", type: "input", config: {} },
      // The spec comes from the input: its templates must stay templates.
      { id: "evolve", type: "anvil_evolve", config: { spec: "{{input.spec}}", tests, maxRounds: 1, ...(library ? { library } : {}) } },
      { id: "output", type: "output", config: { value: "{{nodes.evolve.output}}" } },
    ],
    edges: [
      { from: "input", to: "evolve" },
      { from: "evolve", to: "output" },
    ],
  });
  const test = (criteria: string[]): TestCase => ({ id: "t1", name: "typical", input: {}, criteria, checks: [] });

  it("saves a test item that the diagnosis gives to the test as a test problem of the domain", async () => {
    const client = new FakeClient(
      () => "One earthquake in Feke.",
      (id, q) => {
        if (q.type === "noul" && String(q.instructions).includes(LIVE)) return { type: "noul", noul: 0.1 };
        if (/^d\d+$/.test(id) && q.type === "choice") return { type: "choice", choice: "test_live_value", confidence: 0.9, probabilities: {} };
        return defaultAnswer(id, q);
      },
    );
    const anvil = await anvilWith(client);
    await anvil.runs.run({ spec: evolver([test([GOOD, LIVE])]) }, { spec: quakes("Write the list.") });
    const list = (await allLessons(anvil.store)).earthquakes_geology;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "test_problem", pattern: "pipeline" });
    expect(list[0].text).toContain(`a test expected "${LIVE}"`);
  });

  it("saves the lesson of a critic change that improved the score, and the next critic of the domain sees it", async () => {
    const lesson = "Ask the model for every event in the period.";
    const client = new FakeClient(
      (req) => {
        const all = req.messages.map((m) => String(m.content)).join("\n");
        if (String(req.messages[0]?.content).includes("agent optimizer"))
          return JSON.stringify({ diagnosis: "The prompt is too short.", lesson, changes: ["Ask for all events."], operations: [{ op: "replace", path: "/nodes/1/config/prompt", value: "Write all events." }] });
        return all.includes("Write all events.") ? "One earthquake in Feke." : "Nothing.";
      },
      (id, q, s) => {
        if (q.type === "noul" && String(q.instructions).includes(GOOD)) return { type: "noul", noul: JSON.stringify(s).includes("Feke") ? 0.9 : 0.1 };
        if (/^d\d+$/.test(id) && q.type === "choice") return { type: "choice", choice: "agent", confidence: 0.9, probabilities: { agent: 0.9 } };
        return defaultAnswer(id, q);
      },
    );
    const anvil = await anvilWith(client);
    const r = await anvil.runs.run({ spec: evolver([test([GOOD])]) }, { spec: quakes("Write the list.") });
    expect((r.output as { evaluation: { passRate: number } }).evaluation.passRate).toBe(1);
    const list = (await allLessons(anvil.store)).earthquakes_geology;
    expect(list.map((l) => [l.kind, l.text])).toEqual([["agent_fix", lesson]]);
    // The next evolve of an agent of this domain gives the lesson to its critic, also without a build (from the class of the spec).
    client.chats.length = 0;
    await anvil.runs.run({ spec: evolver([test([GOOD])]) }, { spec: quakes("Write the list.") });
    const critic = client.chats.find((c) => String(c.messages[0]?.content).includes("agent optimizer"));
    expect(String(critic?.messages.at(-1)?.content)).toContain(`LESSONS OF THE DOMAIN "earthquakes_geology"`);
    expect(String(critic?.messages.at(-1)?.content)).toContain(lesson);
  });

  it("testgen gets the test problems of the domain", async () => {
    const client = new FakeClient((req) => (String(req.messages[0]?.content).includes("QA engineer") ? JSON.stringify({ tests: [{ name: "t", input: {}, criteria: [GOOD], checks: [] }] }) : "x"));
    const anvil = await anvilWith(client);
    await recordLessons(anvil.store, anvil.config.library, { domain: "earthquakes_geology", pattern: "pipeline" }, [{ kind: "test_problem", text: "A test expected an exact count." }]);
    const spec: AgentSpec = {
      ...libAgent("tg", ""),
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "testgen", type: "anvil_testgen", config: { taskSpec: { goal: "g", successCriteria: [], exampleInputs: [] }, spec: quakes("Write the list."), count: 1 } },
        { id: "output", type: "output", config: { value: "{{nodes.testgen.output}}" } },
      ],
      edges: [
        { from: "input", to: "testgen" },
        { from: "testgen", to: "output" },
      ],
    };
    await anvil.runs.run({ spec }, {});
    const qa = client.chats.find((c) => String(c.messages[0]?.content).includes("QA engineer"));
    expect(String(qa?.messages.at(-1)?.content)).toContain("A test expected an exact count.");
  });
});
