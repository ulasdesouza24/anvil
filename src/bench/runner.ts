import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseExternalTests } from "../core/externalTests.js";
import { builderFor } from "../builder/bestOf.js";
import type { AgentSpec, EvaluationReport, RunRecord, TestCase } from "../core/types.js";
import type { RunManager } from "../runtime/runManager.js";
import type { FileStore } from "../store/fileStore.js";
import { collectMetrics, type BenchMetrics } from "./metrics.js";

export const BenchCaseZ = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  category: z.string(),
  request: z.string().min(10),
  expect: z
    .object({ minScore: z.number().min(0).max(1).optional(), maxCostUsd: z.number().positive().optional(), minHiddenScore: z.number().min(0).max(1).optional() })
    .default({}),
  /** Given tools of the case (docs/TOOLS.md): the build is closed. */
  tools: z.unknown().optional(),
  /** Tests that the builder gets (docs/TESTS.md). */
  givenTests: z.unknown().optional(),
  /**
   * Hidden tests (docs/TESTS.md): the builder does not see them. After the build, they score the
   * published agent, as the tests of an event platform do.
   */
  hiddenTests: z.unknown().optional(),
  /**
   * The case starts when this case is done, so the agent of that case is in the library.
   * It measures the library: a build with a similar tested agent (docs/LIBRARY.md).
   */
  after: z.string().optional(),
});
export type BenchCase = z.infer<typeof BenchCaseZ>;

export const BenchSuiteZ = z.object({ version: z.number().int(), description: z.string().optional(), cases: z.array(BenchCaseZ).min(1) });
export type BenchSuite = z.infer<typeof BenchSuiteZ>;

export interface BenchCaseResult {
  id: string;
  category: string;
  runId: string | null;
  status: string;
  error?: string;
  metrics: BenchMetrics | null;
  /** Best-of-N: the builder model of the published candidate, and how it was selected. */
  selection?: { model: string; by: string; candidates: number };
  /** The result of the hidden tests on the published agent. */
  hidden?: { passRate: number; score: number; costUsd: number; tests: number; failed: string[] };
  /** True when the case meets its own expectations. */
  met: boolean;
  misses: string[];
}

export interface BenchReport {
  id: string;
  startedAt: number;
  endedAt: number;
  gitCommit: string | null;
  suiteVersion: number;
  options: BenchOptions;
  cases: BenchCaseResult[];
  totals: {
    cases: number;
    published: number;
    met: number;
    meanScore: number | null;
    costUsd: number;
    durationMs: number;
    repeatedToolCalls: number;
    tokensPerStepAvg: number;
    cacheHitRate: number;
    partialRate: number;
    /** Not in reports from before the evolve metrics. */
    testItemsRemoved?: number;
    intentRejections?: number;
    disputedItems?: number;
    environmentTests?: number;
    /** Cases where the environment stopped every test: they have no score. */
    unmeasured?: number;
    programs?: number;
    sandboxMs?: number;
    /** Best-of-N: the cases that the judge decided, and the wins of each builder model. */
    judged?: number;
    modelWins?: Record<string, number>;
    /** The mean score of the hidden tests, for the cases that have them. */
    hiddenMeanScore?: number | null;
    /** The examples and the lessons that the builds used (docs/LIBRARY.md). */
    examplesUsed?: number;
    lessonsUsed?: number;
  };
  skipped: { id: string; reason: string }[];
}

export interface BenchOptions {
  only?: string[];
  limit?: number;
  concurrency?: number;
  /** Do not start a new case when the total cost reaches this value. */
  budgetUsd?: number;
  evaluate?: boolean;
  optimize?: boolean;
  /** A case stops before it starts when its cost estimate is above this value. */
  maxBuildUsd?: number;
  /** false: the builds use no library examples and no lessons (to measure the library). */
  library?: boolean;
  /** Best-of-N (docs/SELECTION.md): true or "auto" for one candidate for each builder model, or a number. Without it, ANVIL_BEST_OF decides. */
  bestOf?: boolean | number | "auto";
}

