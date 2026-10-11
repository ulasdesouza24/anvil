import { z } from "zod";
import type { LibraryConfig, Thresholds } from "../core/config.js";
import type { AgentStoreLike, KVStore, NodeClass, Registry } from "../core/registry.js";
import type { AgentSpec, EvaluationReport, JSONSchema, Lesson, StoredAgent, Taxonomy } from "../core/types.js";
import { qualityOf } from "../core/quality.js";
import { validateSpec } from "../core/validator.js";
import type { Brain } from "../llm/brain.js";

/**
 * The library (docs/LIBRARY.md). Each agent has a class (a taxonomy with four
 * axes). A new build gets the best agents of the same class as examples, and
 * the lessons of its domain. This is not inheritance: the new agent does not
 * extend an old agent. It copies only the parts that fit, so an error or a
 * change in an old agent never goes into a new agent by itself.
 */

export const PATTERNS: Record<string, string> = {
  pipeline: "A fixed sequence of steps transforms the input into the output (e.g. fetch → extract → write).",
  classify_route: "Inputs must be categorized and each category handled differently (triage, routing, moderation, lead qualification).",
  map_reduce: "A list of items must each be processed and then combined (batch scoring, multi-document summary, enrichment).",
  generate_refine: "Content must meet an explicit quality bar and benefits from draft → critique → revise (copy, replies, translations).",
  research_agent: "Open-ended information gathering from the web or APIs where the exact steps cannot be predetermined.",
  rag_qa: "Answering or drafting grounded in documents / a knowledge base supplied by the user.",
  human_in_loop: "The process takes consequential actions (sending, posting, paying) that a person must approve first.",
};

export const SOURCE_KINDS: Record<Taxonomy["sourceKind"], string> = {
  api: "The agent gets its data from JSON APIs at run time.",
  web_page: "The agent gets its data from web pages or web search at run time.",
  document: "The agent works on documents or files that the person gives.",
  input_only: "The agent gets all its data from the input. It calls no outside source.",
  mixed: "The agent uses two or more of these kinds of sources.",
};

export const OUTPUT_KINDS: Record<Taxonomy["outputKind"], string> = {
  table: "A list or a table of records.",
  report: "A text report or a summary for a person.",
  decision: "A label, a category, a score, or a yes/no decision.",
  message: "A message, a reply, or a post for someone.",
  data: "Structured data for another system (fields, not prose).",
};

const LESSONS_NS = "library-lessons";
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

export const taxonomyOf = (spec: AgentSpec | undefined): Taxonomy | undefined => (spec?.meta?.taxonomy as Taxonomy | undefined) ?? undefined;

/** The current version of a stored agent. */
export function currentVersion(a: StoredAgent) {
  return a.versions.find((v) => v.version === a.currentVersion);
}

/** The configured domains and the domains that library agents use. */
export function knownDomains(store: AgentStoreLike, configured: string[]): string[] {
  const used = store
    .listAgents()
    .filter((a) => !a.system)
    .map((a) => taxonomyOf(currentVersion(a)?.spec)?.domain)
    .filter((d): d is string => !!d);
  return [...new Set([...configured.map(slug), ...used])].filter(Boolean);
}

/** What the classifier sees of an agent or a task. */
export interface ClassifySubject {
  name?: string;
  description?: string;
  goal?: string;
  request?: string;
  steps?: string[];
  inputs?: string[];
  outputs?: string[];
  dataNeeds?: string[];
  nodeTypes?: string[];
  /** A pattern that the triage selected. When set, Jev does not select it again. */
  pattern?: string;
}

/** The subject of a stored spec. */
export function subjectOfSpec(spec: AgentSpec): ClassifySubject {
  const task = spec.meta?.taskSpec as { goal?: string; steps?: string[]; dataNeeds?: { description: string }[] } | undefined;
  return {
    name: spec.name,
    description: spec.description,
    goal: task?.goal,
    request: typeof spec.meta?.request === "string" ? spec.meta.request : undefined,
    steps: task?.steps,
    inputs: Object.keys((spec.inputSchema as JSONSchema)?.properties ?? {}),
    dataNeeds: task?.dataNeeds?.map((n) => n.description),
    nodeTypes: spec.nodes.filter((n) => n.type !== "input" && n.type !== "output").map((n) => n.type),
    pattern: typeof spec.meta?.pattern === "string" && spec.meta.pattern in PATTERNS ? spec.meta.pattern : undefined,
  };
}

