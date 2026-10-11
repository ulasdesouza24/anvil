import { nanoid } from "nanoid";
import { rateLimitOf } from "../core/rateLimit.js";
import type { RunAgentResult, Services } from "../core/registry.js";
import { replyOf } from "../runtime/sessions.js";
import { steLint } from "../core/ste.js";
import { getPath, parseDotPath } from "../core/template.js";
import { toolCallsOf } from "../core/toolCalls.js";
import type { AgentSpec, Check, CheckResult, CriterionResult, EvaluationReport, FailureBlame, FailureDiagnosis, TestCase, TestResult, Usage } from "../core/types.js";
import { isTestBlame } from "../core/quality.js";
import { readsLiveData } from "../core/liveData.js";
import type { Brain } from "../llm/brain.js";

export function runCheck(output: unknown, check: Check): CheckResult {
  let actual: unknown;
  try {
    actual = check.path ? getPath(output, parseDotPath(check.path)) : output;
  } catch {
    actual = undefined;
  }
  const str = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
  let passed = false;
  switch (check.op) {
    case "exists":
      passed = actual !== undefined && actual !== null && actual !== "" && !(Array.isArray(actual) && actual.length === 0);
      break;
    case "equals": {
      // An empty expected value ("" or null) matches each empty actual value: "", null, or a missing field.
      const empty = (v: unknown) => v === undefined || v === null || v === "";
      passed =
        empty(check.value) && empty(actual)
          ? true
          : typeof actual === "object" && actual !== null
            ? JSON.stringify(actual) === JSON.stringify(check.value)
            : String(actual).toLowerCase() === String(check.value).toLowerCase();
      break;
    }
    case "contains":
      passed = Array.isArray(actual)
        ? actual.some((x) => str(x).toLowerCase().includes(String(check.value).toLowerCase()))
        : str(actual).toLowerCase().includes(String(check.value).toLowerCase());
      break;
    case "matches":
      try {
        passed = new RegExp(String(check.value), "i").test(str(actual));
      } catch {
        passed = false;
      }
      break;
    case "type": {
      const want = String(check.value).toLowerCase();
      passed =
        want === "array"
          ? Array.isArray(actual)
          : want === "null"
            ? actual === null
            : want === "integer"
              ? Number.isInteger(actual)
              : want === "number"
                ? typeof actual === "number" && Number.isFinite(actual)
                : want === "object"
                  ? !!actual && typeof actual === "object" && !Array.isArray(actual)
                  : typeof actual === want;
      break;
    }
    case "minLength":
      passed = (Array.isArray(actual) ? actual.length : str(actual).length) >= Number(check.value);
      break;
    case "maxLength":
      passed = (Array.isArray(actual) ? actual.length : str(actual).length) <= Number(check.value);
      break;
  }
  return { check, passed, actual: typeof actual === "string" && actual.length > 300 ? `${actual.slice(0, 300)}…` : actual };
}

export interface EvalEnv {
  services: Services;
  brain: Brain;
  signal?: AbortSignal;
  concurrency?: number;
  passThreshold?: number;
  onResult?: (r: TestResult) => void;
  /** Run the first test alone. Run the other tests only when the first test passes, or fails only because of test problems. */
  smokeFirst?: boolean;
  onSmokeNote?: (note: string) => void;
  /** Do not start a new test when the cost of this evaluation reaches this value. */
  budgetUsd?: number;
  /** Read live data again: no cached answer of a source (a health check, docs/HEALTH.md). */
  freshData?: boolean;
  /** pass^k (docs/SELECTION.md): run each test this many times. A test passes only when every run passes. */
  repeats?: number;
}

/**
 * One result from the k runs of a test (pass^k). A run that the environment stopped does not count.
 * The details (criteria, checks, output, diagnosis) come from the first failed run, so a person sees the failure.
 */