export function loadSuite(file: string): BenchSuite {
  return BenchSuiteZ.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

function gitCommit(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export interface BenchDeps {
  runs: RunManager;
  store: FileStore;
  /** Starts one build. The default runs the anvil-builder meta-agent. */
  startBuild?: (c: BenchCase, o: BenchOptions) => RunRecord;
  onCaseDone?: (r: BenchCaseResult, totalCostUsd: number) => void;
  /** Runs the hidden tests on a published agent. Without it, the hidden tests do not run. */
  evaluate?: (spec: AgentSpec, tests: TestCase[]) => Promise<EvaluationReport>;
  /** The folder of the suite file: test file paths are relative to it. */
  baseDir?: string;
}

function checkExpect(c: BenchCase, m: BenchMetrics | null, hidden?: BenchCaseResult["hidden"]): string[] {
  if (!m) return ["no metrics"];
  if (c.expect.minHiddenScore !== undefined && (hidden?.score ?? 0) < c.expect.minHiddenScore) return [`hidden score ${hidden?.score ?? "none"} < ${c.expect.minHiddenScore}`, ...(m.published ? [] : ["not published"])];
  const misses: string[] = [];
  if (m.unmeasured) return ["not measured: the environment (for example a rate limit) stopped every test"];
  if (!m.published) misses.push("not published");
  if (c.expect.minScore !== undefined && (m.score ?? 0) < c.expect.minScore) misses.push(`score ${m.score ?? "none"} < ${c.expect.minScore}`);
  if (c.expect.maxCostUsd !== undefined && m.costUsd > c.expect.maxCostUsd) misses.push(`cost $${m.costUsd.toFixed(3)} > $${c.expect.maxCostUsd}`);
  return misses;
}

/** Tools can be the path of a JSON or YAML file, relative to the suite file. */
function toolsOf(tools: unknown, baseDir?: string): unknown {
  if (typeof tools !== "string" || !/\.(json|ya?ml)$/i.test(tools.trim()) || !baseDir) return tools;
  return fs.readFileSync(path.resolve(baseDir, tools.trim()), "utf8");
}

/** The hidden tests of a case on its published agent. A case without a published agent scores 0. */
async function hiddenResult(c: BenchCase, m: BenchMetrics | null, deps: BenchDeps): Promise<BenchCaseResult["hidden"]> {
  if (c.hiddenTests === undefined || !deps.evaluate) return undefined;
  const tests = parseExternalTests(c.hiddenTests, deps.baseDir ?? null);
  const spec = m?.agentId ? deps.store.getSpec(m.agentId) : undefined;
  if (!spec) return { passRate: 0, score: 0, costUsd: 0, tests: tests.length, failed: tests.map((t) => t.name) };
  try {
    const r = await deps.evaluate(spec, tests);
    return { passRate: r.passRate, score: r.score, costUsd: r.costUsd, tests: tests.length, failed: r.results.filter((x) => !x.passed).map((x) => x.name) };
  } catch (e) {
    return { passRate: 0, score: 0, costUsd: 0, tests: tests.length, failed: [`the hidden tests did not run: ${(e as Error).message}`] };
  }
}

/** Runs the selected cases and returns a report. Cases run in parallel up to `concurrency`. */
export async function runBenchmark(suite: BenchSuite, deps: BenchDeps, opts: BenchOptions = {}): Promise<BenchReport> {
  const startedAt = Date.now();
  let cases = suite.cases;
  if (opts.only?.length) cases = cases.filter((c) => opts.only!.includes(c.id));
  if (opts.limit) cases = cases.slice(0, opts.limit);
  const start =
    deps.startBuild ??
    ((c: BenchCase, o: BenchOptions) => {
      const target = builderFor(o.bestOf === true ? "auto" : o.bestOf === false ? 1 : o.bestOf, deps.runs.brain.config.bestOf.enabled);
      return deps.runs.start(
        { agentId: target.agentId },
        // Unattended: never wait for a person. A case above the cost limit stops and counts as not published.
        {
          request: c.request,
          clarify: false,
          evaluate: o.evaluate ?? true,
          optimize: o.optimize ?? true,
          askOnCost: false,
          confirmAboveUsd: o.maxBuildUsd ?? 10,
          useLibrary: o.library ?? true,
          ...(c.tools !== undefined ? { tools: toolsOf(c.tools, deps.baseDir) } : {}),
          ...(c.givenTests !== undefined ? { tests: parseExternalTests(c.givenTests, deps.baseDir ?? null) } : {}),
          ...(target.candidates ? { candidates: target.candidates } : {}),
        },
        // No person is there: an approval or a question of the build does not wait.
        { kind: "build", humanMode: "auto" },
      );
    });

  const results: BenchCaseResult[] = [];
  const skipped: { id: string; reason: string }[] = [];
  let spent = 0;
  let next = 0;

  const one = async (c: BenchCase): Promise<BenchCaseResult> => {
    let rec: RunRecord | undefined;
    try {
      const started = start(c, opts);
      rec = await deps.runs.waitForRun(started.id);
    } catch (e) {
      return { id: c.id, category: c.category, runId: null, status: "failed", error: (e as Error).message, metrics: null, met: false, misses: ["build did not start"] };
    }
    if (!rec) return { id: c.id, category: c.category, runId: null, status: "failed", error: "run record missing", metrics: null, met: false, misses: ["run record missing"] };
    const children: RunRecord[] = [];
    for (const s of deps.store.allRunSummaries().filter((x) => x.parentRunId === rec!.id)) {
      const child = await deps.runs.getRun(s.id);
      if (child) children.push(child);
    }
    const metrics = collectMetrics(rec, children);
    const sel = (rec.output as { selection?: { model: string; by: string; candidates: unknown[] } } | undefined)?.selection;
    const selection = sel ? { model: sel.model, by: sel.by, candidates: sel.candidates.length } : undefined;
    const hidden = await hiddenResult(c, metrics, deps);
    const misses = checkExpect(c, metrics, hidden);
    return { id: c.id, category: c.category, runId: rec.id, status: rec.status, error: rec.error, metrics, ...(selection ? { selection } : {}), ...(hidden ? { hidden } : {}), met: misses.length === 0, misses };
  };

  // A case with "after" waits for that case, when the run has it. Each case runs once.
  const selected = new Set(cases.map((c) => c.id));
  const done = new Map<string, Promise<void>>();
  const finish = new Map<string, () => void>();
  for (const c of cases) done.set(c.id, new Promise<void>((r) => finish.set(c.id, r)));
  // Only an earlier case of the run can be waited for, so the cases cannot wait for each other.
  const index = new Map(cases.map((c, i) => [c.id, i]));
  const waits = (c: BenchCase) => (c.after && selected.has(c.after) && index.get(c.after)! < index.get(c.id)! ? c.after : null);
  const pending = [...cases];
  const worker = async () => {
    for (;;) {
      // A case is ready when it waits for nothing, or for a case that is done.
      const i = pending.findIndex((c) => !waits(c) || doneIds.has(waits(c)!));
      if (i < 0) {
        if (!pending.length) return;
        // Every pending case waits: wait for one of the cases that they need.
        await Promise.race(pending.map((c) => done.get(waits(c)!)!));
        continue;
      }
      const [c] = pending.splice(i, 1);
      if (opts.budgetUsd !== undefined && spent >= opts.budgetUsd) skipped.push({ id: c.id, reason: `budget $${opts.budgetUsd} reached` });
      else {
        const r = await one(c);
        // The hidden tests cost money too: the budget counts them.
        spent += (r.metrics?.costUsd ?? 0) + (r.hidden?.costUsd ?? 0);
        results.push(r);
        deps.onCaseDone?.(r, spent);
      }
      doneIds.add(c.id);
      finish.get(c.id)!();
    }
  };
  const doneIds = new Set<string>();
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 2, cases.length)) }, worker));

  const order = new Map(suite.cases.map((c, i) => [c.id, i]));
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const ms = results.map((r) => r.metrics).filter((m): m is BenchMetrics => !!m);
  const scored = ms.filter((m) => m.score !== null);
  const steps = ms.filter((m) => m.tokensPerStepAvg > 0);
  const evalRuns = ms.reduce((a, m) => a + m.evalRuns, 0);
  return {
    id: `bench_${new Date(startedAt).toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}`,
    startedAt,
    endedAt: Date.now(),
    gitCommit: gitCommit(),
    suiteVersion: suite.version,
    options: opts,
    cases: results,
    skipped,
    totals: {
      cases: results.length,
      published: ms.filter((m) => m.published).length,
      met: results.filter((r) => r.met).length,
      meanScore: scored.length ? Math.round((scored.reduce((a, m) => a + (m.score ?? 0), 0) / scored.length) * 1000) / 1000 : null,
      costUsd: Math.round(ms.reduce((a, m) => a + m.costUsd, 0) * 10000) / 10000,
      durationMs: Date.now() - startedAt,
      repeatedToolCalls: ms.reduce((a, m) => a + m.repeatedToolCalls, 0),
      tokensPerStepAvg: steps.length ? Math.round(steps.reduce((a, m) => a + m.tokensPerStepAvg, 0) / steps.length) : 0,
      cacheHitRate: ms.length ? Math.round((ms.reduce((a, m) => a + m.cacheHitRate, 0) / ms.length) * 1000) / 1000 : 0,
      partialRate: evalRuns ? Math.round((ms.reduce((a, m) => a + m.partialRuns, 0) / evalRuns) * 1000) / 1000 : 0,
      testItemsRemoved: ms.reduce((a, m) => a + (m.testItemsRemoved ?? 0), 0),
      intentRejections: ms.reduce((a, m) => a + (m.intentRejections ?? 0), 0),
      disputedItems: ms.reduce((a, m) => a + (m.disputedItems ?? 0), 0),
      environmentTests: ms.reduce((a, m) => a + (m.environmentTests ?? 0), 0),
      unmeasured: ms.filter((m) => m.unmeasured).length,
      programs: ms.reduce((a, m) => a + (m.programs ?? 0), 0),
      sandboxMs: ms.reduce((a, m) => a + (m.sandboxMs ?? 0), 0),
      ...(results.some((r) => r.selection)
        ? {
            judged: results.filter((r) => r.selection?.by === "judge").length,
            modelWins: results.reduce<Record<string, number>>((a, r) => (r.selection ? { ...a, [r.selection.model]: (a[r.selection.model] ?? 0) + 1 } : a), {}),
          }
        : {}),
      hiddenMeanScore: (() => {
        const h = results.flatMap((r) => (r.hidden ? [r.hidden.score] : []));
        return h.length ? Math.round((h.reduce((a, b) => a + b, 0) / h.length) * 1000) / 1000 : null;
      })(),
      examplesUsed: ms.reduce((a, m) => a + (m.examplesUsed ?? 0), 0),
      lessonsUsed: ms.reduce((a, m) => a + (m.lessonsUsed ?? 0), 0),
    },
  };
}