/**
 * Puts an agent or a task into a class: one Jev call for the four axes. When
 * no known domain fits, the model names a new domain, so the list grows with the library.
 */
export async function classify(brain: Brain, subject: ClassifySubject, domains: string[]): Promise<Taxonomy> {
  const domainChoices: Record<string, string> = Object.fromEntries(domains.map((d) => [d, `The subject area of the agent is ${d.replace(/_/g, " ")}.`]));
  domainChoices.other = "None of the listed subject areas fits the agent.";
  const a = await brain.decide({
    purpose: "classify the agent",
    state: { agent: subject },
    questions: {
      ...(subject.pattern ? {} : { pattern: { type: "choice" as const, instructions: "Which architecture pattern fits this agent best?", criteria: PATTERNS } }),
      domain: { type: "choice", instructions: "Which subject area (domain) does this agent work in?", criteria: domainChoices },
      sourceKind: { type: "choice", instructions: "Where does this agent get its data?", criteria: SOURCE_KINDS },
      outputKind: { type: "choice", instructions: "What does this agent give?", criteria: OUTPUT_KINDS },
    },
  });
  const pick = <T extends string>(id: string, allowed: Record<string, unknown>, fallback: T): T => {
    const x = a[id];
    return (x?.type === "choice" && x.choice in allowed ? x.choice : fallback) as T;
  };
  let domain: string = pick("domain", domainChoices, "other");
  if (domain === "other") {
    const named = await brain
      .json<{ domain: string }>({
        purpose: "name a new domain",
        tier: "fast",
        system: "You name the subject area (domain) of an AI agent. Use one to three common English words in snake_case, for example currency_exchange or job_listings. Use a general area, not the exact task.",
        user: `AGENT: ${JSON.stringify(subject)}\nKNOWN DOMAINS (use none of them): ${domains.join(", ") || "(none)"}`,
        schema: { type: "object", properties: { domain: { type: "string" } }, required: ["domain"] },
        check: (v) => (/^[a-z][a-z0-9_]{1,39}$/.test(slug(v.domain)) ? [] : ["domain must be snake_case, 2 to 40 characters"]),
        maxTokens: 300,
      })
      .catch(() => ({ domain: "general" }));
    domain = slug(named.domain) || "general";
  }
  return {
    pattern: subject.pattern ?? pick("pattern", PATTERNS, "pipeline"),
    domain,
    sourceKind: pick("sourceKind", SOURCE_KINDS, "mixed"),
    outputKind: pick("outputKind", OUTPUT_KINDS, "data"),
  };
}

/* ------------------------------ quality gate ------------------------------ */

export interface GateResult {
  ok: boolean;
  reason?: string;
  spec?: AgentSpec;
  version?: number;
  evaluation?: EvaluationReport;
}

/**
 * Only a good agent can be an example: its quality is "passed", its score is
 * at least the minimum, and it compiles with the current rules of the compiler.
 */
export function exampleGate(agent: StoredAgent, registry: Registry, th: Pick<Thresholds, "exampleMinScore">, getAgent?: (id: string) => StoredAgent | undefined): GateResult {
  if (agent.system) return { ok: false, reason: "system agent" };
  const v = currentVersion(agent);
  if (!v) return { ok: false, reason: "no current version" };
  const evaluation = v.evaluation as EvaluationReport | undefined;
  const quality = qualityOf(evaluation);
  if (quality !== "passed") return { ok: false, reason: `quality is ${quality}`, spec: v.spec, version: v.version };
  const score = evaluation?.score ?? 0;
  if (score < th.exampleMinScore) return { ok: false, reason: `score ${score.toFixed(2)} is below ${th.exampleMinScore}`, spec: v.spec, version: v.version };
  const check = validateSpec(v.spec, registry, { getAgent });
  if (!check.valid) {
    const first = check.diagnostics.find((d) => d.severity === "error");
    return { ok: false, reason: `does not compile with the current rules (${first?.code ?? "error"})`, spec: v.spec, version: v.version };
  }
  return { ok: true, spec: v.spec, version: v.version, evaluation };
}

