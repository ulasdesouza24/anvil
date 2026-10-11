import { z } from "zod";
import { parseExternalTests, withPrefix } from "../core/externalTests.js";
import type { NodeClass, NodeContext } from "../core/registry.js";
import { qualityOf } from "../core/quality.js";
import type { AgentSpec, EvaluationReport, TestCase, TestResult } from "../core/types.js";
import { schemaErrors, type Brain } from "../llm/brain.js";
import { agentOutputSchema, checkPathProblem } from "../core/validator.js";
import { evaluateSpec } from "./evaluate.js";
import { classify, knownDomains, subjectOfSpec, taxonomyOf } from "./library.js";

/**
 * Best-of-N with several builder models (docs/SELECTION.md).
 * Each builder model builds one candidate. All candidates run one shared test suite with pass^k.
 * A clear lead wins. When the scores are close, a judge model reads the failures of the
 * anonymous candidates and weighs them: rule breaks, wrong actions, and invented facts first.
 */

export const LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];

export interface CandidateBuild {
  label: string;
  model: string;
  status: "ready" | "failed" | "timeout";
  runId?: string;
  error?: string;
  spec?: AgentSpec;
  /** The score of the candidate on its own tests, from its build. */
  buildScore?: number | null;
  buildCostUsd: number;
  durationMs: number;
}

export interface CandidateScore {
  label: string;
  model: string;
  /** Weighted pass^k rate on the shared suite. */
  passRate: number;
  /** Weighted mean score on the shared suite. */
  score: number;
  /** The tests of the shared suite that this candidate ran. */
  tests: number;
  costUsd: number;
  report: EvaluationReport;
}

export interface Selection {
  winner: string;
  model: string;
  /** "lead": the best scores won. "judge": the judge decided between close scores. "only": one candidate was ready. */
  by: "lead" | "judge" | "only";
  reason: string;
  margin: number;
  judge?: { model: string; choice: string; reason: string; severity: Record<string, string>; accepted: boolean };
  suite: number;
  candidates: { label: string; model: string; status: string; error?: string; buildScore?: number | null; passRate?: number; score?: number; tests?: number; costUsd: number }[];
}

/**
 * The builder agent of a build request: best-of-N when the request asks for more than one candidate,
 * or when ANVIL_BEST_OF is on and the request does not say. One candidate is a normal build.
 */
export function builderFor(candidates: unknown, enabled: boolean): { agentId: "anvil-best-of" | "anvil-builder"; candidates?: number | "auto" } {
  if (candidates === undefined || candidates === null || candidates === "") return enabled ? { agentId: "anvil-best-of", candidates: "auto" } : { agentId: "anvil-builder" };
  if (candidates === "auto") return { agentId: "anvil-best-of", candidates: "auto" };
  const n = Number(candidates);
  if (!Number.isInteger(n) || n < 1) throw new Error('candidates must be a whole number of 1 or more, or "auto"');
  return n > 1 ? { agentId: "anvil-best-of", candidates: Math.min(n, LABELS.length) } : { agentId: "anvil-builder" };
}

/* -------------------------------- models -------------------------------- */

const checked = new Map<string, { ok: boolean; error?: string; at: number }>();
const CHECK_TTL_MS = 30 * 60_000;

/** The models that answer a small JSON request. A model that fails is not used, with the reason. The result stays for 30 minutes. */
export async function checkModels(brain: Brain, models: string[], timeoutMs = 60_000): Promise<{ ok: string[]; failed: { model: string; error: string }[] }> {
  const results = await Promise.all(
    models.map(async (model) => {
      const hit = checked.get(model);
      if (hit && Date.now() - hit.at < CHECK_TTL_MS) return { model, ...hit };
      try {
        const r = await Promise.race([
          brain.json<{ ok: boolean }>({
            purpose: `model check ${model}`,
            model,
            system: "You answer with JSON only.",
            user: 'Give this JSON: {"ok": true}',
            schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
            maxTokens: 400,
            maxRepairs: 1,
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)),
        ]);
        const v = { ok: r.ok === true, ...(r.ok === true ? {} : { error: "the JSON answer is wrong" }), at: Date.now() };
        checked.set(model, v);
        return { model, ...v };
      } catch (e) {
        const v = { ok: false, error: (e as Error).message.slice(0, 200), at: Date.now() };
        checked.set(model, v);
        return { model, ...v };
      }
    }),
  );
  return { ok: results.filter((r) => r.ok).map((r) => r.model), failed: results.filter((r) => !r.ok).map((r) => ({ model: r.model, error: r.error ?? "unknown" })) };
}

