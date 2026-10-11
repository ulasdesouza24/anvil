import type { Brain } from "../llm/brain.js";
import { runCheck } from "../builder/evaluate.js";
import { rateLimitOf } from "./rateLimit.js";
import { CLOSED_NETWORK_TOOLS } from "./validator.js";
import { executeAgent, type EngineDeps, type ExecuteOptions, type ExecuteResult } from "./engine.js";
import { addUsage, emptyUsage, type AcceptanceRule, type AgentSpec, type FailureClass, type HarnessSummary, type RunEvent } from "./types.js";

/**
 * The harness (docs/HARNESS.md, sections 1, 2 and 4): try, check, fix, try
 * again. After each attempt it checks the output against the definition of
 * done. Jev puts a failure into a class, and the harness selects the next
 * strategy from the ladder of that class. It never selects a strategy two
 * times. When a limit stops it, the output is an honest partial result.
 */

export const FAILURE_CLASSES: Record<FailureClass, string> = {
  no_data: "The agent found no data, or the data is empty or incomplete.",
  source_blocked: "A source blocked the agent: a firewall, a CAPTCHA, a login, HTTP 401/403, or a robots.txt rule.",
  rate_limited: "A source refused more requests for some time: a rate limit, a quota, or HTTP 429. The same call works when the limit resets.",
  bad_format: "The output has the wrong shape, missing fields, or invalid JSON, but the data exists.",
  tool_error: "A tool or an API call failed with an error that is not a block (bad parameters, server error, network error).",
  timeout: "A step took too long or the run stopped at a time limit.",
  wrong_reasoning: "The agent had the data but drew wrong conclusions, did the math wrong, or did not follow the instructions.",
  valid_empty:
    "The sources worked and gave data, but no item meets the filters of the input (for example no record reaches the minimum value in the requested period). The empty result is correct, and the output tells this. Use this class only when the source status says that all calls succeeded.",
  input_problem:
    "The INPUT is invalid, asks for something that does not exist (for example an unknown code, a page number out of range, an empty document), or sets filters that no item meets (for example a minimum value that no item reaches). The source works, and the output tells this clearly. A source or tool failure is NOT an input problem.",
  rule_violation: "The output breaks a rule of the task (a policy, a limit, or a thing that the agent must not do).",
  rule_refusal:
    "The input asks for a thing that a rule of the task forbids, and the output refuses it and gives the rule as the reason. The refusal is the correct result. Use this class only when the output keeps every rule.",
};

export interface Strategy {
  id: string;
  /** Tools that the strategy gives to tool agents. */
  tools?: string[];
  /** Use the deep model tier for this attempt. */
  deep?: boolean;
  hint: (c: { fallbacks: string[] }) => string;
}

export const STRATEGIES: Record<string, Strategy> = {
  web_search: { id: "web_search", tools: ["web_search"], hint: () => "Search the web for the missing data with new, specific queries. Use the facts in the search snippets." },
  read_page: {
    id: "read_page",
    tools: ["web_search", "fetch_url"],
    hint: () => "Open the most relevant pages with fetch_url and read the data from the page text, not only from the snippets.",
  },
  browser: {
    id: "browser",
    tools: ["browse"],
    hint: () => "Pages did not give the data with a plain request. Open them with the browse tool: it runs JavaScript and reads tables.",
  },
  capture_api: {
    id: "capture_api",
    tools: ["browse", "http_request"],
    hint: () => "Open the data page with browse and look at 'network': it lists the JSON API calls of the site. Call the API that has the data with http_request.",
  },
  public_api: {
    id: "public_api",
    tools: ["web_search", "http_request"],
    hint: () => "Find a public JSON API or an open-data portal for this data (search for '<topic> API'). Call it with http_request. Do not use APIs that need a key.",
  },
  alternative_source: {
    id: "alternative_source",
    tools: ["web_search", "fetch_url", "browse", "http_request"],
    hint: (c) => `The first source did not work. Use a different source.${c.fallbacks.length ? ` Tested fallback sources: ${c.fallbacks.join(", ")}.` : ""}`,
  },
  write_code: {
    id: "write_code",
    tools: ["run_code"],
    hint: () => "Write one Python program with the run_code tool: call the tools in a loop, check and clean the data in code, and return only the result.",
  },
  fix_format: {
    id: "fix_format",
    hint: () => "The data was there, but the output had the wrong shape. Return exactly the required fields, with the right types. Do not leave a required field empty.",
  },
  retry_tool: { id: "retry_tool", hint: () => "A tool call failed. Try it again with corrected parameters, or use a different tool for the same data." },
  keep_rules: {
    id: "keep_rules",
    deep: true,
    hint: () =>
      "The output broke a rule of the task. Read each rule again and obey it. When the input asks for a thing that a rule forbids, refuse it and give the rule as the reason.",
  },
  reason_more: { id: "reason_more", deep: true, hint: () => "The conclusions were wrong. Work step by step, check each number, and obey every instruction." },
};