/* -------------------------------- examples -------------------------------- */

export interface LibraryExample {
  agentId: string;
  version: number;
  name: string;
  description: string;
  taxonomy?: Taxonomy;
  score: number | null;
  /** The similarity from Jev. Null for an example that the person selected. */
  similarity: number | null;
  /** The person selected this example. */
  forced?: boolean;
  /** The classes (x_ types) and the sources of the example: parts that a new build can use again. */
  classes: string[];
  sources: { needId: string; url?: string; classType?: string }[];
  /** The mean cost of one run of the example in its tests (USD). Null without evaluated tests. */
  runCostUsd?: number | null;
  /** The example as text for a prompt. */
  text: string;
}

export interface Candidate {
  agentId: string;
  name: string;
  taxonomy?: Taxonomy;
  /** How many axes match the class of the new task (pattern and domain). */
  match: number;
  score: number | null;
  similarity?: number;
  selected: boolean;
  reason: string;
}

/** The tested sources of a spec: the primary source of each data need in its source plan. */
export function sourcesOf(spec: AgentSpec): LibraryExample["sources"] {
  const needs = ((spec.meta?.plan as { sourcePlan?: { needs?: { need: { id: string }; primary?: { candidate: { url?: string; classType?: string } } | null }[] } } | undefined)?.sourcePlan?.needs ??
    []) as { need: { id: string }; primary?: { candidate: { url?: string; classType?: string } } | null }[];
  return needs.filter((n) => n.primary).map((n) => ({ needId: n.need.id, url: n.primary!.candidate.url, classType: n.primary!.candidate.classType }));
}

/** The example as text: the parts that a builder can use again, and the spec without its tests and build data. */
/** The mean cost of one run of an agent in its evaluation: the cost of the test runs for each test that ran. */
export function runCostOf(evaluation: EvaluationReport | undefined): number | null {
  const ran = (evaluation?.results ?? []).filter((r) => !r.skipped).length;
  return evaluation && ran ? evaluation.costUsd / ran : null;
}