export function mergeRuns(runs: TestResult[]): TestResult {
  if (runs.length === 1) return runs[0];
  const cost = runs.reduce((a, r) => a + r.costUsd, 0);
  const ms = runs.reduce((a, r) => a + r.durationMs, 0);
  const counted = runs.filter((r) => !r.environment && !r.skipped);
  if (!counted.length) return { ...runs[0], runs: 0, passes: 0, costUsd: cost, durationMs: ms };
  const passes = counted.filter((r) => r.passed).length;
  const shown = counted.find((r) => !r.passed) ?? counted[counted.length - 1];
  const score = counted.reduce((a, r) => a + r.score, 0) / counted.length;
  return { ...shown, passed: passes === counted.length, score: Math.round(score * 1000) / 1000, runs: counted.length, passes, costUsd: cost, durationMs: ms };
}

export interface EvalOutcome {
  report: EvaluationReport;
  /** testId → node outputs of that run (for the critic). */
  traces: Record<string, Record<string, unknown>>;
}

/**
 * Runs every test case against a spec (human steps auto-approved), applies the
 * deterministic checks, and has the decision model grade each natural-language
 * criterion — all criteria of a test in one parallel call.
 */
/**
 * The STE score of the prose in an output. Prose is each string with 8 words
 * or more. Identifiers, numbers, and URLs are not prose. Returns null when the output has no prose.
 */