export const LADDER: Record<FailureClass, string[]> = {
  no_data: ["web_search", "read_page", "write_code", "browser", "capture_api", "public_api", "alternative_source"],
  source_blocked: ["browser", "capture_api", "public_api", "alternative_source"],
  // A retry of the same source hits the same limit. Only a different source can help.
  rate_limited: ["alternative_source"],
  bad_format: ["fix_format", "write_code", "reason_more"],
  tool_error: ["retry_tool", "alternative_source"],
  timeout: ["retry_tool", "alternative_source"],
  wrong_reasoning: ["reason_more", "fix_format"],
  // A new strategy cannot fix the input. The output that explains the problem is the correct result.
  input_problem: [],
  valid_empty: [],
  rule_violation: ["keep_rules", "reason_more"],
  // A refusal that a rule asks for is the correct result.
  rule_refusal: [],
};

/** Failure classes whose output is the correct result: the harness accepts it and does not try again. */
const ACCEPTED_CLASSES: Partial<Record<FailureClass, string>> = {
  input_problem: "the output explains a problem in the input",
  valid_empty: "the sources worked, and no item meets the filters of the input",
  rule_refusal: "the input asks for a thing that a rule forbids, and the output refuses it with the reason",
};

/** The prefix of the id of an acceptance rule that comes from a rule of the task (docs/POLICY.md). */
export const RULE_PREFIX = "rule_";

/** What one attempt gets from the harness. */
export interface HarnessContext {
  attempt: number;
  strategy?: string;
  /** Text that goes into every LLM call of this attempt. */
  note?: string;
  tools: string[];
  deep: boolean;
  /** Tool results that an earlier attempt already got (tool + arguments → result). */
  toolCache: Map<string, string>;
}

export interface AcceptanceResult {
  passed: boolean;
  failures: { id: string; message: string }[];
}

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Checks an output against the acceptance rules. All judge rules share one Jev call. */
export async function checkAcceptance(spec: AgentSpec, input: unknown, output: unknown, brain: Brain): Promise<AcceptanceResult> {
  // A conversation agent keeps its rules with the action gate, which sees the full conversation. A rule judge of one turn
  // fails rules that the turn has no part in, so an agent built before this change skips them too (docs/CONVERSATIONS.md).
  const conversation = spec.meta?.interaction === "conversation";
  const rules: AcceptanceRule[] = (spec.acceptance ?? []).filter((r) => !(conversation && r.kind === "judge" && r.id.startsWith(RULE_PREFIX)));
  const failures: AcceptanceResult["failures"] = [];
  if (isEmpty(output)) failures.push({ id: "output", message: "the output is empty" });
  for (const r of rules) {
    if (r.kind !== "check") continue;
    const c = runCheck(output, r.check);
    // "exists" also rejects empty lists and objects: an empty list is not data.
    const empty = r.check.op === "exists" && isEmpty(c.actual);
    if (!c.passed || empty)
      failures.push({
        id: r.id,
        message: `${r.check.path} ${r.check.op}${r.check.value !== undefined ? ` ${JSON.stringify(r.check.value)}` : ""} failed (got ${JSON.stringify(c.actual ?? null).slice(0, 120)})`,
      });
  }
  const judges = rules.filter((r): r is Extract<AcceptanceRule, { kind: "judge" }> => r.kind === "judge");
  if (judges.length && !isEmpty(output)) {
    const a = await brain.decide({
      purpose: "acceptance check",
      // The time of the check: a rule such as "the data is from the last 24 hours" needs it.
      state: { now: new Date().toISOString(), agent_purpose: spec.description, input, output },
      questions: Object.fromEntries(
        judges.map((j, i) => [
          `j${i}`,
          {
            type: "noul" as const,
            instructions: `Does the output satisfy this requirement: "${j.criterion}"? Judge only what the output can show. When a check needs data that is not in the output (for example the live value at the source), answer yes if the output is consistent with itself. When the requirement is about a case that the input does not have (for example a rule about hotel lines, and the input has no hotel line), the requirement does not apply: answer yes. A requirement that limits an action ("only", "never", "at most", "within 14 days", "before") is met when the output does not do that action.`,
          },
        ]),
      ),
    });
    judges.forEach((j, i) => {
      const x = a[`j${i}`];
      const p = x?.type === "noul" ? x.noul : 0;
      if (p < brain.config.thresholds.acceptanceJudge) failures.push({ id: j.id, message: `"${j.criterion}" is not satisfied (p=${p.toFixed(2)})` });
    });
  }
  return { passed: failures.length === 0, failures };
}