/** Forgets the results of the model check (tests). */
export function forgetModelChecks(): void {
  checked.clear();
}

/* ------------------------------ shared suite ----------------------------- */

const norm = (v: unknown): unknown => {
  if (typeof v === "string") return v.trim().toLowerCase().replace(/\s+/g, " ");
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])]));
  return v;
};

/** Two tests with the same input (and the same conversation start and goal) are one test. */
export function testKey(t: TestCase): string {
  return JSON.stringify(norm({ input: t.input ?? {}, first: t.conversation?.firstMessage ?? null, goal: t.conversation?.goal ?? null }));
}

/**
 * The shared suite: the given tests, then the tests of the candidates, without duplicates.
 * The given tests always stay. The other places go to the candidates in turn, so each candidate gives the same number.
 */
export function sharedSuite(cands: { label: string; tests: TestCase[] }[], given: TestCase[], maxTests: number): { tests: TestCase[]; origin: Record<string, string> } {
  const tests: TestCase[] = [];
  const origin: Record<string, string> = {};
  const seen = new Set<string>();
  for (const t of given) {
    seen.add(testKey(t));
    tests.push(t);
    origin[t.id] = "given";
  }
  const queues = cands.map((c) => ({ label: c.label, rest: [...c.tests], n: 0 }));
  while (tests.length < Math.max(maxTests, given.length) && queues.some((q) => q.rest.length)) {
    for (const q of queues) {
      if (tests.length >= Math.max(maxTests, given.length)) break;
      while (q.rest.length) {
        const t = q.rest.shift()!;
        const key = testKey(t);
        if (seen.has(key)) continue;
        seen.add(key);
        q.n++;
        const id = `${q.label.toLowerCase()}${q.n}`;
        tests.push({ ...t, id });
        origin[id] = q.label;
        break;
      }
    }
  }
  return { tests, origin };
}

/** The input that a test gives to the agent (a conversation test adds the first message). */
const turnInput = (t: TestCase) => (t.conversation ? { ...t.input, messages: [{ role: "user", content: t.conversation.firstMessage || "Hello" }] } : t.input);

/**
 * The tests of the shared suite that a candidate runs. Given tests always count: the platform uses their form.
 * A test of another candidate counts only when its input fits the input schema of this candidate,
 * because two candidates can give their inputs different names.
 */
export function suiteFor(spec: AgentSpec, suite: TestCase[], origin: Record<string, string>, label: string): TestCase[] {
  const shape = agentOutputSchema(spec);
  return suite
    .filter((t) => origin[t.id] === "given" || origin[t.id] === label || schemaErrors(spec.inputSchema, turnInput(t)).length === 0)
    .map((t) => {
      if (origin[t.id] === "given" || origin[t.id] === label) return t;
      // A check of another candidate reads its output fields. A field that this candidate does not give is not a fault
      // of this candidate: the check goes, and the criteria (the behavior) stay.
      const checks = (t.checks ?? []).filter((c) => !!shape && !checkPathProblem(shape, c.path));
      return checks.length === (t.checks ?? []).length ? t : { ...t, checks };
    });
}

/* -------------------------------- scoring -------------------------------- */