export function proseSte(output: unknown): TestResult["ste"] | null {
  const texts: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (v.trim().split(/\s+/).length >= 8 && !/^https?:\/\//.test(v.trim())) texts.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(output);
  if (!texts.length) return null;
  const r = steLint(texts.join("\n\n"));
  return { per100w: r.per100w, words: r.words, language: r.language };
}

const BLAME_CRITERIA: Record<FailureBlame, string> = {
  agent: "The output is wrong or incomplete for this input. The requirement is fair.",
  test_live_value:
    "The requirement expects an exact value, count, or ranking that comes from live data at run time. The test cannot know it, and the output is consistent with itself.",
  test_contradicts: "The requirement contradicts the goal of the agent or the test input.",
  test_outside:
    "The requirement needs outside knowledge, exact wording, or data that the output does not show (for example, it asks that an average equals the mean of values that are not in the output). The output is consistent with itself.",
  test_unattended: "The requirement expects a waiting, pending, or unapproved state, but tests approve every step automatically.",
  unclear: "The evidence does not show if the agent or the requirement is wrong.",
};

/** One System-1 call for a failed test: for each failed item, is the agent or the test wrong? */
async function diagnoseFailures(spec: AgentSpec, t: TestCase, output: unknown, criteria: CriterionResult[], checks: CheckResult[], env: EvalEnv): Promise<FailureDiagnosis[]> {
  const items: { kind: "criterion" | "check"; item: string; actual?: unknown }[] = [
    ...criteria.filter((c) => !c.passed).map((c) => ({ kind: "criterion" as const, item: c.criterion })),
    ...checks
      .filter((c) => !c.passed)
      .map((c) => ({ kind: "check" as const, item: `${c.check.path} ${c.check.op}${c.check.value !== undefined ? ` ${JSON.stringify(c.check.value)}` : ""}`, actual: c.actual })),
  ];
  if (!items.length) return [];
  const live = readsLiveData(spec, (spec.meta?.taskSpec as { dataNeeds?: unknown[] } | undefined) ?? {}, (type) => env.services.registry.get(type)?.custom?.kind);
  const a = await env.brain.decide({
    purpose: `diagnose test "${t.name}"`,
    state: {
      now: new Date().toISOString(),
      agent_goal: spec.description,
      live_data: live ? "The agent gets its data from external sources at run time." : "The agent gets all its data from the input.",
      unattended_tests: "Every human approval step is approved automatically, and every human question is skipped.",
      test_input: testInputView(t),
      agent_output: shrinkForState(output),
      failed_items: items.map((x, i) => ({ i, kind: x.kind, requirement: x.item, ...(x.actual !== undefined ? { actual: shrinkForState(x.actual) } : {}) })),
    },
    questions: Object.fromEntries(
      items.map((x, i) => [`d${i}`, { type: "choice" as const, instructions: `Failed item #${i} ("${x.item}"): who is wrong?`, criteria: BLAME_CRITERIA }]),
    ),
  });
  const first: FailureDiagnosis[] = items.map((x, i) => {
    const r = a[`d${i}`];
    const blame = (r?.type === "choice" && r.choice in BLAME_CRITERIA ? r.choice : "unclear") as FailureBlame;
    // For a test blame, the confidence is the probability that the test is wrong: the sum of all test classes.
    const probs = r?.type === "choice" ? (r.probabilities ?? {}) : {};
    const mass = Object.keys(probs).length
      ? isTestBlame(blame)
        ? Object.entries(probs)
            .filter(([k]) => isTestBlame(k as FailureBlame))
            .reduce((a, [, p]) => a + p, 0)
        : (probs[blame] ?? 0)
      : null;
    const confidence = mass ?? (r?.type === "choice" ? (r.confidence ?? 0) : 0);
    return { kind: x.kind, item: x.item, blame, confidence: Math.round(confidence * 100) / 100 };
  });
  // A second opinion from the reasoning model when Jev is not sure (below the confidence for an action).
  const SURE = env.brain.config.thresholds.diagnosisConfidence;
  const unsure = first.map((d, i) => ({ d, i })).filter(({ d }) => d.blame === "unclear" || d.confidence < SURE);
  if (!unsure.length) return first;
  const second = await env.brain
    .json<{ verdicts: { i: number; blame: FailureBlame; reason: string }[] }>({
      purpose: `second opinion on test "${t.name}"`,
      tier: "balanced",
      system: `You judge failed test items of an AI agent. For each item, decide who is wrong: the agent or the test. Use the classes below. Give a reason in one sentence. When you cannot decide, use "unclear".\n${Object.entries(
        BLAME_CRITERIA,
      )
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n")}`,
      user: JSON.stringify({
        now: new Date().toISOString(),
        agent_goal: spec.description,
        live_data: live,
        test_input: testInputView(t),
        agent_output: shrinkForState(output),
        items: unsure.map(({ d, i }) => ({ i, kind: d.kind, requirement: d.item })),
      }),
      schema: {
        type: "object",
        properties: {
          verdicts: {
            type: "array",
            items: {
              type: "object",
              properties: { i: { type: "integer" }, blame: { type: "string", enum: Object.keys(BLAME_CRITERIA) }, reason: { type: "string" } },
              required: ["i", "blame", "reason"],
            },
          },
        },
        required: ["verdicts"],
      },
      maxTokens: 1500,
    })
    .catch(() => ({ verdicts: [] }));
  for (const { d, i } of unsure) {
    const v = second.verdicts.find((x) => x.i === i);
    if (!v) {
      d.disputed = true;
      continue;
    }
    d.secondOpinion = v.blame;
    d.reason = v.reason;
    const agree = v.blame === d.blame || (isTestBlame(v.blame) && isTestBlame(d.blame));
    if (agree && v.blame !== "unclear") {
      // Two opinions agree: enough for an action.
      d.blame = v.blame;
      d.confidence = Math.max(d.confidence, SURE);
    } else if (d.blame === "unclear" && v.blame !== "unclear") {
      d.blame = v.blame;
      d.confidence = SURE;
    } else d.disputed = true;
  }
  return first;
}

/** The input of a test for a judge: a conversation test also gives the persona, the goal, and the facts of the simulated user. */
const testInputView = (t: TestCase) =>
  t.conversation ? { ...t.input, user_persona: t.conversation.persona, user_goal: t.conversation.goal, user_facts: t.conversation.facts } : t.input;

const shrinkForState = (v: unknown) => {
  const s = JSON.stringify(v ?? null);
  return s.length <= 3000 ? v : `${s.slice(0, 3000)}…`;
};

/**
 * A conversation test: a simulated user talks to the agent.
 * Each turn runs the agent once with all turns so far and the same session id,
 * so mock tools keep their state. The result is like one run: its output is the
 * last output of the agent with the full transcript, and its usage is the sum.
 */

/**
 * A smoke test with a good score shows a working agent: one failed item does not stop the other tests.
 * A conversation that ran to its end also shows a working agent: its score is one noisy signal of many turns.
 */
export { toolCallsOf };

export function smokeShowsWorkingAgent(r0: Pick<TestResult, "skipped" | "error" | "score">, test: Pick<TestCase, "conversation">, minScore: number): boolean {
  return !r0.skipped && !r0.error && (r0.score >= minScore || !!test.conversation);
}

export async function converseTest(spec: AgentSpec, t: TestCase, env: EvalEnv): Promise<RunAgentResult> {
  const c = t.conversation!;
  // Each run of a test has its own session: mock tools start from their start state.
  const sessionId = `eval_${t.id}_${nanoid(10)}`;
  const messages: { role: "user" | "assistant"; content: string; toolCalls?: { tool: string; args: unknown; result: string }[] }[] = [];
  // The simulated user answers like the persona, and gives only the facts that it knows.
  const simulate = (agentDone: boolean) =>
    env.brain.json<{ message: string; finished: boolean }>({
      purpose: `simulated user of test "${t.name}"`,
      // The same user for each candidate of best-of-N: the model of the fast tier, not the builder model of a candidate.
      model: env.brain.config.tiers.fast.model,
      system: `You play a user who talks to an AI agent. Stay in the role. Write only the next message of the user, short and natural. The goal and the facts are for you: do not copy their words into the message.
Persona: ${c.persona}
Goal: ${c.goal}
Facts that you know (give one only when the agent asks for it or needs it): ${JSON.stringify(c.facts)}
The goal can have more than one part (for example "get a refund, then ask again"). Do each part in order. A fact can be a message to send in a later part.
Set "finished" to true only when EVERY part of the goal is done, when the agent cannot help, or when the conversation goes in a circle. Then "message" is a short closing message or "".`,
      user: JSON.stringify({
        conversation: messages.map(({ role, content }) => ({ role, content })),
        ...(agentDone ? { note: "The agent says that the conversation is finished." } : {}),
      }),
      schema: { type: "object", properties: { message: { type: "string" }, finished: { type: "boolean" } }, required: ["message", "finished"] },
      maxTokens: 400,
    });
  // Without a first message (a scenario gives only the goal), the simulated user writes it.
  const first = c.firstMessage.trim() || (await simulate(false)).message.trim();
  if (!first) throw new Error("The simulated user wrote no first message");
  messages.push({ role: "user", content: first });
  const usage: Usage = { llmCalls: 0, decisionCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let last: RunAgentResult | undefined;
  let ended = "";
  // The closing message of the user (for example "then I do not cancel") gets one more answer of the agent.
  let closing = false;
  // The last turn before the closing message: its state fields (done, a status flag) are the result of the task.
  let beforeClosing: RunAgentResult | undefined;
  for (let turn = 0; turn < c.maxTurns && !env.signal?.aborted; turn++) {
    last = await env.services.runAgent(
      { spec },
      // The tool calls of earlier turns go with the turns: the agent keeps their ids and values (docs/CONVERSATIONS.md).
      { ...t.input, messages: messages.map(({ role, content, toolCalls }) => ({ role, content, ...(toolCalls?.length ? { toolCalls } : {}) })), session_id: sessionId },
      { record: true, kind: "eval", humanMode: "auto", signal: env.signal, ...(env.freshData ? { freshData: true } : {}) },
    );
    for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] = (usage[k] ?? 0) + (last.usage[k] ?? 0);
    if (last.status !== "completed") break;
    const r = replyOf(last.output);
    // The judge sees the tool calls of each turn: it checks that the agent used the tools correctly.
    const calls = toolCallsOf(spec, last);
    messages.push({ role: "assistant", content: r.reply, ...(calls.length ? { toolCalls: calls } : {}) });
    if (closing) {
      ended = "the user ended the conversation";
      break;
    }
    // "done" of the agent does not stop the test: a user with an open part of the goal still talks.
    if (turn + 1 >= c.maxTurns) {
      if (r.done) ended = "the agent ended the conversation";
      break;
    }
    const u = await simulate(r.done);
    if (u.finished || !u.message.trim()) {
      // A closing message with a decision is part of the test: the agent answers it one more time.
      if (u.message.trim()) {
        messages.push({ role: "user", content: u.message });
        closing = true;
        beforeClosing = last;
        continue;
      }
      ended = r.done ? "the agent ended the conversation" : "the user ended the conversation";
      break;
    }
    messages.push({ role: "user", content: u.message });
  }
  if (!last) throw new Error("The conversation did not start");
  // The checks read the state of the task, not the answer to "thank you": the output comes from the turn before the closing message.
  // The transcript keeps the closing turn, so the judge sees it.
  if (beforeClosing && beforeClosing.status === "completed" && last.status === "completed") last = { ...last, output: beforeClosing.output };
  const base = last.output && typeof last.output === "object" && !Array.isArray(last.output) ? (last.output as Record<string, unknown>) : { reply: last.output };
  const extra = { transcript: messages, ...(ended ? { ended } : {}) };
  // A partial result of the last turn wraps its output in "result": the judge reads "result", so the transcript goes in it too.
  const wrapped =
    base.status === "partial"
      ? { ...base, result: { ...(base.result && typeof base.result === "object" ? (base.result as Record<string, unknown>) : {}), ...extra }, ...extra }
      : { ...base, ...extra };
  return { ...last, usage, output: last.status === "completed" ? wrapped : last.output };
}

export async function evaluateSpec(spec: AgentSpec, tests: TestCase[], env: EvalEnv): Promise<EvalOutcome> {
  const threshold = env.passThreshold ?? env.brain.config.thresholds.criterionPass;
  const results: TestResult[] = new Array(tests.length);
  const traces: Record<string, Record<string, unknown>> = {};
  let next = 0;

  const one = async (t: TestCase): Promise<TestResult> => {
    const t0 = Date.now();
    const run = t.conversation
      ? await converseTest(spec, t, env)
      : await env.services.runAgent({ spec }, t.input, { record: true, kind: "eval", humanMode: "auto", signal: env.signal, ...(env.freshData ? { freshData: true } : {}) });
    traces[t.id] = run.nodeOutputs;
    // A rate limit of a source comes from the environment. Only the error and the gaps count as evidence, not the data of the agent.
    const out = run.output as { gaps?: unknown; reason?: unknown } | null | undefined;
    const evidence = [run.error, ...(Array.isArray(out?.gaps) ? out.gaps.map(String) : []), typeof out?.reason === "string" ? out.reason : "", ...(run.harness?.gaps ?? [])].join(
      "\n",
    );
    const limit = rateLimitOf(evidence, env.brain.config.rateLimitPattern) ?? (run.harness?.failureClass === "rate_limited" ? "a source refused more requests (rate limit)" : null);
    if (run.status !== "completed") {
      return {
        ...(limit ? { environment: limit } : {}),
        testId: t.id,
        name: t.name,
        passed: false,
        score: 0,
        error: run.error ?? "run failed",
        criteria: [],
        checks: [],
        runId: run.runId,
        costUsd: run.usage.costUsd,
        durationMs: Date.now() - t0,
      };
    }
    // A partial result wraps the output of the agent: the checks and the judge see that output, not the wrapper.
    const wrapped = run.harness?.status === "partial" && run.output && typeof run.output === "object" && "result" in run.output;
    const agentOutput = wrapped ? (run.output as { result: unknown }).result : run.output;
    const checks = (t.checks ?? []).map((c) => runCheck(agentOutput, c));
    let criteria: CriterionResult[] = [];
    if (t.criteria?.length) {
      const questions = Object.fromEntries(
        t.criteria.map((c, i) => [
          `c${i}`,
          {
            type: "noul" as const,
            instructions: t.conversation
              ? `Does the agent satisfy this requirement in the conversation (agent_output.transcript): "${c}"? When the requirement needs a turn or a tool call that the transcript does not have, the answer is no. A requirement that only limits an action ("only after", "never", "does not") is met when the action does not happen. A requirement about what the agent does when the user does something ("when the guest asks again") needs that user turn: without it, the answer is no. A requirement to ask for a fact is met when the user gave the fact before the agent needed it. A requirement to offer options in an order is met when the agent offered the first option and the user accepted it: the agent does not need to offer the rest.`
              : `Does the agent's output satisfy this requirement: "${c}"?`,
            criteria: { true: "The output clearly satisfies the requirement.", false: "The output does not satisfy it, only partially satisfies it, or is missing." },
          },
        ]),
      );
      const answers = await env.brain.decide({
        purpose: `judge test "${t.name}"`,
        state: {
          now: new Date().toISOString(),
          agent_purpose: spec.description,
          test_input: testInputView(t),
          agent_output: agentOutput ?? null,
          ...(wrapped ? { reported_gaps: (run.output as { gaps?: unknown }).gaps } : {}),
        },
        questions,
      });
      criteria = t.criteria.map((c, i) => {
        const a = answers[`c${i}`];
        const p = a?.type === "noul" ? a.noul : 0;
        return { criterion: c, probability: Math.round(p * 1000) / 1000, passed: p >= threshold };
      });
    }
    const parts = [...criteria.map((c) => c.probability), ...checks.map((c) => (c.passed ? 1 : 0))];
    let score = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 1;
    let passed = criteria.every((c) => c.passed) && checks.every((c) => c.passed) && run.output !== null && run.output !== undefined;
    // A partial result never passes. An honest gap list gets some credit: it is better than a silent empty answer.
    const partial = run.harness?.status === "partial" || (run.output as { status?: unknown } | null)?.status === "partial";
    if (partial) {
      const gaps = (run.output as { gaps?: unknown[] } | null)?.gaps ?? run.harness?.gaps ?? [];
      passed = false;
      score = 0.8 * score + (gaps.length ? 0.2 : 0);
    }
    const ste = proseSte(run.output);
    // A failure from a rate limit says nothing about the agent: no diagnosis, and no score.
    if (!passed && limit) {
      return {
        testId: t.id,
        name: t.name,
        passed: false,
        environment: limit,
        ...(partial ? { partial: true, failureClass: run.harness?.failureClass } : {}),
        score,
        output: run.output,
        criteria,
        checks,
        runId: run.runId,
        costUsd: run.usage.costUsd,
        durationMs: Date.now() - t0,
      };
    }
    const diagnosis = passed ? [] : await diagnoseFailures(spec, t, agentOutput, criteria, checks, env).catch(() => []);
    return {
      testId: t.id,
      name: t.name,
      passed,
      ...(ste ? { ste } : {}),
      ...(diagnosis.length ? { diagnosis } : {}),
      ...(partial ? { partial: true, failureClass: run.harness?.failureClass, ...(run.harness?.unmetRules?.length ? { unmetRules: run.harness.unmetRules } : {}) } : {}),
      score: Math.round(score * 1000) / 1000,
      output: run.output,
      criteria,
      checks,
      runId: run.runId,
      costUsd: run.usage.costUsd,
      durationMs: Date.now() - t0,
    };
  };

  const skip = (t: TestCase, reason: string): TestResult => ({
    testId: t.id,
    name: t.name,
    passed: false,
    score: 0,
    skipped: reason,
    error: `skipped: ${reason}`,
    criteria: [],
    checks: [],
    costUsd: 0,
    durationMs: 0,
  });
  const spent = () => results.reduce((s, r) => s + (r?.costUsd ?? 0), 0);
  const runAt = async (i: number) => {
    if (env.budgetUsd !== undefined && spent() >= env.budgetUsd) results[i] = skip(tests[i], `the evaluation budget ($${env.budgetUsd}) is used`);
    else {
      try {
        // pass^k: the runs of one test go one after the other. The workers run different tests at the same time.
        const runs: TestResult[] = [];
        for (let k = 0; k < Math.max(1, env.repeats ?? 1) && !env.signal?.aborted; k++) runs.push(await one(tests[i]));
        results[i] = mergeRuns(runs);
      } catch (e) {
        results[i] = { testId: tests[i].id, name: tests[i].name, passed: false, score: 0, error: (e as Error).message, criteria: [], checks: [], costUsd: 0, durationMs: 0 };
      }
    }
    env.onResult?.(results[i]);
  };

  // A smoke test first: when the first test fails because of the agent, the other tests do not run.
  // When only test errors (or disputed items) make it fail, the other tests still give information, so they run.
  if (env.smokeFirst && tests.length > 1 && !env.signal?.aborted) {
    await runAt(0);
    next = 1;
    const r0 = results[0];
    // A partial result that meets every item of the test fails only because of an acceptance rule of the agent. The test items are the stronger evidence.
    const onlyRules = !r0.passed && !r0.error && !!r0.partial && r0.criteria.every((c) => c.passed) && r0.checks.every((c) => c.passed);
    const onlyTestProblems = !r0.passed && (!!r0.environment || onlyRules || (!r0.error && !!r0.diagnosis?.length && r0.diagnosis.every((d) => d.blame !== "agent" || d.disputed)));
    if (onlyTestProblems)
      env.onSmokeNote?.(
        r0.environment
          ? `The smoke test failed because of the environment (${r0.environment.slice(0, 120)}). The other tests run.`
          : onlyRules
            ? "The smoke test meets every test item, but an acceptance rule of the agent failed. The other tests run."
            : "The smoke test failed only because of test problems. The other tests run.",
      );
    const goodScore = smokeShowsWorkingAgent(r0, tests[0], env.brain.config.evalSmokeMinScore);
    if (!r0.passed && !onlyTestProblems && goodScore)
      env.onSmokeNote?.(
        tests[0].conversation
          ? `The smoke conversation failed with the score ${r0.score}. The agent works, so the other tests run.`
          : `The smoke test failed with the score ${r0.score}, which is not below ${env.brain.config.evalSmokeMinScore}. The other tests run.`,
      );
    if (!r0.passed && !onlyTestProblems && !goodScore) {
      for (let i = 1; i < tests.length; i++) {
        results[i] = skip(tests[i], "the smoke test failed");
        env.onResult?.(results[i]);
      }
      next = tests.length;
    }
  }

  const worker = async () => {
    while (next < tests.length) {
      const i = next++;
      if (env.signal?.aborted) return;
      await runAt(i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(env.concurrency ?? 3, tests.length - next)) }, worker));

  const done = results.filter(Boolean);
  const steScores = done.flatMap((r) => (r.ste ? [r.ste.per100w] : []));
  // A test that failed because of the environment has no score, and the pass rate does not count it.
  const counted = done.filter((r) => !r.environment);
  const passRate = counted.length ? counted.filter((r) => r.passed).length / counted.length : 0;
  // A skipped test has no score: it did not run. The pass rate still counts it as not passed.
  const ran = counted.filter((r) => !r.skipped);
  const blames = done.flatMap((r) => r.diagnosis ?? []);
  const score = ran.length ? ran.reduce((s, r) => s + r.score, 0) / ran.length : 0;
  return {
    report: {
      version: spec.version,
      passRate: Math.round(passRate * 1000) / 1000,
      ...((env.repeats ?? 1) > 1
        ? { repeats: env.repeats, passAny: counted.length ? Math.round((counted.filter((r) => (r.passes ?? (r.passed ? 1 : 0)) > 0).length / counted.length) * 1000) / 1000 : 0 }
        : {}),
      score: Math.round(score * 1000) / 1000,
      results: done,
      costUsd: done.reduce((s, r) => s + r.costUsd, 0),
      skippedTests: done.filter((r) => r.skipped).length,
      ...(done.length - counted.length ? { environmentTests: done.length - counted.length } : {}),
      ...(blames.length
        ? {
            agentProblems: blames.filter((b) => b.blame === "agent" && !b.disputed).length,
            testProblems: blames.filter((b) => isTestBlame(b.blame) && !b.disputed).length,
            disputedProblems: blames.filter((b) => b.disputed).length,
          }
        : {}),
      ...(steScores.length ? { stePer100w: Math.round((steScores.reduce((a, b) => a + b, 0) / steScores.length) * 100) / 100 } : {}),
      at: Date.now(),
    },
    traces,
  };
}