/**
 * The actions with side effects that an attempt ran: steps whose class says that the config changes
 * something (a booking, a refund, a message), and the same class or tool called inside an agent step.
 */
export function actionsRan(events: RunEvent[], spec: AgentSpec, registry: EngineDeps["registry"]): string[] {
  const type = new Map(spec.nodes.map((n) => [n.id, n.type]));
  const config = new Map<string, unknown>();
  const out: string[] = [];
  const changes = (t: string | undefined, cfg: unknown) => {
    const fx = t ? registry.get(t)?.sideEffects : undefined;
    try {
      return !!fx && fx((cfg ?? {}) as never);
    } catch {
      return false;
    }
  };
  for (const e of events) {
    if (e.type === "node.started") config.set(e.nodeId, e.config);
    if (e.type === "node.completed" && changes(type.get(e.nodeId), config.get(e.nodeId))) out.push(e.nodeId);
    if (e.type === "log" && e.message.startsWith("tool ")) {
      const name = e.message.slice(5).trim();
      if (changes(name, (e.data as { args?: unknown } | undefined)?.args)) out.push(name);
    }
  }
  return [...new Set(out)];
}

/** Jev selects the failure class from the evidence of the attempt. */
export async function classifyFailure(
  brain: Brain,
  evidence: { input?: unknown; error?: string; failures: string[]; output: unknown; notes: string[]; sourceStatus?: string; ruleBroken?: boolean },
): Promise<FailureClass> {
  const text = `${evidence.error ?? ""} ${evidence.notes.join(" ")}`;
  // A rule of the task that the output breaks is its own class: a new source does not fix it.
  if (evidence.ruleBroken && !evidence.error) return "rule_violation";
  // Clear signals need no model call.
  if (/timed out|timeout|exceeded policy timeout/i.test(evidence.error ?? "")) return "timeout";
  if (rateLimitOf(text, brain.config.rateLimitPattern)) return "rate_limited";
  const a = await brain.decide({
    purpose: "classify the failure",
    state: {
      input: evidence.input ?? null,
      source_status: evidence.sourceStatus ?? null,
      error: evidence.error ?? null,
      unmet_rules: evidence.failures,
      output_excerpt: JSON.stringify(evidence.output ?? null).slice(0, 1500),
      tool_notes: evidence.notes.slice(-12),
    },
    questions: { failure: { type: "choice", instructions: "Which class describes why this attempt failed?", criteria: FAILURE_CLASSES } },
  });
  const f = a.failure;
  if (f?.type === "choice" && f.choice in FAILURE_CLASSES) return f.choice as FailureClass;
  return /blocked|403|429|captcha|firewall|robots/i.test(text) ? "source_blocked" : "no_data";
}

/** Tool notes of an attempt: blocked pages, failed calls, warnings. */
function notesOf(events: RunEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type === "log" && (e.level === "warn" || /blocked|error/i.test(e.message))) out.push(`${e.nodeId ?? ""}: ${e.message}`.slice(0, 200));
    if (e.type === "log" && e.message.startsWith("tool ")) {
      const r = String((e.data as { result?: unknown } | undefined)?.result ?? "");
      if (/error|blocked|403|429|captcha|denied|rejected/i.test(r)) out.push(`${e.message}: ${r.slice(0, 160)}`);
    }
    if (e.type === "node.failed") out.push(`${e.nodeId} failed: ${e.error.slice(0, 160)}`);
  }
  return out;
}

