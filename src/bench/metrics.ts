import type { RunEvent, RunRecord } from "../core/types.js";

/**
 * Metrics for one benchmark case. The values come from the events of the
 * build run and of its child runs (the evaluation runs).
 */
export interface BenchMetrics {
  published: boolean;
  agentId: string | null;
  score: number | null;
  passRate: number | null;
  costUsd: number;
  buildCostUsd: number;
  evalCostUsd: number;
  durationMs: number;
  llmCalls: number;
  decisionCalls: number;
  webSearches: number;
  inputTokens: number;
  outputTokens: number;
  repairs: number;
  evolveRounds: number;
  acceptedRounds: number;
  /** Harness metrics (see docs/HARNESS.md, section 6). */
  repeatedToolCalls: number;
  toolCalls: number;
  tokensPerStepAvg: number;
  tokensPerStepMax: number;
  cacheHitRate: number;
  recallReads: number;
  oversizedParts: number;
  detailedSummaries: number;
  compactions: number;
  strategySteps: Record<string, number>;
  partialRuns: number;
  evalRuns: number;
  partialRate: number;
  /** Evolve metrics: test items that evolve removed as test errors, candidates that the intent guard rejected, and the diagnosis of the last evaluation. */
  testItemsRemoved: number;
  intentRejections: number;
  agentProblems: number;
  testProblems: number;
  disputedItems: number;
  /** Tests of the last evaluation that failed because of the environment (for example a rate limit), without a score. */
  environmentTests: number;
  /** The environment (for example a rate limit) stopped every test of the last evaluation: the score says nothing about the build. */
  unmeasured: boolean;
  /** Acceptance rules that evolve removed, because the outputs met every test item. */
  acceptanceRulesRemoved: number;
  /** Library metrics (docs/LIBRARY.md): the class of the task, the examples and the lessons that the build used. */
  domain: string | null;
  examplesUsed: number;
  lessonsUsed: number;
  /** Sandbox metrics: the programs that ran, how many failed, and their time. */
  programs: number;
  failedPrograms: number;
  sandboxMs: number;
}