export function exampleText(
  spec: AgentSpec,
  info: { score: number | null; similarity: number | null; classes: string[]; sources: LibraryExample["sources"]; runCostUsd?: number | null },
  chars: number,
): string {
  const ai = spec.nodes.filter((n) => !["input", "output", "code", "transform", "router", "merge", "http", "map"].includes(n.type) && !n.type.startsWith("x_")).length;
  const head = [
    `EXAMPLE "${spec.name}": ${spec.description}`,
    `score ${info.score?.toFixed(2) ?? "—"}${info.similarity !== null ? `, similarity ${info.similarity.toFixed(2)}` : ", selected by the person"}${
      info.runCostUsd !== null && info.runCostUsd !== undefined ? `, cost of one run about $${info.runCostUsd.toFixed(5)}` : ""
    }, ${ai} model step(s)`,
    info.classes.length ? `Library classes that it uses: ${info.classes.join(", ")}` : "",
    info.sources.length ? `Tested sources: ${info.sources.map((s) => `${s.needId} → ${s.url ?? s.classType}`).join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const body = JSON.stringify({ inputSchema: spec.inputSchema, nodes: spec.nodes, edges: spec.edges });
  const room = Math.max(400, chars - head.length - 20);
  return `${head}\nGRAPH: ${body.length > room ? `${body.slice(0, room)}…` : body}`;
}

export interface FindOptions {
  /** Agents that the person selected as examples. They skip the similarity check, not the compiler check. */
  include?: string[];
  /** Agents that the person does not want as examples. */
  exclude?: string[];
}

/** The task of a build, for the similarity question. */
export interface TaskSubject {
  goal: string;
  steps: string[];
  inputs: string[];
  outputs: string[];
  dataNeeds: string[];
}

/**
 * Finds the examples for a new task:
 * 1. Library agents of the same pattern or domain that pass the quality gate.
 *    An agent without a class gets one now, and the class is saved.
 * 2. Jev compares each candidate with the new task. Candidates above the threshold are examples, the best first.
 */
export async function findExamples(
  deps: { brain: Brain; store: AgentStoreLike; registry: Registry; cfg: LibraryConfig; th: Thresholds },
  taxonomy: Taxonomy,
  task: TaskSubject,
  opts: FindOptions = {},
): Promise<{ examples: LibraryExample[]; candidates: Candidate[] }> {
  const { brain, store, registry, cfg, th } = deps;
  const exclude = new Set(opts.exclude ?? []);
  const include = new Set((opts.include ?? []).filter((id) => !exclude.has(id)));
  const candidates: Candidate[] = [];
  const pool: { agent: StoredAgent; gate: GateResult; taxonomy?: Taxonomy; match: number }[] = [];
  const domains = knownDomains(store, cfg.domains);
  let classified = 0;
  for (const agent of store.listAgents()) {
    if (agent.system || exclude.has(agent.id)) continue;
    const gate = exampleGate(agent, registry, th, (id) => store.getAgent(id));
    if (!gate.ok && !(include.has(agent.id) && gate.spec)) continue;
    let tax = taxonomyOf(gate.spec);
    // An agent from before the library has no class. It gets one now, a few for each build.
    if (!tax && gate.spec && classified < cfg.maxCandidates) {
      tax = await classify(brain, subjectOfSpec(gate.spec), domains);
      classified++;
      await store.setMeta?.(agent.id, gate.version!, { taxonomy: tax });
    }
    const match = tax ? Number(tax.pattern === taxonomy.pattern) + Number(tax.domain === taxonomy.domain) : 0;
    if (!match && !include.has(agent.id)) continue;
    pool.push({ agent, gate, taxonomy: tax, match });
  }
  pool.sort((a, b) => Number(include.has(b.agent.id)) - Number(include.has(a.agent.id)) || b.match - a.match || (b.gate.evaluation?.score ?? 0) - (a.gate.evaluation?.score ?? 0));
  const compared = pool.slice(0, Math.max(cfg.maxCandidates, include.size));
  const toAsk = compared.filter((c) => !include.has(c.agent.id));
  const sims: Record<string, number> = {};
  if (toAsk.length) {
    const a = await brain.decide({
      purpose: "compare library agents with the new task",
      state: {
        new_task: task,
        library_agents: toAsk.map((c, i) => ({
          i,
          name: c.agent.name,
          description: c.agent.description,
          class: c.taxonomy,
          steps: c.gate.spec!.nodes.filter((n) => n.type !== "input" && n.type !== "output").map((n) => `${n.id} [${n.type}]`),
          inputs: Object.keys((c.gate.spec!.inputSchema as JSONSchema)?.properties ?? {}),
        })),
      },
      questions: Object.fromEntries(
        toAsk.map((c, i) => [
          `s${i}`,
          {
            type: "noul" as const,
            instructions: `Is library agent #${i} ("${c.agent.name}") a good example for the new task? A good example uses the same kind of data or source, has similar steps, and gives a similar output. The same subject with different steps is a weaker example.`,
          },
        ]),
      ),
    });
    toAsk.forEach((c, i) => {
      const x = a[`s${i}`];
      sims[c.agent.id] = x?.type === "noul" ? x.noul : 0;
    });
  }
  const ranked = compared
    .map((c) => ({ ...c, similarity: include.has(c.agent.id) ? null : (sims[c.agent.id] ?? 0) }))
    .filter((c) => c.similarity === null || c.similarity >= th.exampleMatch)
    .sort((a, b) => (b.similarity ?? 2) - (a.similarity ?? 2));
  const chosen = ranked.slice(0, Math.max(cfg.maxExamples, include.size));
  for (const c of compared) {
    const sel = chosen.some((x) => x.agent.id === c.agent.id);
    const sim = include.has(c.agent.id) ? undefined : sims[c.agent.id];
    candidates.push({
      agentId: c.agent.id,
      name: c.agent.name,
      taxonomy: c.taxonomy,
      match: c.match,
      score: c.gate.evaluation?.score ?? null,
      ...(sim !== undefined ? { similarity: Math.round(sim * 100) / 100 } : {}),
      selected: sel,
      reason: include.has(c.agent.id)
        ? "selected by the person"
        : sel
          ? "similar to the new task"
          : (sim ?? 0) < th.exampleMatch
            ? `similarity ${(sim ?? 0).toFixed(2)} is below ${th.exampleMatch}`
            : "a more similar example was selected",
    });
  }
  const examples = chosen.map((c): LibraryExample => {
    const spec = c.gate.spec!;
    const classes = [...new Set(spec.nodes.map((n) => n.type).filter((t) => t.startsWith("x_")))];
    const sources = sourcesOf(spec);
    const score = c.gate.evaluation?.score ?? null;
    const runCostUsd = runCostOf(c.gate.evaluation);
    return {
      agentId: c.agent.id,
      version: c.gate.version!,
      name: c.agent.name,
      description: c.agent.description,
      taxonomy: c.taxonomy,
      score,
      similarity: c.similarity === null ? null : Math.round(c.similarity * 100) / 100,
      ...(c.similarity === null ? { forced: true } : {}),
      classes,
      sources,
      runCostUsd,
      text: exampleText(spec, { score, similarity: c.similarity, classes, sources, runCostUsd }, cfg.exampleChars),
    };
  });
  return { examples, candidates };
}