export function harnessEnabled(spec: AgentSpec): boolean {
  if (spec.policy.harness?.enabled === false) return false;
  return spec.policy.harness?.enabled === true || (spec.acceptance?.length ?? 0) > 0;
}

export type HarnessResult = ExecuteResult & { harness: HarnessSummary };

/** Runs the agent with the harness loop. Without the harness, it is one plain attempt. */
export async function executeWithHarness(spec: AgentSpec, input: unknown, deps: EngineDeps, opts: ExecuteOptions & { maxAttempts?: number }): Promise<HarnessResult> {
  if (!harnessEnabled(spec)) {
    const r = await executeAgent(spec, input, deps, opts);
    return { ...r, harness: { status: "off", attempts: 1, strategies: [], gaps: [] } };
  }
  const maxAttempts = spec.policy.harness?.maxAttempts ?? opts.maxAttempts ?? 3;
  const started = Date.now();
  const total = emptyUsage();
  const tried: string[] = [];
  const fallbacks = (
    ((spec.meta?.plan as { sourcePlan?: { needs?: { fallbacks?: { candidate: { url?: string; classType?: string } }[] }[] } })?.sourcePlan?.needs ?? []) as {
      fallbacks?: { candidate: { url?: string; classType?: string } }[];
    }[]
  )
    .flatMap((n) => n.fallbacks ?? [])
    .map((f) => f.candidate.url ?? f.candidate.classType ?? "")
    .filter(Boolean);
  const hctx: HarnessContext = { attempt: 1, tools: [], deep: false, toolCache: new Map() };
  const emitArtifact = (data: Record<string, unknown>) => opts.emit({ type: "artifact", t: Date.now(), kind: "harness", data } as RunEvent);
  const brain = deps.brain.with({ emit: (e) => opts.emit({ ...e, t: Date.now() } as RunEvent), addUsage: (u) => addUsage(total, u), signal: opts.signal });

  let last: ExecuteResult | undefined;
  let failures: string[] = [];
  let unmetRules: string[] = [];
  let failureClass: FailureClass | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    hctx.attempt = attempt;
    const events: RunEvent[] = [];
    const remaining = spec.policy.maxCostUsd - total.costUsd;
    if (remaining <= 0) break;
    const r = await executeAgent({ ...spec, policy: { ...spec.policy, maxCostUsd: remaining } }, input, deps, {
      ...opts,
      // The steps of a recovered run (docs/RECOVERY.md) replay only in the first attempt.
      replay: attempt === 1 ? opts.replay : undefined,
      harness: hctx,
      emit: (e) => {
        events.push(e);
        opts.emit(e);
      },
    });
    addUsage(total, r.usage);
    last = r;
    if (r.status === "cancelled")
      return { ...r, usage: total, durationMs: Date.now() - started, harness: { status: "partial", attempts: attempt, strategies: tried, gaps: [], reason: "cancelled" } };
    // Invalid input is not a failure that a new strategy can fix.
    if (r.status === "failed" && /^Invalid input/.test(r.error ?? "")) return { ...r, usage: total, harness: { status: "off", attempts: attempt, strategies: tried, gaps: [] } };

    const acc = r.status === "completed" ? await checkAcceptance(spec, input, r.output, brain) : { passed: false, failures: [{ id: "run", message: r.error ?? "the run failed" }] };
    failures = acc.failures.map((f) => f.message);
    unmetRules = acc.failures.map((f) => f.id);
    if (acc.passed) {
      emitArtifact({ event: "accepted", attempt });
      // One final event with the usage of all attempts together.
      if (attempt > 1) opts.emit({ type: "run.completed", t: Date.now(), output: r.output, usage: total, durationMs: Date.now() - started });
      return { ...r, usage: total, durationMs: Date.now() - started, harness: { status: "accepted", attempts: attempt, strategies: tried, gaps: [], failureClass } };
    }
    if (opts.signal?.aborted) break;
    // Classify also on the last attempt: an input problem is a correct result, and the class gives the reason of a partial result.
    const notes = notesOf(events);
    // The source status helps the classifier to tell "no data" from "no item meets the filters".
    const sourceStatus =
      notes.length || events.some((e) => e.type === "node.failed")
        ? "Some calls failed or were blocked (see tool_notes)."
        : "All tool calls and source requests succeeded. No node failed.";
    failureClass = await classifyFailure(brain, {
      input,
      error: r.error,
      failures,
      output: r.output,
      notes,
      sourceStatus,
      ruleBroken: unmetRules.some((id) => id.startsWith(RULE_PREFIX)),
    });
    const acceptedReason = ACCEPTED_CLASSES[failureClass];
    if (acceptedReason && r.status === "completed") {
      emitArtifact({ event: "accepted", attempt, failureClass, reason: acceptedReason });
      if (attempt > 1) opts.emit({ type: "run.completed", t: Date.now(), output: r.output, usage: total, durationMs: Date.now() - started });
      return {
        ...r,
        usage: total,
        durationMs: Date.now() - started,
        harness: { status: "accepted", attempts: attempt, strategies: tried, gaps: [], failureClass, reason: acceptedReason },
      };
    }
    if (attempt === maxAttempts) break;
    // An attempt that changed something (a booking, a refund, a sent message) does not run again: a new attempt would do the action two times.
    const actions = actionsRan(events, spec, deps.registry);
    if (actions.length) {
      failures = [...failures, `an action with side effects ran (${actions.join(", ")}), so the harness does not run the agent again`];
      emitArtifact({ event: "action_ran", attempt, actions });
      break;
    }
    // A strategy that needs the sandbox is skipped when the sandbox is off.
    const sandboxOn = deps.services.sandbox?.cfg.mode === "docker";
    // A closed build (docs/TOOLS.md) uses only its given tools: a strategy that reaches the web is not for it.
    const closed = ((spec.meta?.givenTools as string[] | undefined) ?? []).length > 0;
    const next = LADDER[failureClass].find(
      (s) =>
        !tried.includes(s) &&
        (sandboxOn || !(STRATEGIES[s].tools ?? []).includes("run_code")) &&
        (!closed || !(STRATEGIES[s].tools ?? []).some((t) => CLOSED_NETWORK_TOOLS.includes(t))),
    );
    if (!next) {
      emitArtifact({ event: "ladder_done", failureClass, attempt });
      break;
    }
    tried.push(next);
    const s = STRATEGIES[next];
    hctx.strategy = next;
    hctx.tools = [...new Set([...hctx.tools, ...(s.tools ?? [])])];
    hctx.deep = hctx.deep || !!s.deep;
    hctx.note = `HARNESS NOTE (attempt ${attempt + 1} of ${maxAttempts}): the previous attempt did not meet the definition of done.\nUnmet: ${failures.join("; ")}\nFailure class: ${failureClass} — ${FAILURE_CLASSES[failureClass]}\nStrategy for this attempt: ${s.hint({ fallbacks })}\nDo not repeat what failed. Do not leave required fields empty.`;
    emitArtifact({ event: "strategy", strategy: next, failureClass, attempt: attempt + 1, unmet: failures });
  }

  // Honest stop: the partial result, the gaps, and the cause.
  const reason = failureClass ? `${failureClass}: ${FAILURE_CLASSES[failureClass]}` : (last?.error ?? "the output did not meet the definition of done");
  const output = { status: "partial", result: last?.output ?? null, gaps: failures, reason, attempts: hctx.attempt, strategies: tried };
  emitArtifact({ event: "partial", attempts: hctx.attempt, gaps: failures, failureClass });
  opts.emit({ type: "run.completed", t: Date.now(), output, usage: total, durationMs: Date.now() - started });
  return {
    status: "completed",
    output,
    usage: total,
    nodeOutputs: last?.nodeOutputs ?? {},
    nodeStates: last?.nodeStates ?? {},
    durationMs: Date.now() - started,
    harness: { status: "partial", attempts: hctx.attempt, strategies: tried, failureClass, gaps: failures, unmetRules, reason },
  };
}