/* --------------------------------- reports -------------------------------- */

export function benchDir(dataDir: string) {
  return path.join(dataDir, "bench");
}

export function saveReport(dataDir: string, report: BenchReport): string {
  const dir = benchDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${report.id}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

export function listReports(dataDir: string): BenchReport[] {
  const dir = benchDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as BenchReport;
      } catch {
        return null;
      }
    })
    .filter((r): r is BenchReport => !!r)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export interface CaseDelta {
  id: string;
  score: number | null;
  costUsd: number | null;
}

/** Changes from the previous report, for the cases that both reports contain. */
export function compareReports(current: BenchReport, previous: BenchReport | undefined): { cases: CaseDelta[]; meanScore: number | null; costUsd: number | null } {
  if (!previous) return { cases: [], meanScore: null, costUsd: null };
  const prev = new Map(previous.cases.map((c) => [c.id, c]));
  const cases: CaseDelta[] = [];
  for (const c of current.cases) {
    const p = prev.get(c.id);
    if (!p || !c.metrics || !p.metrics) continue;
    cases.push({
      id: c.id,
      score: c.metrics.score !== null && p.metrics.score !== null ? Math.round((c.metrics.score - p.metrics.score) * 1000) / 1000 : null,
      costUsd: Math.round((c.metrics.costUsd - p.metrics.costUsd) * 10000) / 10000,
    });
  }
  const shared = new Set(cases.map((c) => c.id));
  const mean = (r: BenchReport) => {
    const xs = r.cases.filter((c) => shared.has(c.id) && c.metrics?.score !== null && c.metrics?.score !== undefined).map((c) => c.metrics!.score as number);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const sum = (r: BenchReport) => r.cases.filter((c) => shared.has(c.id)).reduce((a, c) => a + (c.metrics?.costUsd ?? 0), 0);
  const mc = mean(current);
  const mp = mean(previous);
  return {
    cases,
    meanScore: mc !== null && mp !== null ? Math.round((mc - mp) * 1000) / 1000 : null,
    costUsd: cases.length ? Math.round((sum(current) - sum(previous)) * 10000) / 10000 : null,
  };
}

const sign = (n: number | null, digits = 3) => (n === null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}`);

/** A Markdown summary of a report (for the terminal and for commits). */
export function reportMarkdown(r: BenchReport, previous?: BenchReport): string {
  const d = compareReports(r, previous);
  const delta = new Map(d.cases.map((c) => [c.id, c]));
  const lines = [
    `# Benchmark ${r.id}`,
    "",
    `commit ${r.gitCommit ?? "—"} · suite v${r.suiteVersion} · ${r.totals.cases} cases · ${(r.totals.durationMs / 60000).toFixed(1)} min`,
    "",
    `| | value | change |`,
    `|---|---|---|`,
    `| mean score | ${r.totals.meanScore ?? "—"} | ${sign(d.meanScore)} |`,
    ...(r.totals.hiddenMeanScore !== undefined && r.totals.hiddenMeanScore !== null ? [`| hidden tests: mean score | ${r.totals.hiddenMeanScore} | |`] : []),
    ...(r.totals.modelWins ? [`| best-of-N: wins of each builder model | ${Object.entries(r.totals.modelWins).map(([m, n]) => `${m} ${n}`).join(", ")} (judge: ${r.totals.judged ?? 0}) | |`] : []),
    `| cases that meet expectations | ${r.totals.met}/${r.totals.cases} | |`,
    `| published | ${r.totals.published}/${r.totals.cases} | |`,
    `| cost | $${r.totals.costUsd.toFixed(3)} | ${d.costUsd === null ? "—" : `${sign(d.costUsd, 3)} $`} |`,
    `| repeated tool calls | ${r.totals.repeatedToolCalls} | |`,
    `| tokens for each step (mean) | ${r.totals.tokensPerStepAvg} | |`,
    `| prompt cache hit rate | ${r.totals.cacheHitRate} | |`,
    `| partial-result rate | ${r.totals.partialRate} | |`,
    `| test items removed by evolve | ${r.totals.testItemsRemoved ?? 0} | |`,
    `| changes rejected by the intent guard | ${r.totals.intentRejections ?? 0} | |`,
    `| disputed test items | ${r.totals.disputedItems ?? 0} | |`,
    `| tests not scored (environment, for example a rate limit) | ${r.totals.environmentTests ?? 0} | |`,
    `| cases not measured (the environment stopped every test) | ${r.totals.unmeasured ?? 0} | |`,
    `| sandbox programs (time) | ${r.totals.programs ?? 0} (${((r.totals.sandboxMs ?? 0) / 1000).toFixed(1)} s) | |`,
    `| library ${r.options.library === false ? "(off)" : "(on)"}: examples / lessons used | ${r.totals.examplesUsed ?? 0} / ${r.totals.lessonsUsed ?? 0} | |`,
    "",
    `| case | category | score | Δ | cost | Δ | steps max | repeats | removed / intent / disputed | examples / lessons | met |`,
    `|---|---|---|---|---|---|---|---|---|---|---|`,
    ...r.cases.map((c) => {
      const m = c.metrics;
      const x = delta.get(c.id);
      return `| ${c.id} | ${c.category} | ${m?.score ?? "—"} | ${sign(x?.score ?? null)} | ${m ? `$${m.costUsd.toFixed(3)}` : "—"} | ${x?.costUsd === undefined || x?.costUsd === null ? "—" : sign(x.costUsd, 3)} | ${m?.tokensPerStepMax ?? "—"} | ${m?.repeatedToolCalls ?? "—"} | ${m ? `${m.testItemsRemoved ?? 0} / ${m.intentRejections ?? 0} / ${m.disputedItems ?? 0}` : "—"} | ${m ? `${m.examplesUsed ?? 0} / ${m.lessonsUsed ?? 0}` : "—"} | ${c.met ? "yes" : `no (${c.misses.join("; ")})`} |`;
    }),
  ];
  if (r.skipped.length) lines.push("", `Skipped: ${r.skipped.map((s) => `${s.id} (${s.reason})`).join(", ")}`);
  return lines.join("\n");
}