/* --------------------------------- lessons -------------------------------- */

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
const sameLesson = (a: Pick<Lesson, "kind" | "text" | "source">, b: Pick<Lesson, "kind" | "text" | "source">) =>
  a.kind === b.kind && (a.source && b.source ? a.source === b.source : norm(a.text) === norm(b.text));
const OPPOSITE: Partial<Record<Lesson["kind"], Lesson["kind"]>> = { source_ok: "source_blocked", source_blocked: "source_ok" };

export type NewLesson = Pick<Lesson, "kind" | "text" | "source" | "from">;

/**
 * Saves lessons for a domain. The same lesson again counts one more time. A
 * source lesson replaces the opposite lesson for the same source (a source can
 * start to work or stop). The domain keeps its newest and most frequent lessons.
 */
export async function recordLessons(kv: KVStore, cfg: Pick<LibraryConfig, "maxLessons">, taxonomy: Pick<Taxonomy, "domain" | "pattern">, items: NewLesson[]): Promise<Lesson[]> {
  if (!items.length) return [];
  const now = Date.now();
  const list = ((await kv.get(LESSONS_NS, taxonomy.domain)) as Lesson[] | undefined)?.slice() ?? [];
  const touched: Lesson[] = [];
  for (const item of items) {
    const text = item.text.replace(/\s+/g, " ").trim().slice(0, 500);
    if (!text) continue;
    const opposite = OPPOSITE[item.kind];
    if (opposite && item.source) for (let i = list.length - 1; i >= 0; i--) if (list[i].kind === opposite && list[i].source === item.source) list.splice(i, 1);
    const found = list.find((l) => sameLesson(l, { ...item, text }));
    if (found) {
      found.count++;
      found.lastAt = now;
      found.text = text;
      if (item.from) found.from = item.from;
      touched.push(found);
    } else {
      const l: Lesson = { id: `l_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`, domain: taxonomy.domain, pattern: taxonomy.pattern, kind: item.kind, text, ...(item.source ? { source: item.source } : {}), count: 1, firstAt: now, lastAt: now, ...(item.from ? { from: item.from } : {}) };
      list.push(l);
      touched.push(l);
    }
  }
  list.sort((a, b) => b.lastAt - a.lastAt || b.count - a.count);
  await kv.set(LESSONS_NS, taxonomy.domain, list.slice(0, cfg.maxLessons));
  return touched;
}

/** The lessons of a domain for a prompt: not too old, the same pattern first, then the most frequent and the newest. */
export async function lessonsFor(kv: KVStore, cfg: Pick<LibraryConfig, "lessonsInPrompt" | "lessonMaxAgeDays">, taxonomy: Pick<Taxonomy, "domain" | "pattern">, now = Date.now()): Promise<Lesson[]> {
  const list = ((await kv.get(LESSONS_NS, taxonomy.domain)) as Lesson[] | undefined) ?? [];
  const minAt = now - cfg.lessonMaxAgeDays * 86_400_000;
  return list
    .filter((l) => l.lastAt >= minAt)
    .sort((a, b) => Number(b.pattern === taxonomy.pattern) - Number(a.pattern === taxonomy.pattern) || b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, cfg.lessonsInPrompt);
}