/** The weighted pass^k rate and score of a report. A given test has the weight givenWeight, and a test that the environment stopped does not count. */
export function weighted(report: EvaluationReport, origin: Record<string, string>, givenWeight: number): { passRate: number; score: number } {
  const w = (r: TestResult) => (origin[r.testId] === "given" ? givenWeight : 1);
  const counted = report.results.filter((r) => !r.environment);
  const scored = counted.filter((r) => !r.skipped);
  const sum = (rs: TestResult[], f: (r: TestResult) => number) => rs.reduce((a, r) => a + w(r) * f(r), 0);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const passW = sum(counted, () => 1);
  const scoreW = sum(scored, () => 1);
  return { passRate: passW ? round(sum(counted, (r) => (r.passed ? 1 : 0)) / passW) : 0, score: scoreW ? round(sum(scored, (r) => r.score) / scoreW) : 0 };
}

/** Best first: the pass^k rate, then the score. */
export function rank(scores: CandidateScore[]): CandidateScore[] {
  return [...scores].sort((a, b) => b.passRate - a.passRate || b.score - a.score);
}

/**
 * The candidates that are close to the best: within the margin on the pass^k rate and on the score. One candidate
 * means a clear lead. On the pass^k rate, the margin is at least the share of one test: one test that passes by
 * chance does not decide.
 */
export function contenders(ranked: CandidateScore[], margin: number): CandidateScore[] {
  const top = ranked[0];
  if (!top) return [];
  const passMargin = Math.max(margin, 1 / Math.max(1, top.tests)) + 1e-9;
  return ranked.filter((c) => c === top || (top.passRate - c.passRate <= passMargin && top.score - c.score <= margin));
}

/* --------------------------------- judge --------------------------------- */

const SEVERITY = ["none", "light", "medium", "severe"] as const;

function shuffle<T>(xs: T[], random: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The failures of a candidate for the judge: failed items, errors, and the end of each transcript. Without the model name. */
export function failureEvidence(report: EvaluationReport, maxChars: number): unknown[] {
  const out: unknown[] = [];
  let used = 0;
  for (const r of report.results.filter((x) => !x.passed && !x.environment)) {
    const o = (r.output ?? {}) as Record<string, unknown>;
    const transcript = ((o.transcript ?? (o.result as Record<string, unknown> | undefined)?.transcript ?? []) as { role: string; content: string; toolCalls?: { tool: string; args: unknown }[] }[])
      .slice(-6)
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 300), ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map((x) => ({ tool: x.tool.replace(/^x_tool_/, "").replace(/_[0-9a-f]{6}$/, ""), args: x.args })) } : {}) }));
    const item = {
      test: r.name,
      ...(r.runs ? { runsPassed: `${r.passes}/${r.runs}` } : {}),
      failed: [...r.criteria.filter((c) => !c.passed).map((c) => c.criterion), ...r.checks.filter((c) => !c.passed).map((c) => `${c.check.path} ${c.check.op} ${JSON.stringify(c.check.value ?? "")} (got ${JSON.stringify(c.actual ?? null).slice(0, 80)})`)],
      ...(r.error ? { error: r.error.slice(0, 300) } : {}),
      ...(transcript.length ? { transcript } : { output: JSON.stringify(r.output ?? null).slice(0, 600) }),
    };
    const size = JSON.stringify(item).length;
    if (used + size > maxChars && out.length) break;
    out.push(item);
    used += size;
  }
  return out;
}

/**
 * The judge decides between candidates with close scores. It sees each candidate under a letter in a random
 * order, never the model name. The choice must be a contender, and not more than 2 × margin below the best
 * scores: else the best scores win.
 */