/** The harness reports its actions as artifact events of this kind. */
export const HARNESS_ARTIFACT = "harness";
export type HarnessEventName = "recall" | "oversized_part" | "detailed_summary" | "compaction" | "strategy" | "repeat_blocked" | "partial";

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** Counts the harness numbers from the events of one run. */
function scanRun(events: RunEvent[], acc: BenchMetrics, perStep: number[], cache: { input: number; cached: number }) {
  const seen = new Map<string, number>();
  for (const e of events) {
    if (e.type === "llm") {
      acc.llmCalls++;
      acc.inputTokens += e.inputTokens;
      acc.outputTokens += e.outputTokens;
      if (e.purpose.startsWith("web search")) acc.webSearches++;
      else perStep.push(e.inputTokens + e.outputTokens);
      if (!e.model.startsWith("openrouter:")) {
        cache.input += e.inputTokens;
        cache.cached += e.cachedTokens ?? 0;
      }
    } else if (e.type === "decision") acc.decisionCalls++;
    else if (e.type === "log" && e.message.startsWith("tool ")) {
      acc.toolCalls++;
      const args = (e.data as { args?: unknown } | undefined)?.args;
      // A repeated call has the same node, the same tool, and the same arguments.
      const key = `${e.nodeId ?? ""}|${e.message}|${canonical(args ?? null)}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n > 1) acc.repeatedToolCalls++;
    } else if (e.type === "artifact" && e.kind === "acceptanceAdjusted") {
      acc.acceptanceRulesRemoved += ((e.data as { removed?: unknown[] } | undefined)?.removed ?? []).length;
    } else if (e.type === "artifact" && e.kind === "testsAdjusted") {
      acc.testItemsRemoved += ((e.data as { dropped?: unknown[] } | undefined)?.dropped ?? []).length;
    } else if (e.type === "artifact" && e.kind === "code") {
      acc.programs++;
      if (!(e.data as { ok?: boolean } | undefined)?.ok) acc.failedPrograms++;
    } else if (e.type === "artifact" && e.kind === "library") {
      const d = (e.data ?? {}) as { taxonomy?: { domain?: string }; examples?: unknown[]; lessons?: unknown[] };
      acc.domain = d.taxonomy?.domain ?? acc.domain;
      acc.examplesUsed = d.examples?.length ?? 0;
      acc.lessonsUsed = d.lessons?.length ?? 0;
    } else if (e.type === "artifact" && e.kind === "intentRejected") {
      acc.intentRejections++;
    } else if (e.type === "artifact" && e.kind === HARNESS_ARTIFACT) {
      const d = (e.data ?? {}) as { event?: HarnessEventName; strategy?: string };
      if (d.event === "recall") acc.recallReads++;
      else if (d.event === "oversized_part") acc.oversizedParts++;
      else if (d.event === "detailed_summary") acc.detailedSummaries++;
      else if (d.event === "compaction") acc.compactions++;
      else if (d.event === "repeat_blocked") acc.repeatedToolCalls++;
      else if (d.event === "strategy" && d.strategy) acc.strategySteps[d.strategy] = (acc.strategySteps[d.strategy] ?? 0) + 1;
    }
  }
}

function isPartial(r: RunRecord): boolean {
  const h = (r as RunRecord & { harness?: { status?: string } }).harness;
  if (h?.status === "partial") return true;
  const out = r.output as { status?: unknown } | null | undefined;
  return !!out && typeof out === "object" && out.status === "partial";
}

/** Builds the metrics of one case from the build record and its child runs. */
export function collectMetrics(build: RunRecord, children: RunRecord[]): BenchMetrics {
  const out = (build.output ?? {}) as { agentId?: string; score?: number | null; passRate?: number | null; repairs?: number; evolution?: { accepted: boolean }[] };
  const m: BenchMetrics = {
    published: build.status === "completed" && !!out.agentId,
    agentId: out.agentId ?? null,
    score: typeof out.score === "number" ? out.score : null,
    passRate: typeof out.passRate === "number" ? out.passRate : null,
    costUsd: build.usage.costUsd,
    buildCostUsd: 0,
    evalCostUsd: children.reduce((a, c) => a + c.usage.costUsd, 0),
    durationMs: (build.endedAt ?? Date.now()) - build.startedAt,
    llmCalls: 0,
    decisionCalls: 0,
    webSearches: 0,
    inputTokens: 0,
    outputTokens: 0,
    repairs: out.repairs ?? 0,
    evolveRounds: Math.max(0, (out.evolution?.length ?? 1) - 1),
    acceptedRounds: Math.max(0, (out.evolution?.filter((h) => h.accepted).length ?? 1) - 1),
    repeatedToolCalls: 0,
    toolCalls: 0,
    tokensPerStepAvg: 0,
    tokensPerStepMax: 0,
    cacheHitRate: 0,
    recallReads: 0,
    oversizedParts: 0,
    detailedSummaries: 0,
    compactions: 0,
    strategySteps: {},
    partialRuns: 0,
    evalRuns: children.length,
    partialRate: 0,
    testItemsRemoved: 0,
    intentRejections: 0,
    agentProblems: 0,
    testProblems: 0,
    disputedItems: 0,
    environmentTests: 0,
    unmeasured: false,
    acceptanceRulesRemoved: 0,
    domain: null,
    examplesUsed: 0,
    lessonsUsed: 0,
    programs: 0,
    failedPrograms: 0,
    sandboxMs: (build.usage.sandboxMs ?? 0) + children.reduce((a, c) => a + (c.usage.sandboxMs ?? 0), 0),
  };
  const perStep: number[] = [];
  const cache = { input: 0, cached: 0 };
  scanRun(build.events, m, perStep, cache);
  for (const c of children) scanRun(c.events, m, perStep, cache);
  m.buildCostUsd = Math.max(0, m.costUsd - m.evalCostUsd);
  m.tokensPerStepAvg = perStep.length ? Math.round(perStep.reduce((a, b) => a + b, 0) / perStep.length) : 0;
  m.tokensPerStepMax = perStep.length ? Math.max(...perStep) : 0;
  m.cacheHitRate = cache.input ? Math.round((cache.cached / cache.input) * 1000) / 1000 : 0;
  // The diagnosis of the last evaluation of the build.
  const last = [...build.events].reverse().find((e) => e.type === "artifact" && e.kind === "evaluation") as { data?: { report?: { agentProblems?: number; testProblems?: number; disputedProblems?: number; environmentTests?: number; results?: unknown[] } } } | undefined;
  m.agentProblems = last?.data?.report?.agentProblems ?? 0;
  m.testProblems = last?.data?.report?.testProblems ?? 0;
  m.disputedItems = last?.data?.report?.disputedProblems ?? 0;
  m.environmentTests = last?.data?.report?.environmentTests ?? 0;
  const tests = last?.data?.report?.results?.length ?? 0;
  if (tests && m.environmentTests >= tests) {
    m.unmeasured = true;
    m.score = null;
  }
  m.partialRuns = children.filter(isPartial).length;
  m.partialRate = children.length ? Math.round((m.partialRuns / children.length) * 1000) / 1000 : 0;
  return m;
}