/**
 * A domain is wide: a lesson of one agent can be noise for another task of the same domain.
 * Jev asks for each candidate lesson if it applies to the new task. The lessons above the
 * threshold are used, the most probable first.
 */
export async function relevantLessons(
  brain: Brain,
  kv: KVStore,
  cfg: Pick<LibraryConfig, "lessonsInPrompt" | "lessonMaxAgeDays">,
  th: Pick<Thresholds, "lessonMatch">,
  taxonomy: Pick<Taxonomy, "domain" | "pattern">,
  task: TaskSubject,
): Promise<{ lessons: Lesson[]; dropped: { lesson: Lesson; p: number }[] }> {
  const candidates = await lessonsFor(kv, { ...cfg, lessonsInPrompt: cfg.lessonsInPrompt * 2 }, taxonomy);
  if (!candidates.length) return { lessons: [], dropped: [] };
  const a = await brain.decide({
    purpose: "select the lessons for the new task",
    state: { new_task: task, lessons: candidates.map((l, i) => ({ i, kind: l.kind, text: l.text })) },
    questions: Object.fromEntries(
      candidates.map((l, i) => [
        `l${i}`,
        {
          type: "noul" as const,
          instructions: `Does lesson #${i} apply to the new task? It applies when the new task can make the same error, can have the same kind of test, or can use the same source. A lesson about a different kind of task does not apply.`,
        },
      ]),
    ),
  });
  const scored = candidates.map((lesson, i) => {
    const x = a[`l${i}`];
    return { lesson, p: x?.type === "noul" ? x.noul : 0 };
  });
  const kept = scored.filter((s) => s.p >= th.lessonMatch).sort((x, y) => y.p - x.p);
  return { lessons: kept.slice(0, cfg.lessonsInPrompt).map((s) => s.lesson), dropped: scored.filter((s) => s.p < th.lessonMatch) };
}

export async function allLessons(kv: KVStore): Promise<Record<string, Lesson[]>> {
  return (await kv.list(LESSONS_NS)) as Record<string, Lesson[]>;
}

export async function deleteLesson(kv: KVStore, domain: string, id: string): Promise<boolean> {
  const list = ((await kv.get(LESSONS_NS, domain)) as Lesson[] | undefined) ?? [];
  const next = list.filter((l) => l.id !== id);
  if (next.length === list.length) return false;
  if (next.length) await kv.set(LESSONS_NS, domain, next);
  else await kv.delete(LESSONS_NS, domain);
  return true;
}

/* ------------------------------ prompt sections ---------------------------- */

/** The output of the library step of a build. */
export interface LibraryContext {
  enabled: boolean;
  taxonomy: Taxonomy;
  examples: LibraryExample[];
  lessons: Lesson[];
}

const LESSON_TITLE: Record<Lesson["kind"], string> = {
  agent_fix: "Errors that earlier builds of this domain made, and their fixes",
  test_problem: "Test items that were wrong in earlier builds of this domain",
  source_ok: "Sources that worked in this domain",
  source_blocked: "Sources that did not work in this domain",
};