export async function judge(
  brain: Brain,
  judgeModel: string,
  request: string,
  close: CandidateScore[],
  margin: number,
  random: () => number = Math.random,
  evidenceChars = 12_000,
): Promise<NonNullable<Selection["judge"]> & { winner: CandidateScore }> {
  const order = shuffle(close, random);
  const letters = new Map(order.map((c, i) => [LABELS[i], c]));
  const best = rank(close)[0];
  const each = Math.floor(evidenceChars / Math.max(1, order.length));
  const r = await brain.json<{ choice: string; reason: string; severity: Record<string, string> }>({
    purpose: "select the best candidate",
    model: judgeModel,
    system: `You select the best of several AI agents that do the same task. The scores of the agents are close, so the failures decide.
Weigh each failure:
- severe: the agent broke a rule of the task, did an action that changes data without the confirmation of the user or with a wrong amount (a refund, a cancellation, a booking, a message), or told the user a fact that its tool results do not show.
- medium: a wrong result, a wrong tool argument, or a missing fact that the user needs.
- light: the format, the tone, or the length.
Select the agent whose failures are the least severe. When the failures are equal, select the agent with the better scores. Give "severity" for each agent: the worst failure of the agent (none, light, medium, severe).`,
    user: JSON.stringify({
      task: request,
      agents: order.map((c, i) => ({ agent: LABELS[i], passRate: c.passRate, score: c.score, tests: c.tests, failures: failureEvidence(c.report, each) })),
    }),
    schema: {
      type: "object",
      properties: {
        choice: { type: "string", enum: [...letters.keys()] },
        reason: { type: "string" },
        severity: { type: "object", properties: Object.fromEntries([...letters.keys()].map((k) => [k, { type: "string", enum: [...SEVERITY] }])) },
      },
      required: ["choice", "reason", "severity"],
    },
    maxTokens: 1500,
  });
  const picked = letters.get(r.choice);
  const inBounds = !!picked && best.passRate - picked.passRate <= 2 * margin && best.score - picked.score <= 2 * margin;
  // The letters of the judge become the labels of the candidates again.
  const severity = Object.fromEntries(Object.entries(r.severity ?? {}).flatMap(([k, v]) => (letters.has(k) ? [[letters.get(k)!.label, v]] : [])));
  return { model: judgeModel, choice: picked?.label ?? r.choice, reason: r.reason, severity, accepted: inBounds, winner: inBounds ? picked! : best };
}

/* ---------------------------------- node --------------------------------- */

const BestOfConfig = z.object({
  /** The build input: the same fields as the input of the builder. */
  build: z.record(z.string(), z.unknown()),
  /** The number of candidates, or "auto" for one candidate for each builder model. */
  candidates: z.unknown().optional(),
  /** The builder models. Without them, the config value applies. */
  models: z.array(z.string()).optional(),
  /** The builder agent of the candidates. */
  builder: z.string().default("anvil-builder"),
});

/** Builds the candidates in parallel. A candidate that does not compile, fails, or takes too long is out. */
async function buildCandidates(ctx: NodeContext<z.infer<typeof BestOfConfig>>, models: string[]): Promise<CandidateBuild[]> {
  const cfg = ctx.brain.config.bestOf;
  // When two candidates are ready, the others get a short grace time, not the full time limit: one slow model does not hold the build.
  const grace = new AbortController();
  let ready = 0;
  const needed = Math.min(2, models.length);
  const onReady = () => {
    if (++ready === needed && models.length > needed) {
      ctx.log(`${needed} candidates are ready: the others have ${Math.round(cfg.candidateGraceMs / 1000)} s more`);
      setTimeout(() => grace.abort(), cfg.candidateGraceMs).unref?.();
    }
  };
  return Promise.all(
    models.map(async (model, i): Promise<CandidateBuild> => {
      const label = LABELS[i];
      const t0 = Date.now();
      const timeout = AbortSignal.any([AbortSignal.timeout(cfg.candidateTimeoutMs), grace.signal]);
      const why = () => (grace.signal.aborted ? `no result in the grace time of ${Math.round(cfg.candidateGraceMs / 1000)} s after ${needed} ready candidates` : `no result in ${Math.round(cfg.candidateTimeoutMs / 1000)} s`);
      try {
        // The time limit holds also when a call of the run does not stop at the signal: the race ends the wait.
        const late = new Promise<never>((_, reject) => {
          if (timeout.aborted) reject(new Error("timeout"));
          timeout.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
        });
        const r = await Promise.race([
          ctx.services.runAgent(
            { agentId: ctx.config.builder },
            { ...ctx.config.build, publish: false, builderModel: model, clarify: false, askOnCost: false },
            { record: true, kind: "build", humanMode: "auto", builderModel: model, signal: AbortSignal.any([ctx.signal, timeout]) },
          ),
          late,
        ]);
        const out = (r.output ?? {}) as { spec?: AgentSpec; score?: number | null };
        const build: CandidateBuild = {
          label,
          model,
          runId: r.runId,
          status: r.status === "completed" && out.spec ? "ready" : timeout.aborted ? "timeout" : "failed",
          ...(r.status === "completed" && out.spec ? { spec: out.spec } : { error: timeout.aborted ? why() : (r.error ?? "the build gave no spec").slice(0, 300) }),
          buildScore: out.score ?? null,
          buildCostUsd: r.usage.costUsd,
          durationMs: Date.now() - t0,
        };
        ctx.emit({ type: "artifact", kind: "candidate", data: { ...build, spec: undefined } });
        ctx.log(`candidate ${label} (${model}): ${build.status}${build.error ? ` — ${build.error}` : ""}`);
        if (build.status === "ready") onReady();
        return build;
      } catch (e) {
        const build: CandidateBuild = {
          label,
          model,
          status: timeout.aborted ? "timeout" : "failed",
          error: timeout.aborted ? why() : (e as Error).message.slice(0, 300),
          buildCostUsd: 0,
          durationMs: Date.now() - t0,
        };
        ctx.emit({ type: "artifact", kind: "candidate", data: build });
        ctx.log(`candidate ${label} (${model}): ${build.status} — ${build.error}`, undefined, "warn");
        return build;
      }
    }),
  );
}

export const AnvilBestOfNode: NodeClass<z.infer<typeof BestOfConfig>> = {
  type: "anvil_best_of",
  title: "Best of N",
  category: "anvil",
  internal: true,
  defaultTimeoutMs: 0,
  description:
    "Builds one candidate with each builder model, runs one shared test suite on all candidates with pass^k, and publishes the best. A judge model decides between candidates with close scores (docs/SELECTION.md).",
  whenToUse: "A build that must be consistent: an event, or a task with given tests.",
  configSchema: BestOfConfig,
  example: { build: "{{input}}" },
  async execute(ctx) {
    const cfg = ctx.brain.config;
    const request = String(ctx.config.build.request ?? "");
    if (!request.trim()) throw new Error("The build has no request");

    // 1. The builder models that answer.
    let models = ctx.config.models?.length ? ctx.config.models : cfg.bestOf.models;
    const n = Number(ctx.config.candidates);
    if (ctx.config.candidates !== "auto" && Number.isInteger(n) && n >= 1) models = models.slice(0, n);
    models = [...new Set(models)].slice(0, LABELS.length);
    const check = await checkModels(ctx.brain, models);
    for (const f of check.failed) ctx.log(`the builder model ${f.model} is not used: ${f.error}`, undefined, "warn");
    ctx.emit({ type: "artifact", kind: "candidates", data: { models, available: check.ok, failed: check.failed } });
    if (!check.ok.length) throw new Error(`No builder model answers: ${check.failed.map((f) => `${f.model} (${f.error})`).join("; ")}`);

    // 2. One candidate for each model, in parallel.
    const builds = await buildCandidates(ctx, check.ok);
    const ready = builds.filter((b) => b.status === "ready" && b.spec);
    if (!ready.length) throw new Error(`No candidate is ready: ${builds.map((b) => `${b.label} ${b.model}: ${b.error}`).join("; ")}`);

    // 3. The shared suite: given tests and the tests of the candidates.
    const given = (() => {
      const raw = ctx.config.build.tests;
      if (raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && !raw.length)) return [];
      return withPrefix(parseExternalTests(raw, null), "g");
    })();
    const own = (spec: AgentSpec) => (spec.tests ?? []).filter((t) => !/^g\d+$/.test(t.id));
    const { tests: suite, origin } = sharedSuite(
      ready.map((b) => ({ label: b.label, tests: own(b.spec!) })),
      given,
      cfg.bestOf.maxTests,
    );
    ctx.log(`shared suite: ${suite.length} test(s), ${given.length} given`);

    // 4. pass^k on the shared suite. The candidates run at the same time.
    const scores: CandidateScore[] = await Promise.all(
      ready.map(async (b) => {
        const tests = suiteFor(b.spec!, suite, origin, b.label);
        const { report } = await evaluateSpec(b.spec!, tests, { services: ctx.services, brain: ctx.brain, signal: ctx.signal, repeats: cfg.selectRepeats, concurrency: 2 });
        const w = weighted(report, origin, cfg.bestOf.givenWeight);
        const s: CandidateScore = { label: b.label, model: b.model, ...w, tests: tests.length, costUsd: report.costUsd, report };
        ctx.emit({ type: "artifact", kind: "candidateScore", data: { label: s.label, model: s.model, passRate: s.passRate, score: s.score, tests: s.tests, costUsd: s.costUsd } });
        return s;
      }),
    );

    // 5. A clear lead wins. Close scores go to the judge.
    const ranked = rank(scores);
    const close = contenders(ranked, cfg.bestOf.margin);
    let winner = ranked[0];
    let by: Selection["by"] = ready.length === 1 ? "only" : "lead";
    let reason = ready.length === 1 ? "only one candidate was ready" : `the best pass^k rate and score (${winner.passRate}, ${winner.score})`;
    let judged: Selection["judge"];
    if (close.length > 1) {
      try {
        const j = await judge(ctx.brain, cfg.bestOf.judgeModel, request, close, cfg.bestOf.margin);
        const { winner: w, ...rest } = j;
        judged = rest;
        winner = w;
        by = j.accepted ? "judge" : "lead";
        reason = j.accepted ? j.reason : `the judge selected ${j.choice}, but its scores are more than 2 × the margin below the best: the best scores win`;
      } catch (e) {
        reason = `the judge did not answer (${(e as Error).message.slice(0, 120)}): the best scores win`;
        ctx.log(reason, undefined, "warn");
      }
    }
    const win = ready.find((b) => b.label === winner.label)!;
    const selection: Selection = {
      winner: winner.label,
      model: winner.model,
      by,
      reason,
      margin: cfg.bestOf.margin,
      ...(judged ? { judge: judged } : {}),
      suite: suite.length,
      candidates: builds.map((b) => {
        const s = scores.find((x) => x.label === b.label);
        return { label: b.label, model: b.model, status: b.status, ...(b.error ? { error: b.error } : {}), buildScore: b.buildScore, ...(s ? { passRate: s.passRate, score: s.score, tests: s.tests } : {}), costUsd: b.buildCostUsd + (s?.costUsd ?? 0) };
      }),
    };
    ctx.emit({ type: "artifact", kind: "selection", data: selection });
    ctx.log(`selected ${selection.winner} (${selection.model}) by ${selection.by}: ${selection.reason}`);

    // 6. Publish the winner, with the tests of the shared suite that it ran.
    const spec: AgentSpec = structuredClone(win.spec!);
    spec.id = ctx.services.store.uniqueId(spec.id);
    spec.tests = suiteFor(win.spec!, suite, origin, win.label);
    spec.meta = { ...spec.meta, builtBy: "anvil-best-of", builderModel: win.model, selection, candidates: selection.candidates };
    if (!taxonomyOf(spec)) {
      try {
        spec.meta = { ...spec.meta, taxonomy: await classify(ctx.brain, subjectOfSpec(spec), knownDomains(ctx.services.store, cfg.library.domains)) };
      } catch (e) {
        ctx.log(`the agent has no class: ${(e as Error).message}`, undefined, "warn");
      }
    }
    const evaluation = winner.report;
    const saved = await ctx.services.store.saveVersion(spec, { note: `built by Anvil (best of ${ready.length}, ${win.model})`, score: evaluation.score, evaluation, buildRunId: ctx.runId });
    const quality = qualityOf(evaluation);
    ctx.emit({ type: "artifact", kind: "published", data: { agentId: saved.id, version: saved.currentVersion, name: saved.name, quality } });
    return {
      output: { agentId: saved.id, version: saved.currentVersion, name: saved.name, score: winner.score, passRate: winner.passRate, quality, model: win.model, selection },
    };
  },
};