export function lessonsText(lessons: Lesson[], kinds: Lesson["kind"][]): string {
  return kinds
    .map((k) => {
      const ls = lessons.filter((l) => l.kind === k);
      return ls.length ? `${LESSON_TITLE[k]}:\n${ls.map((l) => `- ${l.text}${l.count > 1 ? ` (${l.count} builds)` : ""}`).join("\n")}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * The library section of a prompt. Each step of the builder gets the part that it can use:
 * - architect and compose: the examples, the agent errors, and the sources
 * - testgen: the test problems
 * - critic: the agent errors
 */
export function libraryPrompt(lib: LibraryContext | null | undefined, part: "architect" | "compose" | "testgen" | "critic"): string {
  if (!lib?.enabled) return "";
  const kinds: Lesson["kind"][] =
    part === "testgen" ? ["test_problem"] : part === "critic" ? ["agent_fix"] : ["agent_fix", "source_ok", "source_blocked"];
  const lessons = lessonsText(lib.lessons, kinds);
  const examples =
    part === "architect" || part === "compose"
      ? lib.examples.length
        ? `LIBRARY EXAMPLES (tested agents of the same class "${lib.taxonomy.pattern} / ${lib.taxonomy.domain}"). Use them as examples. Use again their library classes and tested sources when they fit this task. Do not copy steps that this task does not need. The task spec and the source plan of this build come first. Build the new agent with its own steps: do not call an example agent with a subagent step, because the new agent must not change when the example changes. An example shows one design that works, not the cheapest one: each run of the agent costs money. When fewer model calls in each run do this task as well (for example one structured call instead of one call for each item), use the cheaper design.\n${lib.examples.map((e) => e.text).join("\n\n")}`
        : ""
      : "";
  const parts = [examples, lessons ? `LESSONS OF THE DOMAIN "${lib.taxonomy.domain}" (from earlier builds):\n${lessons}` : ""].filter(Boolean);
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

/** Source hints for the source plan: the tested sources of the examples and the sources that worked, and the sources that did not. */
export function sourceHints(lib: LibraryContext | null | undefined): { good: { url: string; description: string }[]; blocked: Set<string>; text: string } {
  if (!lib?.enabled) return { good: [], blocked: new Set(), text: "" };
  const good = new Map<string, string>();
  for (const e of lib.examples) for (const s of e.sources) if (s.url) good.set(s.url, `the tested source of "${s.needId}" in the library agent ${e.agentId}`);
  for (const l of lib.lessons) if (l.kind === "source_ok" && l.source && /^https?:\/\//.test(l.source)) good.set(l.source, l.text);
  const blocked = new Set(lib.lessons.filter((l) => l.kind === "source_blocked" && l.source).map((l) => l.source!));
  for (const b of blocked) good.delete(b);
  return { good: [...good].map(([url, description]) => ({ url, description })), blocked, text: lessonsText(lib.lessons, ["source_ok", "source_blocked"]) };
}

/* --------------------------- classify the library -------------------------- */

/**
 * Gives a class to each library agent that has none (or to all agents with force).
 * The class goes into spec.meta.taxonomy of the current version. No new version is made.
 */
export async function classifyLibrary(
  deps: { brain: Brain; store: AgentStoreLike; cfg: Pick<LibraryConfig, "domains"> },
  opts: { force?: boolean; onClassified?: (agentId: string, t: Taxonomy) => void } = {},
): Promise<{ agentId: string; taxonomy: Taxonomy }[]> {
  const out: { agentId: string; taxonomy: Taxonomy }[] = [];
  for (const agent of deps.store.listAgents()) {
    if (agent.system) continue;
    const v = currentVersion(agent);
    if (!v || (!opts.force && taxonomyOf(v.spec))) continue;
    const taxonomy = await classify(deps.brain, subjectOfSpec(v.spec), knownDomains(deps.store, deps.cfg.domains));
    await deps.store.setMeta?.(agent.id, v.version, { taxonomy });
    out.push({ agentId: agent.id, taxonomy });
    opts.onClassified?.(agent.id, taxonomy);
  }
  return out;
}

/* ------------------------------ the build step ----------------------------- */

const ids = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map(String).filter(Boolean)
    : typeof v === "string"
      ? v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
const isOff = (v: unknown) => v === false || v === "false" || v === 0 || v === "off";

const LibraryNodeConfig = z.object({
  request: z.string().optional(),
  taskSpec: z.unknown(),
  triage: z.unknown().optional(),
  /** false: no examples and no lessons for this build (the class is still found). */
  enabled: z.unknown().optional(),
  /** Agent ids that the person selected as examples. */
  include: z.unknown().optional(),
  /** Agent ids that the person does not want as examples. */
  exclude: z.unknown().optional(),
});

interface TaskLike {
  name: string;
  summary: string;
  goal: string;
  steps: string[];
  inputs: { name: string }[];
  outputs: { name: string }[];
  dataNeeds?: { description: string }[];
}

export const AnvilLibraryNode: NodeClass<z.infer<typeof LibraryNodeConfig>> = {
  type: "anvil_library",
  title: "Library match",
  category: "anvil",
  internal: true,
  defaultTimeoutMs: 0, // meta-steps are bounded by the run policy timeout
  description:
    "Puts the task into a class (pattern, domain, source kind, output kind), finds the best tested library agents of the same class as examples, and gets the lessons of the domain.",
  whenToUse: "After analysis, before the source plan.",
  configSchema: LibraryNodeConfig,
  example: { taskSpec: "{{nodes.analyze.output.taskSpec}}", triage: "{{nodes.triage.output}}" },
  async execute(ctx) {
    const t = ctx.config.taskSpec as TaskLike;
    const triage = ctx.config.triage as { pattern?: string } | undefined;
    const cfg = ctx.brain.config;
    const subject: ClassifySubject = {
      name: t.name,
      description: t.summary,
      goal: t.goal,
      request: ctx.config.request,
      steps: t.steps,
      inputs: t.inputs.map((i) => i.name),
      outputs: t.outputs.map((o) => o.name),
      dataNeeds: (t.dataNeeds ?? []).map((n) => n.description),
      pattern: triage?.pattern && triage.pattern in PATTERNS ? triage.pattern : undefined,
    };
    const taxonomy = await classify(ctx.brain, subject, knownDomains(ctx.services.store, cfg.library.domains));
    const enabled = cfg.library.examples && !isOff(ctx.config.enabled);
    let examples: LibraryExample[] = [];
    let candidates: Candidate[] = [];
    let lessons: Lesson[] = [];
    let droppedLessons: { text: string; kind: Lesson["kind"]; p: number }[] = [];
    if (enabled) {
      ({ examples, candidates } = await findExamples(
        { brain: ctx.brain, store: ctx.services.store, registry: ctx.services.registry, cfg: cfg.library, th: cfg.thresholds },
        taxonomy,
        { goal: t.goal, steps: t.steps, inputs: subject.inputs!, outputs: subject.outputs!, dataNeeds: subject.dataNeeds! },
        { include: ids(ctx.config.include), exclude: ids(ctx.config.exclude) },
      ));
      const picked = await relevantLessons(ctx.brain, ctx.services.kv, cfg.library, cfg.thresholds, taxonomy, {
        goal: t.goal,
        steps: t.steps,
        inputs: subject.inputs!,
        outputs: subject.outputs!,
        dataNeeds: subject.dataNeeds!,
      });
      lessons = picked.lessons;
      droppedLessons = picked.dropped.map((d) => ({ text: d.lesson.text, kind: d.lesson.kind, p: Math.round(d.p * 100) / 100 }));
    }
    ctx.emit({
      type: "artifact",
      kind: "library",
      data: { taxonomy, enabled, examples: examples.map(({ text: _text, ...e }) => e), candidates, lessons, droppedLessons },
    });
    ctx.log(
      enabled
        ? `class ${taxonomy.pattern} / ${taxonomy.domain}: ${examples.length} example(s) (${examples.map((e) => e.agentId).join(", ") || "none"}), ${lessons.length} lesson(s)`
        : `class ${taxonomy.pattern} / ${taxonomy.domain}: library examples are off`,
    );
    const output: LibraryContext & { candidates: Candidate[] } = { enabled, taxonomy, examples, lessons, candidates };
    return { output };
  },
};

/**
 * The library context of a step after the library step: the one that the build gives, or, for an
 * agent that a person refines or evolves later, the lessons of the class of its spec.
 */
export async function libraryForSpec(kv: KVStore, cfg: LibraryConfig, spec: AgentSpec | undefined, given?: LibraryContext | null): Promise<LibraryContext | null> {
  if (given?.taxonomy) return given;
  const taxonomy = taxonomyOf(spec);
  if (!taxonomy || !cfg.examples) return null;
  return { enabled: true, taxonomy, examples: [], lessons: await lessonsFor(kv, cfg, taxonomy) };
}
