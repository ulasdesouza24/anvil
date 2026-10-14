import jsonpatch from "fast-json-patch";
import { z } from "zod";
import type { NodeClass, NodeContext } from "../core/registry.js";
import { REPLY_FIELDS } from "../core/types.js";
import { carryLayout, lockedViolations, restoreLocked, withoutLayout } from "../core/workflow.js";
import type { AgentSpec, EvaluationReport, JSONSchema, TestCase, TestResult } from "../core/types.js";
import { schemaErrors } from "../llm/brain.js";
import { agentOutputSchema, checkPathProblem } from "../core/validator.js";
import { missingNamedUrls, missingPlannedSources } from "../core/urls.js";
import { CLASS_GUIDE, validateClassDef, type CustomClassDef } from "../core/customClass.js";
import { evaluateSpec } from "./evaluate.js";
import { EXAMPLE_SPEC, IR_GUIDE } from "./guide.js";
import { applyPatchLenient, formatDiagnostics, nodeDocs, validateAndRepair } from "./repair.js";
import { describeSourcePlan, type SourcePlan } from "./sources.js";
import { STE_RULES } from "../core/ste.js";
import { BLAME_TEXT, isTestBlame, QUALITY_TEXT, qualityOf } from "../core/quality.js";
import { readsLiveData } from "../core/liveData.js";
import { RULE_PREFIX } from "../core/harness.js";
import { parseExternalTests, withPrefix } from "../core/externalTests.js";
import { filePreview } from "../core/fileExtract.js";
import { givenToolsOf, NETWORK_AGENT_TOOLS, NETWORK_NODE_TYPES, toolDataPrompt, toolsPrompt, type ToolsOutput } from "./toolsStep.js";
import type { StoredFile } from "../runtime/files.js";
import { classify, knownDomains, libraryForSpec, libraryPrompt, PATTERNS, recordLessons, subjectOfSpec, taxonomyOf, type LibraryContext } from "./library.js";
export { readsLiveData };

/* ============================== shared types ============================== */

export interface TaskSpec {
  name: string;
  agentId: string;
  summary: string;
  goal: string;
  inputs: { name: string; type: string; description: string; required: boolean; example?: unknown; file?: boolean }[];
  /** optional: a correct result can leave the field empty (for example the tracking number of an order that is not shipped). */
  outputs: { name: string; type: string; description: string; optional?: boolean }[];
  steps: string[];
  constraints: string[];
  successCriteria: string[];
  assumptions: string[];
  clarifyingQuestions: string[];
  /** External data the agent must get at run time (not given in the input). */
  dataNeeds?: DataNeed[];
  /** The attached files of the build and their roles (docs/FILES.md). */
  files?: { id: string; name: string; role: "sample_input" | "reference" | "context"; use: string }[];
  exampleInputs: Record<string, unknown>[];
  /** The rules of a policy that the request or a file gives (docs/POLICY.md). */
  rules?: TaskRule[];
  /** "conversation": the agent talks with a user over many turns. */
  interaction?: "single" | "conversation";
  /** How the agent is started once deployed. */
  trigger?: { kind: "manual" | "schedule" | "webhook" | "poll" | "agent"; description: string; cron?: string; every?: string; timezone?: string; url?: string; agentId?: string };
}

export interface TaskRule {
  id: string;
  /** The rule in one sentence, in STE. */
  rule: string;
  kind: "must" | "must_not";
  /** An important rule gets an acceptance rule and a test that tries to break it. */
  important: boolean;
  /** Where the rule comes from: the request or a file. */
  source: string;
}

export interface DataNeed {
  id: string;
  description: string;
  fields: string[];
  freshness?: string;
  required: boolean;
}

export interface Plan {
  pattern: string;
  rationale: string;
  steps: { id: string; type: string; purpose: string; dependsOn: string[]; branch?: { from: string; port: string } | null; model?: string }[];
  output: string;
  /** Capabilities the library lacks, to be generated as custom classes before composing. */
  newClasses?: { type: string; kind: "http" | "code" | "llm"; purpose: string; service?: string }[];
}

export interface Triage {
  pattern: string;
  patternConfidence: number;
  clarity: number;
  complexity: number;
  flags: Record<string, number>;
  escalated: boolean;
  estimate?: { lowUsd: number; highUsd: number; basis: string; samples: number; limitUsd: number; needsConfirmation: boolean; overLimit: boolean };
}

const artifact = (ctx: NodeContext<any>, kind: string, data: unknown) => ctx.emit({ type: "artifact", kind, data });

/**
 * Makes a value smaller for a prompt and keeps its type and shape. An object
 * stays an object and a list stays a list, so a model does not take a
 * shortened object for a string.
 */
export function shrinkJson(v: unknown, max = 1500): unknown {
  const size = (x: unknown) => JSON.stringify(x)?.length ?? 0;
  if (size(v) <= max) return v;
  if (typeof v === "string") return `${v.slice(0, Math.max(40, max))}…[${v.length} chars]`;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    let used = 2;
    for (const item of v) {
      const part = shrinkJson(item, Math.max(80, Math.floor(max / 3)));
      if (used + size(part) > max && out.length) break;
      out.push(part);
      used += size(part) + 1;
    }
    if (out.length < v.length) out.push(`…[${v.length - out.length} more items, ${v.length} in total]`);
    return out;
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    const each = Math.max(60, Math.floor(max / Math.max(1, entries.length)));
    return Object.fromEntries(entries.map(([k, x]) => [k, shrinkJson(x, each)]));
  }
  return v;
}
const truncateJson = shrinkJson;

/** In unattended mode, no person approves or answers: the agent must not wait for one. */
const UNATTENDED_NOTE = (ctx: NodeContext<any>) =>
  ctx.brain.config.unattended
    ? "\n\nUNATTENDED: the agent runs without a person. Do not add human_approval or human_input steps. Do the safe action, or return the reason when the task needs a person."
    : "";

/**
 * A conversation agent has a fixed contract: the input is the
 * turns so far and the session id, and the output is the next reply and "done".
 * Other inputs stay, but they are not required: a turn gives only the messages.
 */
export function conversationTask(t: TaskSpec): TaskSpec {
  if (t.interaction !== "conversation") {
    t.interaction = "single";
    return t;
  }
  const others = t.inputs.filter((i) => i.name !== "messages" && i.name !== "session_id").map((i) => ({ ...i, required: false }));
  t.inputs = [
    {
      name: "messages",
      type: "array",
      description: 'The turns so far: [{"role": "user" | "assistant", "content": "..."}]. The last turn is the new message of the user.',
      required: true,
    },
    { name: "session_id", type: "string", description: "The id of the conversation. It is the same in each turn.", required: false },
    ...others,
  ];
  const outs = t.outputs.filter((o) => o.name !== "reply" && o.name !== "done");
  t.outputs = [
    { name: "reply", type: "string", description: "The next message to the user" },
    { name: "done", type: "boolean", description: "true when the conversation is finished" },
    ...outs,
  ];
  t.exampleInputs = t.exampleInputs.map((ex) => {
    if (Array.isArray(ex.messages)) return ex;
    const first = Object.values(ex).find((v) => typeof v === "string" && v.trim()) as string | undefined;
    return { messages: [{ role: "user", content: first ?? "Hello" }] };
  });
  return t;
}

/** The rules of a task as prompt text (docs/POLICY.md). */
export function rulesPrompt(t: { rules?: TaskRule[] } | undefined, use: "design" | "critic" | "testgen"): string {
  const rules = t?.rules ?? [];
  if (!rules.length) return "";
  const list = rules.map((r) => `- ${r.id} [${r.kind === "must" ? "MUST" : "MUST NOT"}${r.important ? ", important" : ""}]: ${r.rule}`).join("\n");
  if (use === "design")
    return `\n\nRULES OF THE TASK (from a policy). The agent must obey each rule:\n${list}\nState the rules in the system prompt or the task of each step that decides or acts. Put an "action_gate" step before each step that changes data (see ACTION GATE in the rules): it checks the important rules and the confirmation. For an action that the rules say to do at once or without a confirmation, set "requireConfirmation": false on its gate, or put its class in "noConfirmation" of the agent step that calls it. When the input asks for a thing that a rule forbids, the agent refuses it and gives the rule as the reason.`;
  if (use === "critic")
    return `\n\nRULES OF THE TASK:\n${list}\nA RULE VIOLATION is its own failure: a new source does not fix it. Fix it in the prompt or with a step that checks the rule before the action. Never weaken or remove a rule to make a test pass. A refusal that a rule asks for is a correct result.`;
  return `\nRULES OF THE TASK:\n${list}`;
}

/** The prompt section for a conversation agent. */
const CONVERSATION_NOTE = (t: TaskSpec | undefined) =>
  t?.interaction === "conversation"
    ? '\n\nCONVERSATION AGENT: follow CONVERSATION AGENTS in the rules. Answer with an "agent" step that gets "conversation": "{{input.messages}}". The output node gives "reply" and "done". Start with a "decision" step on the LAST user message: does it ask for something new? When it only thanks or says goodbye, with no request, a short reply step answers it, with "done": true and no tool call. A request to stop, cancel, or opt out ("stop calling me") is a new request, not a closing: write this in the criteria of the decision. Put an "action_gate" step before each step that changes data (see ACTION GATE in the rules).'
    : "";

/** The attached files of a build that exist (ids from the build input). */
function attachedFiles(ctx: NodeContext<any>, ids: unknown): StoredFile[] {
  const list = Array.isArray(ids) ? ids.map(String) : typeof ids === "string" && ids ? ids.split(",").map((s) => s.trim()) : [];
  return list.map((id) => ctx.services.files?.get(id)).filter((f): f is StoredFile => !!f);
}

/** The saved agents that a new agent can call with a subagent step. The examples of the build are not in it (docs/LIBRARY.md). */
function agentsCatalog(ctx: NodeContext<any>, exclude: string[] = []): string {
  const list = ctx.services.store
    .listAgents()
    .filter((a) => !a.system && !exclude.includes(a.id))
    .slice(0, 30)
    .map((a) => {
      const spec = a.versions.find((v) => v.version === a.currentVersion)?.spec;
      const inputs = Object.keys((spec?.inputSchema as JSONSchema)?.properties ?? {}).join(", ");
      return `- ${a.id}: ${a.description || a.name} (input: ${inputs || "none"})`;
    });
  return list.length ? list.join("\n") : "(none)";
}

/* =============================== anvil_triage ============================== */

const TriageConfig = z.object({
  request: z.string().min(1),
  clarifications: z.unknown().optional(),
  evaluate: z.unknown().optional(),
  optimize: z.unknown().optional(),
  /** Ask a person when the high estimate is above this value. The config value applies when not set. */
  confirmAboveUsd: z.number().min(0).optional(),
  /** false: do not ask, stop the build when the estimate is above the limit (unattended builds). */
  askOnCost: z.unknown().optional(),
});

export const AnvilTriageNode: NodeClass<z.infer<typeof TriageConfig>> = {
  type: "anvil_triage",
  title: "Triage (System 1)",
  category: "anvil",
  internal: true,
  defaultTimeoutMs: 0, // meta-steps are bounded by the run policy timeout
  description:
    "Speculative fan-out: one Jev call answers every intake question about the request (clarity, architecture pattern, complexity, capability flags). Low-confidence pattern choices escalate to the reasoning model.",
  whenToUse: "First step of a build.",
  configSchema: TriageConfig,
  example: { request: "{{input.request}}" },
  async execute(ctx) {
    const { request, clarifications } = ctx.config;
    const answers = await ctx.brain.decide({
      purpose: "triage request",
      state: { request, clarifications: clarifications ?? null },
      escalate: true,
      questions: {
        clarity: {
          type: "noul",
          instructions: "Does the request contain enough information to build a working automated agent without asking the user anything?",
          criteria: {
            true: "The goal, the inputs and the expected output are clear or can be reasonably assumed.",
            false: "Essential information is missing or ambiguous, so the result would likely miss the user's intent.",
          },
        },
        pattern: { type: "choice", instructions: "Which architecture pattern fits this agent best?", criteria: PATTERNS },
        complexity: {
          type: "score",
          instructions: "How complex is the work that the agent must do?",
          criteria: ["A single step", "2-3 sequential steps", "4-6 steps, possibly with branching", "7+ steps with multiple branches, lists or tools"],
        },
        needs_web: { type: "noul", instructions: "Does the agent need to access the internet (search, read web pages, call external APIs)?" },
        side_effects: { type: "noul", instructions: "Will the agent take actions that change the outside world (send messages, post, write to external systems, pay)?" },
        needs_memory: { type: "noul", instructions: "Must the agent remember information across separate runs?" },
        has_lists: { type: "noul", instructions: "Does the agent work through a list or a set of items, one item at a time?" },
        quality_bar: { type: "noul", instructions: "Does the output have explicit quality requirements (tone, length, format, must-include facts) that are worth self-checking?" },
      },
    });
    const num = (id: string) => {
      const a = answers[id];
      return a?.type === "noul" ? a.noul : a?.type === "score" ? a.score : 0;
    };
    const p = answers.pattern;
    const triage: Triage = {
      pattern: p?.type === "choice" ? p.choice : "pipeline",
      patternConfidence: p?.type === "choice" ? p.confidence : 0,
      clarity: num("clarity"),
      complexity: num("complexity"),
      flags: { needs_web: num("needs_web"), side_effects: num("side_effects"), needs_memory: num("needs_memory"), has_lists: num("has_lists"), quality_bar: num("quality_bar") },
      escalated: !!(p as { escalated?: boolean })?.escalated,
    };
    artifact(ctx, "triage", { ...triage, answers });
    const est = await ctx.services.costModel?.estimate({
      pattern: triage.pattern,
      needsWeb: triage.flags.needs_web >= ctx.brain.config.thresholds.triageFlag,
      complexity: triage.complexity,
      evaluate: !off(ctx.config.evaluate),
      optimize: !off(ctx.config.optimize),
    });
    if (est) {
      const limitUsd = ctx.config.confirmAboveUsd ?? ctx.brain.config.buildConfirmUsd;
      const above = est.highUsd > limitUsd;
      const ask = !off(ctx.config.askOnCost);
      triage.estimate = { ...est, limitUsd, needsConfirmation: above && ask, overLimit: above && !ask };
      artifact(ctx, "estimate", triage.estimate);
      ctx.log(`estimated cost $${est.lowUsd}–$${est.highUsd} (${est.basis}, ${est.samples} similar builds)${above ? ` — above the $${limitUsd} limit` : ""}`);
    }
    return { output: triage };
  },
};

/* =============================== anvil_analyze ============================= */

const TASKSPEC_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Short product-like agent name" },
    agentId: { type: "string", description: "kebab-case id" },
    summary: { type: "string", description: "One sentence describing what the agent does" },
    goal: { type: "string" },
    inputs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "snake_case" },
          type: { type: "string", enum: ["string", "number", "integer", "boolean", "array", "object"] },
          description: { type: "string" },
          required: { type: "boolean" },
          example: {},
          file: { type: "boolean", description: "true when the input is a file that a person attaches at run time (type object)" },
        },
        required: ["name", "type", "description", "required"],
      },
      minItems: 1,
    },
    outputs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string" },
          description: { type: "string" },
          optional: { type: "boolean", description: "true when a correct result can leave this field empty or null, for example 'the tracking number, when the order is shipped'" },
        },
        required: ["name", "type", "description"],
      },
      minItems: 1,
    },
    steps: { type: "array", items: { type: "string" }, minItems: 1 },
    constraints: { type: "array", items: { type: "string" } },
    successCriteria: { type: "array", items: { type: "string" }, minItems: 2, description: "Testable statements about a good output" },
    assumptions: { type: "array", items: { type: "string" } },
    clarifyingQuestions: { type: "array", items: { type: "string" }, description: "Only questions whose answers would change the design; empty if none" },
    dataNeeds: {
      type: "array",
      description:
        "External data that the agent must get at run time from the web or an API (not from its input). Examples: current values from a public API, records from an open-data portal, the text of a specific web page. Do not list general web search or the pages that a search finds: the agent has web_search and fetch_url tools for that. Empty when the input or the model knowledge is enough.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "snake_case" },
          description: { type: "string", description: "What data, about what, from where in the world" },
          fields: { type: "array", items: { type: "string" }, description: "The fields the agent needs, e.g. id, name, value, date" },
          freshness: { type: "string", description: "How current the data must be, e.g. 'today', 'this month'" },
          required: { type: "boolean", description: "true when the agent cannot do its job without this data" },
        },
        required: ["id", "description", "fields", "required"],
      },
    },
    exampleInputs: {
      type: "array",
      items: { type: "object" },
      minItems: 2,
      maxItems: 4,
      description: "Realistic, varied example input objects using exactly the declared input names",
    },
    files: {
      type: "array",
      description: "One entry for each attached file: its role for this agent",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "The file id (f_…)" },
          name: { type: "string" },
          role: {
            type: "string",
            enum: ["sample_input", "reference", "context"],
            description:
              "sample_input: an example of the input that the agent gets at run time. reference: data that the agent reads in each run (a price list, a policy, a template). context: information for the design only.",
          },
          use: { type: "string", description: "One sentence: how the agent uses the file" },
        },
        required: ["id", "name", "role", "use"],
      },
    },
    rules: {
      type: "array",
      description:
        "The rules that the agent must obey, when the request or an attached file gives a policy, terms, limits, or things that the agent must not do. One rule for each item, in your words, in STE. Example: a refund policy gives 'Refund only an order that is less than 30 days old'. Empty when there is no policy.",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "snake_case" },
          rule: { type: "string", description: "One sentence that a reviewer can check from the output" },
          kind: { type: "string", enum: ["must", "must_not"] },
          important: { type: "boolean", description: "true when a break of the rule costs money, breaks a law or a promise, or harms the user" },
          source: { type: "string", description: "'request' or the name of the file" },
        },
        required: ["id", "rule", "kind", "important", "source"],
      },
    },
    interaction: {
      type: "string",
      enum: ["single", "conversation"],
      description:
        "conversation: the agent talks with a user over many turns (a support agent, an assistant that asks for missing facts, a booking dialog). Its input is the turns so far, and its output is the next reply. single: one input gives one result. Use single unless the request describes a dialog with a user.",
    },
    trigger: {
      type: "object",
      description:
        "How the agent starts once deployed. 'manual' unless the request says WHEN it runs. Reacting to NEW items in a feed/list ('for each new post', 'new items on this RSS', 'when this page changes') → poll with the feed url: the platform checks the feed, dedupes, and runs the agent ONCE PER NEW ITEM, so the agent itself must NOT fetch the feed — its inputs are the item fields (rss items: title, link, summary, published, id; page: url, title, text). A periodic job that is not per-item ('every weekday at 9 send a digest', 'hourly') → schedule (cron or every) with fixed inputs. Incoming events from another system ('when a form is submitted', 'when an order is created') → webhook, inputs = the event payload. After another agent finishes → agent.",
      properties: {
        kind: { type: "string", enum: ["manual", "schedule", "webhook", "poll", "agent"] },
        description: { type: "string" },
        cron: { type: "string", description: "5-field cron for schedule, e.g. '0 9 * * 1-5'" },
        every: { type: "string", description: "Interval like '15m' / '1h' (schedule or poll)" },
        timezone: { type: "string", description: "IANA timezone if the request implies one" },
        url: { type: "string", description: "Feed or page URL for poll" },
        agentId: { type: "string" },
      },
      required: ["kind", "description"],
    },
  },
  required: [
    "dataNeeds",
    "name",
    "agentId",
    "summary",
    "goal",
    "inputs",
    "outputs",
    "steps",
    "constraints",
    "successCriteria",
    "assumptions",
    "clarifyingQuestions",
    "exampleInputs",
    "trigger",
  ],
};

const AnalyzeConfig = z.object({
  request: z.string().min(1),
  triage: z.unknown(),
  clarifications: z.unknown().optional(),
  allowClarification: z.unknown().optional(),
  previous: z.unknown().optional().describe("A previous task spec; returned unchanged when there are no new clarifications"),
  /** The ids of the attached files (docs/FILES.md). */
  files: z.unknown().optional(),
  /** The given tools of the build (docs/TOOLS.md). */
  tools: z.unknown().optional(),
  /** The given tests of the build (docs/TESTS.md): their input keys are fixed input names. */
  tests: z.unknown().optional(),
});

/**
 * The input names that the build must keep (docs/TESTS.md): the names that the request gives
 * for the input ("The input is order_id"), and the input keys of the given tests. A platform
 * calls the agent with these names, so the agent must not rename them.
 */
export async function fixedInputNames(ctx: NodeContext<any>, request: string, tests: unknown): Promise<string[]> {
  const names = new Set<string>();
  try {
    for (const t of tests === undefined || tests === null || tests === "" ? [] : parseExternalTests(tests, null))
      if (!t.conversation) Object.keys(t.input ?? {}).forEach((k) => names.add(k));
  } catch {
    // Bad given tests fail later, in testgen, with the reason.
  }
  // Only a request with a name in the form of an identifier can name an input field.
  if (/\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b|\binputs?\b/i.test(request)) {
    const r = await ctx.brain
      .json<{ names: string[] }>({
        purpose: "fixed input names",
        system:
          "List the input field names that the request gives for the input of the agent, exactly as the request writes them (for example 'The input is order_id' gives order_id). Give only names that the request says are input fields. Give an empty list when the request names no input field.",
        user: request,
        schema: { type: "object", properties: { names: { type: "array", items: { type: "string" } } }, required: ["names"] },
        maxTokens: 300,
      })
      .catch(() => ({ names: [] }));
    for (const n of r.names) if (/^[A-Za-z][A-Za-z0-9_]*$/.test(n) && request.includes(n)) names.add(n);
  }
  return [...names];
}

function hasAnswers(c: unknown): boolean {
  return !!c && typeof c === "object" && Object.values(c as Record<string, unknown>).some((v) => String(v ?? "").trim());
}

export const AnvilAnalyzeNode: NodeClass<z.infer<typeof AnalyzeConfig>> = {
  type: "anvil_analyze",
  title: "Analyze → Task spec",
  category: "anvil",
  internal: true,
  defaultTimeoutMs: 0, // meta-steps are bounded by the run policy timeout
  description: "Turns the request (+ triage + clarifications) into a precise, testable task specification. Decides whether blocking clarifying questions must be asked.",
  whenToUse: "After triage.",
  configSchema: AnalyzeConfig,
  example: { request: "{{input.request}}", triage: "{{nodes.triage.output}}" },
  async execute(ctx) {
    const c = ctx.config;
    const triage = c.triage as Triage;
    if (c.previous && !hasAnswers(c.clarifications)) {
      ctx.log("no clarifications provided — keeping the original task spec");
      return { output: { taskSpec: c.previous, needsClarification: false } };
    }
    const flags = Object.entries(triage?.flags ?? {})
      .map(([k, v]) => `${k}=${Number(v).toFixed(2)}`)
      .join(", ");
    const attached = attachedFiles(ctx, c.files);
    const fixed = await fixedInputNames(ctx, c.request, c.tests);
    if (fixed.length) ctx.log(`fixed input names: ${fixed.join(", ")}`);
    const taskSpec = await ctx.brain.json<TaskSpec>({
      purpose: "analyze request",
      tier: "balanced",
      system: `You are a senior solutions architect. You change unclear automation requests into precise specifications for an AI agent. Be concrete and practical.
- Find sensible defaults yourself. Do not ask for them. Put them in the list of assumptions.
- Ask a clarifying question only when the answer changes the design.
- The inputs are the data that a user or an upstream system gives at run time. Do not make fixed settings into inputs.
- When a poll trigger starts the agent, its inputs are the fields of ONE feed item. For a webhook, the inputs are the fields of one event.
- A person must be able to check each success criterion from the output alone.
- Do not add requirements that the request does not give. For example, do not add a number of decimal places, an exact wording, or a fixed length.
- When the request or a file gives a policy, list each of its rules in "rules". Do not invent rules that the policy does not give.
- Write the goal, the success criteria, and the data needs in STE.

${STE_RULES}`,
      user: `REQUEST:\n${c.request}\n\nTRIAGE (from a fast classifier): pattern=${triage?.pattern} (confidence ${triage?.patternConfidence?.toFixed?.(2)}), clarity=${triage?.clarity?.toFixed?.(2)}, complexity=${triage?.complexity?.toFixed?.(2)}/3, ${flags}\n${hasAnswers(c.clarifications) ? `\nUSER CLARIFICATIONS (authoritative — override assumptions):\n${JSON.stringify(c.clarifications)}\n` : ""}\nProduce the task specification.${fixed.length ? `\n\nFIXED INPUT NAMES: the caller sends the input with these field names. Use them exactly, do not rename them: ${fixed.join(", ")}.` : ""}${attached.length ? `\n\nATTACHED FILES (the person attached them to this request):\n${attached.map((f) => filePreview(f)).join("\n\n")}\n\nGive each attached file a role in "files". For a sample_input, add an input field with type "object" and file true, and put {"fileId": "<id>"} in exampleInputs for that field. For a reference file, the agent reads it with a "file" step in each run: do not make it an input.` : ""}${toolsPrompt(c.tools as ToolsOutput | undefined)}`,
      schema: TASKSPEC_SCHEMA,
      maxTokens: 8000,
      check: async (t) => {
        const errs: string[] = [];
        const names = new Set(t.inputs.map((i) => i.name));
        // The caller sends these names: the agent must use them as they are.
        for (const n of fixed) if (!names.has(n)) errs.push(`the input must have the field "${n}" with exactly this name: the request or the given tests use it`);
        t.inputs.forEach((i) => !/^[a-z][a-z0-9_]*$/.test(i.name) && errs.push(`input name "${i.name}" must be snake_case`));
        t.exampleInputs.forEach((ex, k) => Object.keys(ex).forEach((key) => !names.has(key) && errs.push(`exampleInputs[${k}] uses undeclared input "${key}"`)));
        // Each attached file has a role, and a sample input has a file input field.
        for (const f of attached) if (!(t.files ?? []).some((x) => x.id === f.id)) errs.push(`give the attached file ${f.id} ("${f.name}") a role in "files"`);
        if ((t.files ?? []).some((x) => x.role === "sample_input") && !t.inputs.some((i) => i.file)) errs.push('a sample_input file needs an input field with "file": true');
        // A trigger changes the inputs of the agent (a poll gives the item fields). It must come from the request, not from the model.
        if (t.trigger && t.trigger.kind !== "manual" && !errs.length) {
          const a = await ctx.brain.decide({
            purpose: "check the trigger",
            state: { request: c.request, trigger: t.trigger },
            questions: {
              asked: {
                type: "noul",
                instructions:
                  "Does the request say WHEN the agent runs (a time, an interval, a schedule), ask it to react to new items or changes (a feed, a page, events), or ask it to run after another agent? A request that only describes a task (for example 'find the top stocks today') does not.",
              },
            },
          });
          const p = a.asked?.type === "noul" ? a.asked.noul : 1;
          if (p < ctx.brain.config.thresholds.triggerAsked)
            errs.push(
              `The request does not ask for a "${t.trigger.kind}" trigger (p=${p.toFixed(2)}). Use trigger kind "manual". The inputs are what a person gives when they run the agent, and the agent gets its data itself.`,
            );
        }
        return errs;
      },
    });
    // A closed build gets its data only from the given tools: no data need goes to the source plan.
    if ((c.tools as ToolsOutput | undefined)?.closed) taskSpec.dataNeeds = [];
    conversationTask(taskSpec);
    taskSpec.agentId =
      taskSpec.agentId
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "agent";
    // Without a person (unattended mode), the builder asks nothing: it writes its defaults into the assumptions.
    const allow = c.allowClarification !== false && c.allowClarification !== "false" && !ctx.brain.config.unattended;
    const needsClarification =
      allow && !hasAnswers(c.clarifications) && (triage?.clarity ?? 1) < ctx.brain.config.thresholds.clarifyBelow && taskSpec.clarifyingQuestions.length > 0;
    if (!needsClarification) taskSpec.clarifyingQuestions = hasAnswers(c.clarifications) ? [] : taskSpec.clarifyingQuestions;
    artifact(ctx, "taskSpec", { taskSpec, needsClarification });
    return { output: { taskSpec, needsClarification } };
  },
};

/* ============================== anvil_architect ============================ */

const ArchitectConfig = z.object({
  taskSpec: z.unknown(),
  triage: z.unknown(),
  sourcePlan: z.unknown().optional(),
  library: z.unknown().optional(),
  tools: z.unknown().optional(),
});

const AI_TYPES = new Set(["llm", "llm_structured", "agent", "refine", "map", "code_agent"]);
/** Step types that a Python program can do better when they need loops, many records, or exact computation. */
const CODE_CANDIDATE_TYPES = new Set(["agent", "llm", "llm_structured", "map", "http", "web_fetch", "web_search", "transform"]);

export const AnvilArchitectNode: NodeClass<z.infer<typeof ArchitectConfig>> = {
  type: "anvil_architect",
  title: "Architect → Plan",
  category: "anvil",
  internal: true,
  defaultTimeoutMs: 0, // meta-steps are bounded by the run policy timeout
  description: "Selects node classes from the registry and designs the step graph. Jev then assigns a model tier to every AI step and gates the plan's completeness.",
  whenToUse: "After analysis.",
  configSchema: ArchitectConfig,
  example: { taskSpec: "{{nodes.analyze.output.taskSpec}}", triage: "{{nodes.triage.output}}" },
  async execute(ctx) {
    const t = ctx.config.taskSpec as TaskSpec;
    const triage = ctx.config.triage as Triage;
    const types = ctx.services.registry.types();
    const sourcePlan = ctx.config.sourcePlan as SourcePlan | undefined;
    const sourceText = sourcePlan ? describeSourcePlan(sourcePlan) : "";
    const planSchema: JSONSchema = {
      type: "object",
      properties: {
        pattern: { type: "string", enum: Object.keys(PATTERNS) },
        rationale: { type: "string" },
        steps: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "snake_case node id" },
              type: { type: "string", description: `one of: ${types.filter((x) => x !== "input" && x !== "output").join(", ")} — or a type declared in newClasses` },
              purpose: { type: "string" },
              dependsOn: { type: "array", items: { type: "string" }, description: "ids of steps (or 'input') that must run first" },
              branch: {
                type: ["object", "null"],
                properties: { from: { type: "string" }, port: { type: "string" } },
                description: "If this step only runs on one branch of a decision/router step",
              },
            },
            required: ["id", "type", "purpose", "dependsOn"],
          },
        },
        output: { type: "string", description: "Which fields the final output object has and where each comes from" },
        newClasses: {
          type: "array",
          description: "Only for capabilities no existing class covers well (a specific external service/API, or a reusable specialized skill). Usually empty.",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: 'new class type, "x_" + snake_case' },
              kind: { type: "string", enum: ["http", "code", "llm"] },
              purpose: { type: "string", description: "What the class does, its inputs and outputs" },
              service: { type: "string", description: "For http: the API/service to call (prefer keyless public APIs)" },
            },
            required: ["type", "kind", "purpose"],
          },
        },
      },
      required: ["pattern", "rationale", "steps", "output"],
    };
    const given = (ctx.config.tools as ToolsOutput | undefined)?.closed ? (ctx.config.tools as ToolsOutput).tools.map((x) => x.type) : null;
    const check = (p: Plan) => {
      const errs: string[] = [];
      // A closed build uses only its given tools (docs/TOOLS.md).
      if (given)
        for (const s of p.steps) {
          if (NETWORK_NODE_TYPES.includes(s.type)) errs.push(`step "${s.id}" uses "${s.type}", but the build is closed: use the given tools ${given.join(", ")}`);
          else if (s.type.startsWith("x_") && !given.includes(s.type)) errs.push(`step "${s.id}" uses the class "${s.type}", which is not a given tool`);
        }
      const ids = new Set<string>(["input"]);
      const planned = new Set((p.newClasses ?? []).map((c) => c.type));
      for (const c of p.newClasses ?? []) {
        if (!/^x_[a-z][a-z0-9_]{1,46}$/.test(c.type)) errs.push(`new class type "${c.type}" must look like "x_snake_case"`);
        if (types.includes(c.type)) errs.push(`"${c.type}" already exists — use it directly instead of declaring it in newClasses`);
      }
      for (const s of p.steps) {
        if (!types.includes(s.type) && !planned.has(s.type))
          errs.push(`step "${s.id}" uses unknown type "${s.type}" (declare it in newClasses if it is a genuinely missing capability)`);
        if (s.type === "input" || s.type === "output") errs.push(`do not list ${s.type} as a step`);
        if (!/^[a-z][a-z0-9_]*$/.test(s.id)) errs.push(`step id "${s.id}" must be snake_case`);
        if (ids.has(s.id)) errs.push(`duplicate step id "${s.id}"`);
        for (const d of s.dependsOn) if (!ids.has(d)) errs.push(`step "${s.id}" depends on "${d}" which is not an earlier step (or "input")`);
        if (s.branch && !ids.has(s.branch.from)) errs.push(`step "${s.id}" branches from unknown step "${s.branch.from}"`);
        ids.add(s.id);
      }
      return errs;
    };
    const ask = (feedback?: string) =>
      ctx.brain.json<Plan>({
        purpose: feedback ? "revise plan" : "design plan",
        tier: "balanced",
        system: `You are the architect of an agent-building system. Design the smallest graph of typed steps that fully accomplishes the task, using ONLY these node classes:\n\n${ctx.services.registry.catalog()}\n\nArchitecture patterns: ${Object.entries(
          PATTERNS,
        )
          .map(([k, v]) => `${k}: ${v}`)
          .join(
            " | ",
          )}\n\nRules: steps are listed in execution order; "input" and "output" are implicit (do not list them). Use decision nodes for classification/routing, code/transform for exact computation, llm_structured when later steps need fields, refine when there is an explicit quality bar, human_approval before any consequential external action. Reuse an existing saved agent via a subagent step when one fits.\n\nMISSING CAPABILITIES: if the task needs something no class covers well — typically a specific external service (weather, currency, a SaaS API) or a reusable specialized skill — declare it in "newClasses" (type "x_…", kind http|code|llm) and use that type in steps; it will be generated, tested and added to the library before composing. Classes whose names start with x_ in the catalog are earlier generated classes — ALWAYS reuse them when they fit. When a step calls a specific external service's API (weather, geocoding, currency, a SaaS product…), prefer a reusable x_ class for it over a raw http node: it is tested in isolation and every future agent can reuse it, so the library compounds. Use raw http only for one-off calls to URLs supplied by the user. Do not invent classes for generic things llm/llm_structured/code/web_search already do. To apply a class to every item of a list, use a map step (mode \"node\").`,
        user: `TASK SPEC:\n${JSON.stringify(t)}\n\nTRIAGE HINT: pattern=${triage?.pattern} (confidence ${triage?.patternConfidence?.toFixed?.(2)}), flags=${JSON.stringify(triage?.flags)}\n\nAVAILABLE AGENTS (reusable via subagent):\n${agentsCatalog(
          ctx,
          ((ctx.config.library as LibraryContext | undefined)?.examples ?? []).map((e) => e.agentId),
        )}${sourceText ? `\n\nDATA SOURCE PLAN (mandatory — these sources were probed and work; use the given node type for each data need):\n${sourceText}` : ""}${libraryPrompt(ctx.config.library as LibraryContext | undefined, "architect")}${UNATTENDED_NOTE(ctx)}${CONVERSATION_NOTE(t)}${rulesPrompt(t, "design")}${toolsPrompt(ctx.config.tools as ToolsOutput | undefined)}${feedback ? `\n\nREVIEW FEEDBACK ON YOUR PREVIOUS PLAN:\n${feedback}` : ""}`,
        schema: planSchema,
        check,
        maxTokens: 6000,
      });

    let plan = await ask();
    // System-1 quality gate on the plan. With the sandbox on, it also asks which steps a Python program can do better.
    const sandboxOn = ctx.services.sandbox?.cfg.mode === "docker";
    const codeCandidates = sandboxOn ? plan.steps.filter((st) => CODE_CANDIDATE_TYPES.has(st.type)) : [];
    const gate = await ctx.brain.decide({
      purpose: "plan quality gate",
      state: {
        goal: t.goal,
        success_criteria: t.successCriteria,
        inputs: t.inputs.map((i) => i.name),
        outputs: t.outputs.map((o) => o.name),
        plan: plan.steps.map((s) => `${s.id} [${s.type}]: ${s.purpose}`),
      },
      questions: {
        complete: { type: "noul", instructions: "Will executing these steps produce every required output and satisfy the success criteria?" },
        minimal: { type: "noul", instructions: "Is the plan free of unnecessary or redundant steps?" },
        ...Object.fromEntries(
          codeCandidates.map((st, i) => [
            `code${i}`,
            {
              type: "noul" as const,
              instructions: `Step "${st.id}" (${st.purpose}): does it need many tool calls in a loop, many records, or exact computation (sort, count, statistics, join, dates)? Then one Python program does it better than a model.`,
            },
          ]),
        ),
      },
    });
    const complete = gate.complete?.type === "noul" ? gate.complete.noul : 1;
    const minimal = gate.minimal?.type === "noul" ? gate.minimal.noul : 1;
    const th = ctx.brain.config.thresholds;
    const toCode = codeCandidates.filter((_, i) => {
      const a = gate[`code${i}`];
      return a?.type === "noul" && a.noul >= th.codeStep;
    });
    if (toCode.length) artifact(ctx, "codeSteps", { steps: toCode.map((st) => st.id) });
    if (complete < th.planComplete || minimal < th.planMinimal || toCode.length) {
      const fb = [
        complete < th.planComplete
          ? `A reviewer estimates only ${(complete * 100).toFixed(0)}% probability that the plan produces every required output and meets the success criteria. Re-check each output field and criterion.`
          : "",
        minimal < th.planMinimal ? "The plan seems to contain unnecessary steps; remove anything not needed." : "",
        toCode.length
          ? `These steps need loops, many records, or exact computation: ${toCode.map((st) => st.id).join(", ")}. Make each of them a "code_agent" step, and give it the tools that it needs (for example http_request, fetch_url, web_search). A step that only writes text for a person stays a model step.`
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      ctx.log("plan gate → revising", { complete, minimal, toCode: toCode.map((st) => st.id) });
      plan = await ask(fb);
    }

    // System-1 model routing for every AI step, in one call.
    const aiSteps = plan.steps.filter((s) => AI_TYPES.has(s.type));
    if (aiSteps.length) {
      const tiers = await ctx.brain.decide({
        purpose: "assign model tiers",
        state: { agent_goal: t.goal, steps: aiSteps.map((s) => ({ id: s.id, type: s.type, purpose: s.purpose })) },
        questions: Object.fromEntries(
          aiSteps.map((s) => [
            `tier_${s.id}`.slice(0, 60),
            {
              type: "choice" as const,
              instructions: `Which model tier does step "${s.id}" (${s.type}: ${s.purpose}) need? Prefer the cheapest tier that will do it well.`,
              criteria: {
                fast: "Extraction, classification, formatting, short or templated writing.",
                balanced: "Summarizing long text, structured writing, moderate reasoning, tool use.",
                deep: "Hard multi-step reasoning, math, code, legal/medical nuance, complex planning.",
              },
            },
          ]),
        ),
      });
      for (const s of aiSteps) {
        const a = tiers[`tier_${s.id}`.slice(0, 60)];
        s.model = a?.type === "choice" ? a.choice : "fast";
      }
    }
    // The harness uses the source plan at run time (fallback sources), so it stays with the plan.
    if (sourcePlan) (plan as Plan & { sourcePlan?: SourcePlan }).sourcePlan = sourcePlan;
    artifact(ctx, "plan", { plan, gate: { complete, minimal } });
    return { output: { plan } };
  },
};

/* =============================== anvil_compose ============================= */

const ComposeConfig = z.object({
  taskSpec: z.unknown(),
  plan: z.unknown(),
  triage: z.unknown().optional(),
  request: z.string().optional(),
  library: z.unknown().optional(),
  tools: z.unknown().optional(),
});

export const AnvilComposeNode: NodeClass<z.infer<typeof ComposeConfig>> = {
  type: "anvil_compose",
  title: "Compose → Spec (+ compile loop)",
  category: "anvil",
  internal: true,
  defaultTimeoutMs: 0, // meta-steps are bounded by the run policy timeout
  description: "Writes the complete agent spec JSON from the plan, then runs the compiler loop: auto-fix → static validation → JSON-Patch repair until there are zero errors.",
  whenToUse: "After planning.",
  configSchema: ComposeConfig,
  example: { taskSpec: "{{nodes.analyze.output.taskSpec}}", plan: "{{nodes.architect.output.plan}}" },
  async execute(ctx) {
    const t = ctx.config.taskSpec as TaskSpec;
    const plan = ctx.config.plan as Plan;
    const lib = ctx.config.library as LibraryContext | undefined;
    const reg = ctx.services.registry;
    const types = new Set(plan.steps.map((s) => s.type));
    // A conversation or a task with rules needs the action gate (docs/GATE.md): compose sees its config schema.
    if (t.interaction === "conversation" || (t.rules ?? []).some((r) => r.important)) types.add("action_gate");
    // A draft that the repair loop cannot fix is written again from the start, with the errors as feedback.
    let feedback = "";
    let outcome!: Awaited<ReturnType<typeof validateAndRepair>>;
    for (let pass = 0; pass <= ctx.brain.config.composeRetries; pass++) {
      const draft = await ctx.brain.json<Record<string, unknown>>({
        purpose: pass ? `compose agent spec (new draft ${pass})` : "compose agent spec",
        tier: "balanced",
        system: `You write Anvil agent specs: executable JSON workflows. Obey the IR rules exactly. Write every prompt field in STE.\n\n${STE_RULES}\n\n${IR_GUIDE}\n\nNODE REFERENCE (config schemas):\n${nodeDocs(reg, types)}\n\nCOMPLETE EXAMPLE SPEC:\n${JSON.stringify({ ...EXAMPLE_SPEC, tests: undefined, policy: undefined, meta: undefined })}`,
        user: `Write the complete spec for this agent.\n\nTASK SPEC:\n${JSON.stringify(t)}\n\nPLAN (implement it faithfully; use exactly these step ids and types; "model" values are pre-assigned per step):\n${JSON.stringify(plan)}\n\nUse id "${t.agentId}" and name "${t.name}". The inputSchema must declare exactly these inputs: ${t.inputs.map((i) => `${i.name} (${i.file ? 'a file: type "object" with "format": "anvil-file"' : i.type}${i.required ? ", required" : ""})`).join(", ")}.${
          (t.files ?? []).some((f) => f.role === "reference")
            ? ` Read each reference file with a "file" step: ${(t.files ?? [])
                .filter((f) => f.role === "reference")
                .map((f) => `{"type": "file", "config": {"fileId": "${f.id}"}} for "${f.name}" (${f.use})`)
                .join("; ")}.`
            : ""
        }${(t.files ?? []).some((f) => f.role === "sample_input") ? " A sample input file is only an example: do not read it with a file step. The agent reads it from its file input field ({{input.<field>.text}} or .sheets)." : ""} The output node's value must contain: ${t.outputs.map((o) => o.name).join(", ")}.${t.trigger && t.trigger.kind !== "manual" ? `\n\nTRIGGER: ${JSON.stringify(t.trigger)} — add a matching entry to "triggers" (see TRIGGERS in the rules) and map the event into the agent input.` : ""}${libraryPrompt(lib, "compose")}${UNATTENDED_NOTE(ctx)}${CONVERSATION_NOTE(t)}${rulesPrompt(t, "design")}${toolsPrompt(ctx.config.tools as ToolsOutput | undefined)}${feedback}`,
        maxTokens: 16000,
        temperature: 0.2,
      });
      artifact(ctx, "spec", { stage: "draft", spec: draft });

      outcome = await validateAndRepair(draft, {
        brain: ctx.brain,
        registry: reg,
        getAgent: (id) => ctx.services.store.getAgent(id),
        maxAttempts: ctx.brain.config.repairMaxAttempts,
        context: `${t.summary}\nGoal: ${t.goal}`,
        request: typeof ctx.config.request === "string" ? ctx.config.request : undefined,
        sourcePlan: (plan as { sourcePlan?: SourcePlan }).sourcePlan,
        files: t.files,
        givenTools: (ctx.config.tools as ToolsOutput | undefined)?.closed ? (ctx.config.tools as ToolsOutput).tools.map((x) => x.type) : undefined,
        onStep: (s) => {
          artifact(ctx, "validation", {
            attempt: s.attempt,
            strategy: s.strategy,
            errors: s.result.errors,
            warnings: s.result.warnings,
            diagnostics: s.result.diagnostics,
            fixes: s.fixes,
            notes: s.notes,
          });
          if (s.attempt > 0) artifact(ctx, "spec", { stage: "repaired", spec: s.spec, attempt: s.attempt });
          ctx.log(`compile pass ${s.attempt} (${s.strategy}): ${s.result.errors} errors, ${s.result.warnings} warnings`);
        },
      });
      if (outcome.spec) break;
      feedback = `\n\nAN EARLIER DRAFT DID NOT COMPILE. Do not make these errors again:\n${formatDiagnostics(outcome.result.diagnostics.filter((d) => d.severity === "error")).slice(0, 3000)}`;
      if (pass < ctx.brain.config.composeRetries) ctx.log("the repair loop could not fix the draft: compose writes a new draft", undefined, "warn");
    }
    if (!outcome.spec) {
      throw new Error(`Could not produce a valid spec after ${outcome.attempts} repair attempts:\n${formatDiagnostics(outcome.result.diagnostics)}`);
    }
    const spec: AgentSpec = {
      ...outcome.spec,
      id: t.agentId,
      name: outcome.spec.name || t.name,
      description: outcome.spec.description || t.summary,
      meta: {
        ...outcome.spec.meta,
        builtBy: "anvil-builder",
        request: ctx.config.request,
        taskSpec: t,
        ...(t.interaction === "conversation" ? { interaction: "conversation" } : {}),
        plan,
        pattern: plan.pattern,
        compile: outcome.history,
        // The class of the agent, and the library agents that the build used as examples (docs/LIBRARY.md).
        ...(lib?.taxonomy ? { taxonomy: { ...lib.taxonomy, pattern: plan.pattern in PATTERNS ? plan.pattern : lib.taxonomy.pattern } } : {}),
        ...(lib?.examples?.length ? { examples: lib.examples.map((e) => ({ agentId: e.agentId, version: e.version, similarity: e.similarity })) } : {}),
        // A closed build keeps its given tools: evolve and the compiler check them later (docs/TOOLS.md).
        ...((ctx.config.tools as ToolsOutput | undefined)?.closed ? { givenTools: (ctx.config.tools as ToolsOutput).tools.map((x) => x.type) } : {}),
      },
      // Autonomy is opt-in: triggers written by the builder start disabled until a person enables them.
      triggers: outcome.spec.triggers?.map((tr) => ({ ...tr, enabled: false })),
    };
    // The definition of done for the harness. A rule set from the model stays as it is.
    if (!spec.acceptance?.length) spec.acceptance = deriveAcceptance(spec, t, ctx.brain.config.rules.maxAcceptance);
    else spec.acceptance = withRuleAcceptance(spec.acceptance, t, ctx.brain.config.rules.maxAcceptance);
    if (spec.triggers?.length) ctx.log(`${spec.triggers.length} trigger(s) added — disabled until you enable them`);
    artifact(ctx, "spec", { stage: "compiled", spec, warnings: outcome.result.diagnostics.filter((d) => d.severity !== "error") });
    return { output: { spec, diagnostics: outcome.result.diagnostics, repairs: outcome.attempts } };
  },
};

/* =============================== anvil_testgen ============================= */

const TestgenConfig = z.object({
  taskSpec: z.unknown(),
  spec: z.unknown(),
  count: z.number().int().min(1).max(8).default(3),
  library: z.unknown().optional(),
  tools: z.unknown().optional(),
  /** Given tests (docs/TESTS.md). They come first, and the generated tests come after them. */
  given: z.unknown().optional(),
});

/** True when an "equals" check expects a text that the enum of its top-level output field does not have: the test guessed the value. */
export function enumProblem(shape: JSONSchema | undefined, c: { path: string; op: string; value?: unknown }): boolean {
  if (c.op !== "equals" || typeof c.value !== "string" || /[.[]/.test(c.path)) return false;
  const values = ((shape as { properties?: Record<string, { enum?: unknown[] }> } | undefined)?.properties?.[c.path]?.enum ?? []) as unknown[];
  return values.length > 0 && !values.some((v) => String(v).toLowerCase() === c.value!.toString().toLowerCase());
}

/** The id of a test from outside: a given test ("g" and a number, docs/TESTS.md) or a feedback test ("f" and a number, docs/FEEDBACK.md). */
export const isGivenTest = (id: string) => /^[gf]\d+$/.test(id);

/** The given tests of a build (docs/TESTS.md), with ids that do not clash with the generated tests. */
function givenTests(raw: unknown): TestCase[] {
  if (raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && !raw.length)) return [];
  return withPrefix(parseExternalTests(raw, null), "g");
}

/** The testgen section for the sample input files of the task (docs/FILES.md). */
function sampleFilesPrompt(ctx: NodeContext<any>, t: TaskSpec): string {
  const samples = (t.files ?? [])
    .filter((f) => f.role === "sample_input")
    .map((f) => ctx.services.files?.get(f.id))
    .filter((f): f is StoredFile => !!f);
  const field = (t.inputs ?? []).find((i) => i.file)?.name;
  if (!samples.length || !field) return "";
  return `\nSAMPLE INPUT FILES (the person attached them as examples of the input):\n${samples.map((f) => filePreview(f, 800)).join("\n\n")}\nUse each sample file in a test: put {"fileId": "<id>"} as the value of the input field "${field}". For an edge case without a sample file, write the file content yourself: {"name": "<file name>", "kind": "text", "text": "<content>"}.`;
}

function outputKeys(spec: AgentSpec): string[] {
  const outs = spec.nodes.filter((n) => n.type === "output");
  const keys = new Set<string>();
  for (const o of outs) {
    const v = (o.config as { value?: unknown }).value;
    if (v && typeof v === "object" && !Array.isArray(v)) Object.keys(v).forEach((k) => keys.add(k));
  }
  return [...keys];
}

/**
 * Makes the acceptance rules from the spec and the task: an "exists" check for
 * each field of the output node, and a judge rule for each success criterion (4 at most).
 */
/**
 * A failure from a blocked source or from missing data is a capability gap, not a prompt problem.
 * The hint tells the critic to change the access path, and gives the fallbacks of the source plan.
 */
export function capabilityHint(classes: (string | undefined)[], plan?: { sourcePlan?: SourcePlan }): string {
  if (!classes.some((c) => c === "source_blocked" || c === "no_data")) return "";
  const fallbacks = (plan?.sourcePlan?.needs ?? []).flatMap((n) =>
    n.fallbacks.map((f) => `- ${n.need.id}: ${f.candidate.url ?? f.candidate.description} (${f.access}${n.use?.nodeType ? `, class ${n.use.nodeType}` : ""})`),
  );
  return `\n\nCAPABILITY GAP: the harness classified some failures as a blocked source or missing data. A better prompt does not fix this. Change the access path: use a different source, a public API, the "browser" node or "browse" tool for pages that need JavaScript, or a class from the source plan. If no source can work, make the agent return the gaps honestly instead of empty fields.${fallbacks.length ? `\nSOURCE PLAN FALLBACKS:\n${fallbacks.join("\n")}` : ""}`;
}

/**
 * The intent guard: one Jev call checks that the changes of a candidate keep
 * the meaning of the request. A critic can make a test pass by a change that
 * the person did not ask for (for example, a filter that no longer applies).
 */
async function intentKept(
  ctx: NodeContext<any>,
  spec: AgentSpec,
  task: TaskSpec | undefined,
  critique: { diagnosis: string; changes: string[] },
): Promise<{ kept: boolean; p: number }> {
  const request = (spec.meta?.request as string | undefined) ?? task?.goal ?? spec.description;
  const a = await ctx.brain.decide({
    purpose: "intent guard",
    state: { request, goal: task?.goal ?? spec.description, success_criteria: task?.successCriteria ?? [], diagnosis: critique.diagnosis, changes: critique.changes },
    questions: {
      kept: {
        type: "noul",
        instructions:
          "After these changes, does the agent still do what the request asks, with the same meaning? The filters, the thresholds, the units, the time window, and the meaning of each output field must stay as the request says. A fix of a defect keeps the meaning.",
      },
    },
  });
  const p = a.kept?.type === "noul" ? a.kept.noul : 1;
  return { kept: p >= ctx.brain.config.thresholds.intentKeep, p };
}

/** The tested source plan of a spec, as text for the critic. */
function plannedText(spec: AgentSpec): string {
  const plan = (spec.meta?.plan as { sourcePlan?: SourcePlan } | undefined)?.sourcePlan;
  return plan?.needs?.length ? `\n\nSOURCE PLAN (tested sources and their fallbacks):\n${describeSourcePlan(plan)}` : "";
}

/** The acceptance rules of the important rules of a task. Their ids start with RULE_PREFIX, so the harness sees a break as a rule violation. */
export function ruleAcceptance(task: { rules?: TaskRule[]; interaction?: string }, max = 6): NonNullable<AgentSpec["acceptance"]> {
  // A judge of one turn cannot see if a rule of the full conversation holds: it fails rules that the turn has no part in.
  // The action gate checks the rules before each action, with the full conversation (docs/GATE.md).
  if (task.interaction === "conversation") return [];
  return (task.rules ?? [])
    .filter((r) => r.important && r.rule.trim().length >= 5)
    .slice(0, max)
    .map((r) => ({
      id: `${RULE_PREFIX}${r.id}`.replace(/[^A-Za-z0-9_]/g, "_"),
      kind: "judge" as const,
      criterion: `The output keeps this rule: "${r.rule}". An output that refuses a request because of the rule, and gives the reason, keeps it.`,
    }));
}

/** Adds the rule acceptance to a rule set that does not have it. */
export function withRuleAcceptance(acc: NonNullable<AgentSpec["acceptance"]>, task: { rules?: TaskRule[]; interaction?: string }, max = 6): NonNullable<AgentSpec["acceptance"]> {
  const have = new Set(acc.map((r) => r.id));
  return [...acc, ...ruleAcceptance(task, max).filter((r) => !have.has(r.id))];
}

export function deriveAcceptance(
  spec: AgentSpec,
  task: { successCriteria?: string[]; outputs?: { name: string; optional?: boolean }[]; interaction?: string; rules?: TaskRule[] },
  maxRules = 6,
): NonNullable<AgentSpec["acceptance"]> {
  // Only the fields that the task declares are required. An extra field (for example "error") or an optional field can be empty in a good result.
  const declared = new Set((task.outputs ?? []).filter((o) => !o.optional).map((o) => o.name));
  const keys = new Set([...outputKeys(spec), ...Object.keys((spec.outputSchema as JSONSchema | undefined)?.properties ?? {})]);
  // In a conversation, each turn gives only the reply and "done": the end fields (an outcome) come in the last turns.
  const perTurn = task.interaction === "conversation" ? new Set<string>([...REPLY_FIELDS, "done"]) : null;
  const checks = [...keys]
    .filter((k) => declared.has(k) && (!perTurn || perTurn.has(k)))
    .map((k) => ({ id: `has_${k}`.replace(/[^A-Za-z0-9_]/g, "_"), kind: "check" as const, check: { path: k, op: "exists" as const } }));
  // A success criterion of a conversation is about all turns. One turn cannot meet it, so the harness checks only the fields of a turn.
  const judges = (task.interaction === "conversation" ? [] : (task.successCriteria ?? []))
    .filter((c) => c.trim().length >= 5)
    .slice(0, 4)
    .map((criterion, i) => ({ id: `criterion_${i + 1}`, kind: "judge" as const, criterion }));
  return [...checks, ...judges, ...ruleAcceptance(task, maxRules)];
}

/**
 * True when the candidate report is better than the best report. A report
 * with skipped tests has a score from fewer tests. Thus a candidate that ran
 * more tests and passes more of them wins, and the scores are not compared.
 */
export function betterReport(
  next: EvaluationReport,
  best: EvaluationReport,
  th: { evolveMinGain: number; evolveScoreTolerance: number; evolvePassDrop?: number } = { evolveMinGain: 0.005, evolveScoreTolerance: 0.02, evolvePassDrop: 0 },
): boolean {
  // A report without one scored test (all tests failed because of the environment) cannot show a gain.
  if (next.environmentTests && next.environmentTests >= next.results.length) return false;
  if ((next.skippedTests ?? 0) < (best.skippedTests ?? 0) && next.passRate > best.passRate) return true;
  if ((next.skippedTests ?? 0) > (best.skippedTests ?? 0) && next.passRate <= best.passRate) return false;
  // Fewer passed tests is a worse agent, also with a higher score: the score of the partial items can grow while whole cases break.
  if (next.passRate < best.passRate - (th.evolvePassDrop ?? 0) - 1e-9) return false;
  return next.score > best.score + th.evolveMinGain || (next.passRate > best.passRate && next.score >= best.score - th.evolveScoreTolerance);
}

export const AnvilTestgenNode: NodeClass<z.infer<typeof TestgenConfig>> = {
  type: "anvil_testgen",
  title: "Synthesize tests",
  category: "anvil",
  internal: true,
  defaultTimeoutMs: 0, // meta-steps are bounded by the run policy timeout
  description: "Generates a small, varied evaluation suite (typical, edge and adversarial cases) with natural-language criteria (judged by Jev) and deterministic checks.",
  whenToUse: "After composing.",
  configSchema: TestgenConfig,
  example: { taskSpec: "{{nodes.analyze.output.taskSpec}}", spec: "{{nodes.compose.output.spec}}" },
  async execute(ctx) {
    const t = ctx.config.taskSpec as TaskSpec;
    const spec = ctx.config.spec as AgentSpec;
    const keys = outputKeys(spec);
    const shape = agentOutputSchema(spec);
    const lib = await libraryForSpec(ctx.services.kv, ctx.brain.config.library, spec, ctx.config.library as LibraryContext | undefined);
    const chat = t.interaction === "conversation" || spec.meta?.interaction === "conversation";
    // The data that the given tools know: tests then use ids that exist (docs/TOOLS.md).
    const toolData = await toolDataPrompt(ctx, ctx.config.tools as ToolsOutput | undefined, ctx.brain.config.tools.dataChars);
    // A conversation test: a simulated user talks with the agent. Its input has the other fields, and the messages come from the conversation.
    // Each important rule gets a test that tries to break it (docs/POLICY.md). These tests come in addition to the count.
    const breakable = (t.rules ?? []).filter((r) => r.important).slice(0, ctx.brain.config.rules.maxTests);
    const count = ctx.config.count + breakable.length;
    const turnInputOf = (tc: Omit<TestCase, "id">) => (chat ? { ...tc.input, messages: [{ role: "user", content: tc.conversation?.firstMessage ?? "" }] } : tc.input);
    const out = await ctx.brain.json<{ tests: Omit<TestCase, "id">[] }>({
      purpose: "synthesize tests",
      tier: "balanced",
      system: `You are a QA engineer. You write an evaluation suite for an AI agent.
- Write realistic test inputs that are complete. Put the documents or the text that the agent needs in the input.
- Write free-text values as people write them, with extra words: "Hotel, 1 night in Boston", "Flight SFO-JFK, business class". Do not use one keyword such as "hotel" in every test.
- Write one typical case, one harder case or edge case, and one tricky case (ambiguity, missing information, or adversarial phrasing).
- A criterion is a yes/no statement about the FINAL OUTPUT. A careful reviewer must be able to check it from the output alone.
- Do not write criteria that need outside knowledge, exact wording, or facts that change over time.
- Do not add format requirements that the goal and the success criteria do not give (for example, decimal places).
- A check is a deterministic assertion on an output field. Use only the paths in the OUTPUT SHAPE.
- Use "equals" only for a value that the agent must give exactly: a boolean, a number, an id from the input or the tools, or a value of an enum in the OUTPUT SHAPE. Do not guess a status word (for example "not_verified"): write a criterion for it.
- Each check value must agree with the correct result for the input of its test. For example, a test of a mismatch must expect the mismatch.
- When the output gives a conclusion from data (a maximum, a ranking, "the best", "the strongest") AND the output also shows that data, write one criterion that compares the conclusion with the data in the output.
- A criterion must not need data that the output does not show. For example, do not ask that an average equals the mean of daily values when the output does not list the daily values.
- When the input sets a time window or a filter (for example "the last N hours" or a minimum value), write one criterion that checks each item in the output against it. The judge knows the current time.
- The tests run now. A date in an input must agree with TODAY in the request: a test that expects data for "the next 5 days" uses a date in the next 5 days from TODAY, not a date from your memory.
- IMPORTANT: the tests run without a person. Each human_approval step is APPROVED automatically, with its payload unchanged. Each human_input step is skipped. Thus describe the output AFTER the approval, not a waiting state.
- Write the criteria in STE.

${STE_RULES}`,
      user: `TODAY: ${new Date().toISOString().slice(0, 10)}\nAGENT: ${spec.name} — ${spec.description}\nSTEPS: ${spec.nodes
        .filter((n) => n.type !== "input" && n.type !== "output")
        .map((n) => `${n.id} [${n.type}]`)
        .join(
          ", ",
        )}${spec.nodes.some((n) => n.type.startsWith("human_")) ? "\nNOTE: this agent has human steps; in tests they are auto-approved / skipped." : ""}\nGOAL: ${t.goal}\nSUCCESS CRITERIA: ${t.successCriteria.join(" | ")}\nINPUT SCHEMA: ${JSON.stringify(spec.inputSchema)}\nOUTPUT FIELDS: ${keys.join(", ") || "(free-form)"}${shape ? `\nOUTPUT SHAPE (a check path must exist in it): ${JSON.stringify(shape)}` : ""}\nEXAMPLE INPUTS: ${JSON.stringify(t.exampleInputs)}${readsLiveData(spec, t, (type) => ctx.services.registry.get(type)?.custom?.kind) ? `\nLIVE DATA: this agent gets its data from external sources at run time. A test cannot know the exact values. Do not expect exact values, counts, or rankings from the source in checks or criteria. Check the types, the lengths, and that the fields agree with each other. A test that expects data must use an input that exists at the source now (for example a real, well-known item). Do not invent an item and expect data for it. A test with an item that does not exist must expect a clear error, not data.` : ""}${libraryPrompt(lib, "testgen")}${sampleFilesPrompt(ctx, t)}${(ctx.config.tools as ToolsOutput | undefined)?.closed ? `${toolsPrompt(ctx.config.tools as ToolsOutput)}\nWrite test inputs that these tools can answer (for example ids that the tools know). A test can also give an input that the tools do not know, and expect a clear answer about it. Each test starts with the start state of the tools. A test that needs an earlier action (for example an order that is already refunded) does that action in the same test: a conversation asks for it first, and then asks again.${toolData}` : ""}${
        chat
          ? `\nCONVERSATION AGENT: a simulated user talks with the agent in each test. Give each test a "conversation": persona (who the user is and how the user talks), goal (what the user wants), firstMessage (the first message of the user), facts (what the user knows and gives when the agent asks, for example an order id), and maxTurns (3-8). The "input" has only the other input fields ({} when there are none), not "messages". The criteria judge the full conversation: for example, the agent asks for a missing fact, it does not change data before the user confirms, and its last reply answers the goal. Checks apply to the last output only: use them for state fields of the end (done, a status flag), not for words in "reply". Put a fact that a reply must say into a criterion: the criteria judge the full transcript. One test has a user who gives a wrong or unknown fact. In that test, the facts of the user hold only the wrong value, so the user cannot correct it later. When the task has rules (a policy, limits, what the agent must not do), one test has a user who asks for a thing that a rule forbids: the criteria expect that the agent refuses and gives the reason. The transcript shows the tool calls of each agent turn (toolCalls): a criterion can check that the agent called the right tool with the right arguments. Give each test this criterion: "The agent does not claim an action or a fact that its tool calls do not show." The simulated user follows the goal to its end, also after the agent says that it is done. Thus each criterion must be true for the FULL conversation that the goal makes: when the user gives the order id later, do not expect that the agent never looks up the order. A good agent that keeps the rules must meet each criterion in every way that the conversation can go: do not require a step that the user can make needless. When the persona gives a fact at once (its name), do not require that the agent asks for it. When the goal accepts the first offer, do not require the other offers. Write such a step with its condition: "When the user did not give the date of birth, the agent asks for it."`
          : ""
      }${rulesPrompt(t, "testgen")}${
        breakable.length
          ? `\nRULE TESTS: write ${breakable.length} of the tests to try to break a rule: one test for each of ${breakable.map((r) => r.id).join(", ")}. The input (or the user of the conversation) asks for a thing that the rule forbids, in a natural way. The criteria expect that the agent refuses or limits the action, gives the rule as the reason, and does not do the forbidden action. Start the name of such a test with "rule: <rule id>".`
          : ""
      }\n\nWrite ${count} tests. Each: name, input (object matching the input schema), criteria (2-4 statements), checks (0-3, using ops exists|equals|contains|matches|type|minLength|maxLength on output field paths).`,
      schema: {
        type: "object",
        properties: {
          tests: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                input: { type: "object" },
                criteria: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
                ...(chat
                  ? {
                      conversation: {
                        type: "object",
                        properties: {
                          persona: { type: "string" },
                          goal: { type: "string" },
                          firstMessage: { type: "string", minLength: 1 },
                          facts: { type: "object" },
                          maxTurns: { type: "integer", minimum: 1, maximum: 20 },
                        },
                        required: ["persona", "goal", "firstMessage"],
                      },
                    }
                  : {}),
                checks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      op: { type: "string", enum: ["exists", "equals", "contains", "matches", "type", "minLength", "maxLength"] },
                      value: {},
                    },
                    required: ["path", "op"],
                  },
                },
              },
              required: chat ? ["name", "input", "criteria", "checks", "conversation"] : ["name", "input", "criteria", "checks"],
            },
          },
        },
        required: ["tests"],
      },
      maxTokens: 8000,
      check: (v) => {
        const errs: string[] = [];
        v.tests.forEach((tc, i) => {
          for (const e of schemaErrors(spec.inputSchema, turnInputOf(tc))) errs.push(`tests[${i}].input ${e}`);
          if (chat && !tc.conversation?.firstMessage?.trim()) errs.push(`tests[${i}].conversation needs persona, goal, and firstMessage`);
        });
        return errs;
      },
    });
    // A check on a field that the output does not have tests the test, not the agent. It does not stay.
    let dropped = 0;
    const tests: TestCase[] = out.tests.map((tc, i) => {
      const checks = (tc.checks ?? []).filter((c) => (!checkPathProblem(shape, c.path) && !enumProblem(shape, c)) || (dropped++, false));
      const conversation =
        chat && tc.conversation
          ? {
              persona: tc.conversation.persona,
              goal: tc.conversation.goal,
              firstMessage: tc.conversation.firstMessage,
              facts: tc.conversation.facts ?? {},
              maxTurns: Math.min(20, Math.max(1, tc.conversation.maxTurns ?? 6)),
            }
          : undefined;
      const input = chat ? Object.fromEntries(Object.entries(tc.input ?? {}).filter(([k]) => k !== "messages" && k !== "session_id")) : tc.input;
      return { id: `t${i + 1}`, name: tc.name, input, criteria: tc.criteria, checks, ...(conversation ? { conversation } : {}) };
    });
    if (dropped) ctx.log(`${dropped} check(s) removed: the path is not in the agent output, or the value is not in its enum`, undefined, "warn");
    const given = givenTests(ctx.config.given);
    if (given.length) ctx.log(`${given.length} given test(s) come before the ${tests.length} generated test(s)`);
    const all = [...given, ...tests];
    artifact(ctx, "tests", { tests: all, ...(given.length ? { given: given.length } : {}) });
    return { output: { tests: all } };
  },
};

/* =============================== anvil_evolve ============================== */

const EvolveConfig = z.object({
  spec: z.unknown(),
  tests: z.unknown(),
  taskSpec: z.unknown().optional(),
  evaluate: z.unknown().optional(),
  optimize: z.unknown().optional(),
  target: z.number().min(0).max(1).optional(),
  maxRounds: z.number().int().min(0).max(6).optional(),
  /** Money for all evaluation rounds together. The config value applies when not set. */
  evalBudgetUsd: z.number().min(0).max(20).optional(),
  /** The library context of the build (docs/LIBRARY.md). Without it, the lessons of the class of the spec apply. */
  library: z.unknown().optional(),
});

const off = (v: unknown) => v === false || v === "false";

export const AnvilEvolveNode: NodeClass<z.infer<typeof EvolveConfig>> = {
  type: "anvil_evolve",
  title: "Evaluate ⟳ Evolve",
  category: "anvil",
  internal: true,
  defaultTimeoutMs: 0, // meta-steps are bounded by the run policy timeout
  description:
    "Runs the agent on its test suite (Jev grades each criterion), then iterates: remove test items that the diagnosis gives to the tests, have a critic diagnose traces and propose a JSON patch, recompile, re-evaluate, keep the best version (hill climbing).",
  whenToUse: "After tests are synthesized.",
  configSchema: EvolveConfig,
  example: { spec: "{{nodes.compose.output.spec}}", tests: "{{nodes.testgen.output.tests}}" },
  async execute(ctx) {
    const cfg = ctx.brain.config;
    const target = ctx.config.target ?? cfg.evolveTarget;
    const maxRounds = off(ctx.config.optimize) ? 0 : (ctx.config.maxRounds ?? cfg.evolveMaxRounds);
    let tests = ((ctx.config.tests as TestCase[]) ?? []).map((t) => ({ ...t, criteria: [...(t.criteria ?? [])], checks: [...(t.checks ?? [])] }));
    const t = ctx.config.taskSpec as TaskSpec | undefined;
    const base: AgentSpec = { ...(ctx.config.spec as AgentSpec), tests };
    const lib = await libraryForSpec(ctx.services.kv, cfg.library, base, ctx.config.library as LibraryContext | undefined);
    // The lessons of this build go to the domain of the agent, for the next builds of the same domain.
    const taxonomy = taxonomyOf(base) ?? lib?.taxonomy;
    const learn = async (items: Parameters<typeof recordLessons>[3]) => {
      if (taxonomy && items.length)
        await recordLessons(ctx.services.kv, cfg.library, taxonomy, items).catch((e) => ctx.log(`lessons not saved: ${(e as Error).message}`, undefined, "warn"));
    };
    if (tests.length) artifact(ctx, "tests", { tests });

    if (off(ctx.config.evaluate) || !tests.length) {
      ctx.log("evaluation skipped");
      return { output: { spec: base, evaluation: null, history: [] } };
    }

    // Money for all evaluation rounds of this build together.
    const evalBudget = ctx.config.evalBudgetUsd ?? cfg.evalBudgetUsd;
    let evalSpent = 0;
    const evalOnce = async (spec: AgentSpec, round: number, suite: TestCase[] = tests) => {
      const { report, traces } = await evaluateSpec(spec, suite, {
        services: ctx.services,
        brain: ctx.brain,
        signal: ctx.signal,
        smokeFirst: cfg.evalSmokeFirst,
        onSmokeNote: (note) => ctx.log(note),
        budgetUsd: Math.max(0, evalBudget - evalSpent),
        repeats: cfg.evalRepeats,
        onResult: (r) => artifact(ctx, "testResult", { round, result: r }),
      });
      evalSpent += report.costUsd;
      artifact(ctx, "evaluation", { round, report });
      ctx.log(`round ${round}: pass rate ${(report.passRate * 100).toFixed(0)}%, score ${report.score.toFixed(2)}`);
      return { report, traces };
    };

    let best: { spec: AgentSpec; report: EvaluationReport; traces: Record<string, Record<string, unknown>> };
    try {
      best = { spec: base, ...(await evalOnce(base, 0)) };
    } catch (e) {
      // Never lose a compiled agent because its evaluation broke.
      if (ctx.signal.aborted) throw e;
      ctx.log(`evaluation failed: ${(e as Error).message} — publishing without a score`, undefined, "warn");
      return { output: { spec: base, evaluation: null, history: [], error: (e as Error).message } };
    }
    const history: { round: number; score: number; passRate: number; accepted: boolean; change: string }[] = [
      { round: 0, score: best.report.score, passRate: best.report.passRate, accepted: true, change: "initial build" },
    ];

    for (let round = 1; round <= maxRounds && best.report.passRate < target; round++) {
      if (ctx.signal.aborted) break;
      if (evalSpent >= evalBudget) {
        ctx.log(`evolve stopped: the evaluation budget ($${evalBudget}) is used ($${evalSpent.toFixed(3)})`, undefined, "warn");
        history.push({ round, score: best.report.score, passRate: best.report.passRate, accepted: false, change: "stopped: evaluation budget used" });
        break;
      }
      let rejectedInARow = 0;
      for (let i = history.length - 1; i >= 0 && !history[i].accepted; i--) rejectedInARow++;
      if (rejectedInARow >= cfg.evolveMaxRejected) {
        ctx.log(`evolve stopped: ${rejectedInARow} rounds in a row gave no improvement`, undefined, "warn");
        break;
      }
      try {
        const failing = best.report.results.filter((r) => !r.passed);

        // 1) Test problems: the evaluation diagnosed who is wrong for each failed item.
        // An item that the diagnosis gives to the test leaves the suite, with its reason. The critic sees only agent problems.
        // A given test comes from the task (docs/TESTS.md): it is the authority, and it stays as it is.
        const dropped = failing
          .filter((r) => !isGivenTest(r.testId))
          .flatMap((r) =>
            (r.diagnosis ?? [])
              .filter((d) => isTestBlame(d.blame) && !d.disputed && d.confidence >= cfg.thresholds.diagnosisConfidence)
              .map((d) => ({ testId: r.testId, test: r.name, ...d })),
          );
        if (dropped.length) {
          const isDropped = (testId: string, kind: "criterion" | "check", item: string) => dropped.some((d) => d.testId === testId && d.kind === kind && d.item === item);
          const checkText = (c: TestCase["checks"][number]) => `${c.path} ${c.op}${c.value !== undefined ? ` ${JSON.stringify(c.value)}` : ""}`;
          tests = tests.map((tc) => ({
            ...tc,
            criteria: tc.criteria.filter((c) => !isDropped(tc.id, "criterion", c)),
            checks: (tc.checks ?? []).filter((c) => !isDropped(tc.id, "check", checkText(c))),
          }));
          artifact(ctx, "testsAdjusted", { dropped: dropped.map((d) => ({ ...d, meaning: BLAME_TEXT[d.blame].meaning })) });
          ctx.log(`removed ${dropped.length} test item(s) that the diagnosis gives to the tests, not to the agent`, dropped, "warn");
          await learn(
            dropped.map((d) => ({
              kind: "test_problem" as const,
              text: `${BLAME_TEXT[d.blame].label}: a test expected "${d.item}". ${BLAME_TEXT[d.blame].meaning}`,
              from: { agentId: best.spec.id, runId: ctx.runId },
            })),
          );
          best = { ...best, spec: { ...best.spec, tests }, ...(await evalOnce({ ...best.spec, tests }, round)) };
          history.push({
            round,
            score: best.report.score,
            passRate: best.report.passRate,
            accepted: true,
            change: `removed ${dropped.length} faulty test item(s): ${dropped.map((d) => BLAME_TEXT[d.blame].label).join(", ")}`,
          });
          if (best.report.passRate >= target) break;
        }

        // 2) Critic: diagnose from traces, propose a patch.
        // The critic gets only the items that are agent errors. Test errors and disputed items are not for the critic.
        const forAgent = (r: TestResult, kind: "criterion" | "check", item: string) => {
          const d = r.diagnosis?.find((x) => x.kind === kind && x.item === item);
          return !d || (d.blame === "agent" && !d.disputed);
        };
        const checkItem = (c: TestResult["checks"][number]) => `${c.check.path} ${c.check.op}${c.check.value !== undefined ? ` ${JSON.stringify(c.check.value)}` : ""}`;
        const stillFailing = best.report.results.filter(
          (r) =>
            !r.passed &&
            !r.skipped &&
            !r.environment &&
            (r.error || r.criteria.some((c) => !c.passed && forAgent(r, "criterion", c.criterion)) || r.checks.some((c) => !c.passed && forAgent(r, "check", checkItem(c)))),
        );
        if (!stillFailing.length) {
          const partialOnly = best.report.results.filter(
            (r) => !r.passed && !r.skipped && !r.environment && r.partial && !r.criteria.some((c) => !c.passed) && !r.checks.some((c) => !c.passed),
          );
          // The outputs meet every test item, so the acceptance rules that rejected them are wrong. Evolve removes them and evaluates again.
          // A rule for an empty output or a failed run always stays.
          const wrongRules = [...new Set(partialOnly.flatMap((r) => r.unmetRules ?? []))].filter(
            (id) => id !== "output" && id !== "run" && (best.spec.acceptance ?? []).some((a) => a.id === id),
          );
          if (wrongRules.length) {
            const removed = (best.spec.acceptance ?? []).filter((a) => wrongRules.includes(a.id));
            const relaxed: AgentSpec = { ...best.spec, acceptance: (best.spec.acceptance ?? []).filter((a) => !wrongRules.includes(a.id)) };
            artifact(ctx, "acceptanceAdjusted", {
              removed: removed.map((a) => ({
                id: a.id,
                rule: a.kind === "check" ? `${a.check.path} ${a.check.op}${a.check.value !== undefined ? ` ${JSON.stringify(a.check.value)}` : ""}` : a.criterion,
              })),
              tests: partialOnly.map((r) => r.name),
            });
            ctx.log(`removed ${removed.length} acceptance rule(s) that rejected outputs which meet every test item: ${wrongRules.join(", ")}`, undefined, "warn");
            best = { spec: relaxed, ...(await evalOnce(relaxed, round)) };
            history.push({
              round,
              score: best.report.score,
              passRate: best.report.passRate,
              accepted: true,
              change: `removed ${removed.length} wrong acceptance rule(s): ${wrongRules.join(", ")}`,
            });
            continue;
          }
          if (partialOnly.length) {
            ctx.log(
              `evolve stopped: ${partialOnly.length} test(s) pass all criteria but the harness gave a partial result (${[...new Set(partialOnly.map((r) => r.failureClass ?? "unknown"))].join(", ")}). Examine the acceptance rules of the agent.`,
              partialOnly.map((r) => ({ test: r.name, gaps: (r.output as { gaps?: unknown } | undefined)?.gaps })),
              "warn",
            );
            history.push({
              round,
              score: best.report.score,
              passRate: best.report.passRate,
              accepted: false,
              change: `stopped: ${partialOnly.length} test(s) are partial results that pass all criteria`,
            });
          }
          const disputed = best.report.results
            .flatMap((r) => r.diagnosis ?? [])
            .filter((d) => d.disputed || (isTestBlame(d.blame) && d.confidence < cfg.thresholds.diagnosisConfidence));
          if (disputed.length) {
            ctx.log(`evolve stopped: no agent error to fix. ${disputed.length} disputed test item(s) need a person`, disputed, "warn");
            history.push({
              round,
              score: best.report.score,
              passRate: best.report.passRate,
              accepted: false,
              change: `stopped: ${disputed.length} disputed test item(s) need a person`,
            });
          }
          break;
        }
        const evidence = stillFailing.map((r) => ({
          test: r.name,
          input: tests.find((x) => x.id === r.testId)?.input,
          error: r.error,
          output: truncateJson(r.output, 2000),
          failedCriteria: r.criteria.filter((c) => !c.passed && forAgent(r, "criterion", c.criterion)).map((c) => `${c.criterion} (p=${c.probability})`),
          failedChecks: r.checks
            .filter((c) => !c.passed && forAgent(r, "check", checkItem(c)))
            .map((c) => `${c.check.path} ${c.check.op} ${JSON.stringify(c.check.value ?? "")} (actual: ${truncateJson(c.actual, 200)})`),
          trace: Object.fromEntries(Object.entries(best.traces[r.testId] ?? {}).map(([k, v]) => [k, truncateJson(v, 1200)])),
          ...(r.partial ? { harness: { partial: true, failureClass: r.failureClass } } : {}),
        }));
        const capability = capabilityHint(
          stillFailing.map((r) => r.failureClass),
          best.spec.meta?.plan as { sourcePlan?: SourcePlan } | undefined,
        );
        // The evidence grows with the failed tests and the size of their traces (a map step makes large traces). It has a size limit.
        const evidenceText = JSON.stringify(shrinkJson(evidence, cfg.criticEvidenceChars));
        let critique: { diagnosis: string; lesson?: string; changes: string[]; operations: jsonpatch.Operation[] };
        try {
          critique = await ctx.brain.json({
            purpose: `critic (round ${round})`,
            tier: "deep",
            system: `You are an expert agent optimizer. You get an agent spec and the evidence of the failed tests, with the trace of each node.
- Find the ROOT CAUSE. Examples: a bad prompt, a missing step, a wrong data reference, a wrong node type, wrong routing, or a missing instruction.
- Fix the root cause with RFC 6902 JSON Patch operations on the spec.
- Do not change the tests. Keep the agent general. Do not put test answers in the spec.
- During the tests, human_approval steps are approved automatically and human_input steps are skipped.
- NEVER remove or go around human_approval gates or side-effect safeguards to make a test pass. When a test needs that, let it fail.
- NEVER change or remove a step with "locked": true. A person owns it. Change the steps around it.
- Keep each source URL that the request names. Change it only when the trace shows that the URL does not give the data.
- Keep the sources of the SOURCE PLAN. They are tested. When one fails, use one of its fallbacks, not a new source.
- Do not change what the agent does for the person to pass a test: keep the filters, the thresholds, the units, and the meaning of each output field. When a test asks for such a change, say so in the diagnosis and do not make the change.
- A check can fail because its path is not in the output. Then fix the agent only when the output misses data. Do not move fields to satisfy a wrong path.
- Write each prompt that you change in STE.\n\n${STE_RULES}\n\n${IR_GUIDE}\n\nNODE REFERENCE:\n${nodeDocs(ctx.services.registry, new Set(best.spec.nodes.map((n) => n.type)))}`,
            user: `SPEC:\n${JSON.stringify({ ...best.spec, tests: undefined, meta: undefined })}\n\nFAILING TESTS:\n${evidenceText}${capability}${rulesPrompt(best.spec.meta?.taskSpec as TaskSpec | undefined, "critic")}${plannedText(best.spec)}${libraryPrompt(lib, "critic")}`,
            schema: {
              type: "object",
              properties: {
                diagnosis: { type: "string" },
                lesson: {
                  type: "string",
                  description: "One or two STE sentences for later builds of the same domain: the general error and its fix. Do not name this agent, its nodes, or its tests.",
                },
                changes: { type: "array", items: { type: "string" } },
                operations: {
                  type: "array",
                  items: { type: "object", properties: { op: { type: "string" }, path: { type: "string" }, value: {}, from: { type: "string" } }, required: ["op", "path"] },
                },
              },
              required: ["diagnosis", "changes", "operations"],
            },
            maxTokens: 10000,
          });
        } catch (e) {
          ctx.log(`critic failed: ${(e as Error).message}`, undefined, "warn");
          break;
        }
        artifact(ctx, "critique", { round, diagnosis: critique.diagnosis, changes: critique.changes });
        let patched: unknown;
        try {
          const r = applyPatchLenient({ ...best.spec, tests: [] }, critique.operations);
          if (!r.applied) throw new Error(r.skipped.slice(0, 3).join("; ") || "empty patch");
          if (r.skipped.length) ctx.log(`critic patch: ${r.applied} ops applied, ${r.skipped.length} skipped`, r.skipped, "warn");
          patched = r.doc;
        } catch (e) {
          ctx.log(`critic patch did not apply: ${(e as Error).message}`, undefined, "warn");
          history.push({ round, score: best.report.score, passRate: best.report.passRate, accepted: false, change: `patch failed: ${critique.changes.join("; ")}` });
          continue;
        }
        const request = best.spec.meta?.request as string | undefined;
        const sourcePlan = (best.spec.meta?.plan as { sourcePlan?: SourcePlan } | undefined)?.sourcePlan;
        const files = (best.spec.meta?.taskSpec as TaskSpec | undefined)?.files;
        const givenTools = givenToolsOf(best.spec);
        const compiled = await validateAndRepair(patched, {
          brain: ctx.brain,
          registry: ctx.services.registry,
          getAgent: (id) => ctx.services.store.getAgent(id),
          maxAttempts: 2,
          request,
          sourcePlan,
          files,
          givenTools: givenTools.length ? givenTools : undefined,
        });
        if (!compiled.spec) {
          history.push({ round, score: best.report.score, passRate: best.report.passRate, accepted: false, change: `candidate did not compile: ${critique.changes.join("; ")}` });
          continue;
        }
        const candidate: AgentSpec = carryLayout(best.spec, { ...compiled.spec, id: best.spec.id, tests, meta: best.spec.meta });
        // Invariant (docs/WORKFLOW_EDITOR.md): evolution never changes a step that a person locked.
        const lockedHit = lockedViolations(best.spec, candidate);
        if (lockedHit.length) {
          ctx.log(`round ${round}: candidate changes locked step(s) ${lockedHit.join(", ")} — rejected`, undefined, "warn");
          history.push({
            round,
            score: best.report.score,
            passRate: best.report.passRate,
            accepted: false,
            change: `rejected (changes locked steps ${lockedHit.join(", ")}): ${critique.changes.join("; ")}`,
          });
          continue;
        }
        // Safety invariant: evolution may never remove human approval gates.
        const gates = (x: AgentSpec) => x.nodes.filter((n) => n.type === "human_approval").length;
        if (gates(candidate) < gates(best.spec)) {
          ctx.log(`round ${round}: candidate removes a human_approval gate — rejected by safety invariant`, undefined, "warn");
          history.push({
            round,
            score: best.report.score,
            passRate: best.report.passRate,
            accepted: false,
            change: `rejected (removes human approval gate): ${critique.changes.join("; ")}`,
          });
          continue;
        }
        // Invariant: evolution may not remove a source that the request names.
        const lost = missingNamedUrls(
          request,
          candidate.nodes.map((n) => n.config),
        ).filter(
          (u) =>
            !missingNamedUrls(
              request,
              best.spec.nodes.map((n) => n.config),
            ).includes(u),
        );
        // Invariant: evolution may not change to a source that the source plan did not test.
        lost.push(
          ...missingPlannedSources(sourcePlan, candidate.nodes)
            .filter((id) => !missingPlannedSources(sourcePlan, best.spec.nodes).includes(id))
            .map((id) => `the tested source of "${id}"`),
        );
        if (lost.length) {
          ctx.log(`round ${round}: candidate removes ${lost.join(", ")} — rejected`, undefined, "warn");
          history.push({
            round,
            score: best.report.score,
            passRate: best.report.passRate,
            accepted: false,
            change: `rejected (removes a named or tested source): ${critique.changes.join("; ")}`,
          });
          continue;
        }
        // Invariant: evolution may not change the meaning of the task to pass a test.
        const intent = await intentKept(ctx, best.spec, t, critique);
        if (!intent.kept) {
          ctx.log(`round ${round}: candidate changes the meaning of the task (p=${intent.p.toFixed(2)}) — rejected`, undefined, "warn");
          artifact(ctx, "intentRejected", { round, p: intent.p, changes: critique.changes });
          history.push({
            round,
            score: best.report.score,
            passRate: best.report.passRate,
            accepted: false,
            change: `rejected (changes the meaning of the task): ${critique.changes.join("; ")}`,
          });
          continue;
        }
        // A "type" check that agrees with the old output shape follows the shape: testgen took it from there.
        const followed = followShape(tests, best.spec, candidate);
        if (followed.changed.length) ctx.log(`round ${round}: ${followed.changed.length} type check(s) follow the new output shape`, followed.changed);
        const next = await evalOnce(candidate, round, followed.tests);
        const accepted = betterReport(next.report, best.report, cfg.thresholds);
        history.push({ round, score: next.report.score, passRate: next.report.passRate, accepted, change: critique.changes.join("; ") });
        if (accepted) {
          if (followed.changed.length) tests = followed.tests;
          best = { spec: { ...candidate, tests }, ...next };
          artifact(ctx, "spec", { stage: "improved", spec: candidate, round });
          // Only a change that improved the score is a lesson.
          await learn([{ kind: "agent_fix", text: critique.lesson?.trim() || critique.diagnosis.slice(0, 400), from: { agentId: candidate.id, runId: ctx.runId } }]);
        } else if (next.report.environmentTests && next.report.environmentTests >= next.report.results.length)
          ctx.log(`round ${round}: the environment (for example a rate limit) stopped all tests of the candidate. It has no score — rejected`, undefined, "warn");
        else ctx.log(`round ${round}: candidate scored ${next.report.score.toFixed(2)} ≤ best ${best.report.score.toFixed(2)} — rejected`);
      } catch (e) {
        if (ctx.signal.aborted) break;
        ctx.log(`round ${round} failed: ${(e as Error).message} — keeping the best version so far`, undefined, "warn");
        history.push({ round, score: best.report.score, passRate: best.report.passRate, accepted: false, change: `round failed: ${(e as Error).message.slice(0, 160)}` });
      }
    }

    const spec: AgentSpec = { ...best.spec, tests, meta: { ...best.spec.meta, evolution: history } };
    artifact(ctx, "evolution", { history, best: { score: best.report.score, passRate: best.report.passRate } });
    return { output: { spec, evaluation: best.report, history } };
  },
};

/** The JSON type that a schema gives for a dot path, or undefined. */
function schemaTypeAt(schema: JSONSchema | undefined, path: string): string | undefined {
  let s: JSONSchema | undefined = schema;
  for (const key of path.split(".")) {
    if (!s) return undefined;
    s = (s.properties as Record<string, JSONSchema> | undefined)?.[key];
  }
  const t = s?.type;
  return typeof t === "string" ? t : undefined;
}

/**
 * Testgen takes "type" checks from the output shape of the agent. When a candidate changes the
 * type of a field in its shape, a check that agreed with the old shape gets the new type. Other checks stay.
 */
export function followShape(tests: TestCase[], before: AgentSpec, after: AgentSpec): { tests: TestCase[]; changed: { test: string; path: string; from: unknown; to: string }[] } {
  const oldShape = agentOutputSchema(before);
  const newShape = agentOutputSchema(after);
  const changed: { test: string; path: string; from: unknown; to: string }[] = [];
  const next = tests.map((t) => ({
    ...t,
    checks: (t.checks ?? []).map((c) => {
      if (c.op !== "type") return c;
      const was = schemaTypeAt(oldShape, c.path);
      const now = schemaTypeAt(newShape, c.path);
      if (!was || !now || was === now || c.value !== was) return c;
      changed.push({ test: t.name, path: c.path, from: c.value, to: now });
      return { ...c, value: now };
    }),
  }));
  return { tests: changed.length ? next : tests, changed };
}

/* =============================== anvil_publish ============================= */

const PublishConfig = z.object({
  spec: z.unknown(),
  evaluation: z.unknown().optional(),
  mode: z.enum(["new", "version", "attach"]).default("new").describe("new agent, new version of an existing agent, or attach the evaluation to the current version"),
  note: z.string().optional(),
  /** true: save a draft version. The current version stays, and a person publishes the draft (docs/HEALTH.md). */
  draft: z.unknown().optional(),
  /** false: do not save. The output gives the spec and the evaluation (a best-of-N candidate, docs/SELECTION.md). */
  save: z.unknown().optional(),
});

export const AnvilPublishNode: NodeClass<z.infer<typeof PublishConfig>> = {
  type: "anvil_publish",
  title: "Publish",
  category: "anvil",
  internal: true,
  defaultTimeoutMs: 0, // meta-steps are bounded by the run policy timeout
  description: "Saves the agent (new agent or new version) with its evaluation; it is immediately runnable in the UI and at POST /api/agents/:id/run.",
  whenToUse: "Last step of a build or refinement.",
  configSchema: PublishConfig,
  example: { spec: "{{nodes.evolve.output.spec}}", evaluation: "{{nodes.evolve.output.evaluation}}" },
  async execute(ctx) {
    const spec = structuredClone(ctx.config.spec as AgentSpec);
    const evaluation = (ctx.config.evaluation ?? undefined) as EvaluationReport | undefined;
    const store = ctx.services.store;
    // A best-of-N candidate is not saved: the selection saves the winner (docs/SELECTION.md).
    if (off(ctx.config.save)) {
      const quality = qualityOf(evaluation);
      artifact(ctx, "published", { agentId: spec.id, name: spec.name, quality, published: false });
      return {
        output: {
          agentId: spec.id,
          version: null,
          name: spec.name,
          score: evaluation?.score ?? null,
          passRate: evaluation?.passRate ?? null,
          quality,
          published: false,
          spec,
          evaluation: evaluation ?? null,
        },
      };
    }
    if (ctx.config.mode === "attach") {
      if (evaluation) await store.attachEvaluation(spec.id, spec.version, evaluation);
      artifact(ctx, "published", { agentId: spec.id, version: spec.version, name: spec.name });
      return { output: { agentId: spec.id, version: spec.version, name: spec.name, score: evaluation?.score ?? null, passRate: evaluation?.passRate ?? null } };
    }
    if (ctx.config.mode === "new") spec.id = store.uniqueId(spec.id);
    // Each agent in the library has a class (docs/LIBRARY.md). A build gives it in the library step. Else it is found here.
    if (!taxonomyOf(spec)) {
      try {
        spec.meta = { ...spec.meta, taxonomy: await classify(ctx.brain, subjectOfSpec(spec), knownDomains(store, ctx.brain.config.library.domains)) };
      } catch (e) {
        ctx.log(`the agent has no class: ${(e as Error).message}`, undefined, "warn");
      }
    }
    const quality = qualityOf(evaluation);
    if (quality === "failed" || quality === "partial") ctx.log(`published with quality "${quality}": ${QUALITY_TEXT[quality]}`, undefined, "warn");
    const draft = ctx.config.mode === "version" && (ctx.config.draft === true || ctx.config.draft === "true");
    const saved = await store.saveVersion(spec, {
      keepCurrent: draft,
      note: `${ctx.config.note ?? (ctx.config.mode === "new" ? "built by Anvil" : "refined by Anvil")}${draft ? " (draft: publish it to use it)" : ""}${quality === "passed" ? "" : ` (${quality})`}`,
      score: evaluation?.score,
      evaluation,
      buildRunId: ctx.runId,
    });
    // A draft is the newest version, and it is not the current version.
    const version = draft ? Math.max(...saved.versions.map((v) => v.version)) : saved.currentVersion;
    artifact(ctx, "published", { agentId: saved.id, version, name: saved.name, quality, ...(draft ? { draft: true } : {}) });
    return {
      output: {
        agentId: saved.id,
        version,
        name: saved.name,
        score: evaluation?.score ?? null,
        passRate: evaluation?.passRate ?? null,
        quality,
        ...(draft ? { draft: true } : {}),
      },
    };
  },
};

/* ================================ anvil_load =============================== */

const LoadConfig = z.object({ agentId: z.string().min(1), version: z.number().int().optional() });

export const AnvilLoadNode: NodeClass<z.infer<typeof LoadConfig>> = {
  type: "anvil_load",
  title: "Load agent",
  category: "anvil",
  internal: true,
  defaultTimeoutMs: 0, // meta-steps are bounded by the run policy timeout
  description: "Loads a saved agent's spec (current or given version) for refinement.",
  whenToUse: "First step of a refinement.",
  configSchema: LoadConfig,
  example: { agentId: "{{input.agentId}}" },
  async execute(ctx) {
    const a = ctx.services.store.getAgent(ctx.config.agentId);
    if (!a) throw new Error(`Agent "${ctx.config.agentId}" not found`);
    if (a.system) throw new Error("System agents cannot be refined");
    const v = ctx.config.version ?? a.currentVersion;
    const spec = a.versions.find((x) => x.version === v)?.spec;
    if (!spec) throw new Error(`Agent "${a.id}" has no version ${v}`);
    artifact(ctx, "spec", { stage: "loaded", spec });
    return { output: { spec, taskSpec: (spec.meta?.taskSpec as TaskSpec) ?? null, tests: spec.tests } };
  },
};

/* ================================ anvil_edit =============================== */

const EditConfig = z.object({ spec: z.unknown(), instruction: z.string().min(1) });

export const AnvilEditNode: NodeClass<z.infer<typeof EditConfig>> = {
  type: "anvil_edit",
  title: "Edit by instruction",
  category: "anvil",
  internal: true,
  defaultTimeoutMs: 0, // meta-steps are bounded by the run policy timeout
  description: "Applies a natural-language change request to an agent as a JSON patch (plus test updates), then recompiles it.",
  whenToUse: "Refinement.",
  configSchema: EditConfig,
  example: { spec: "{{nodes.load.output.spec}}", instruction: "{{input.instruction}}" },
  async execute(ctx) {
    const spec = ctx.config.spec as AgentSpec;
    const reg = ctx.services.registry;
    const locked = spec.nodes.filter((n) => n.locked).map((n) => n.id);
    const lockRule = locked.length ? `\n- Do not change or remove these locked steps: ${locked.join(", ")}. A person owns them. You can add edges to them and from them.` : "";
    // The model sees no canvas positions. The positions of the steps that stay come back after the edit.
    const shown = JSON.stringify({ ...withoutLayout(spec), meta: undefined });
    const out = await ctx.brain.json<{ summary: string; operations: jsonpatch.Operation[]; addTests: Omit<TestCase, "id">[]; removeTestIds: string[] }>({
      purpose: "edit agent",
      tier: "balanced",
      system: `You change Anvil agent specs as a change request tells you. Use RFC 6902 JSON Patch operations. The paths are JSON pointers, for example /nodes/2/config/prompt, /nodes/-, or /edges/-.
- Make all the necessary changes: new nodes, edges, prompts, inputSchema fields, and output fields. Keep all other parts as they are.
- When the behavior changes, also change the test suite. Add tests for the new behavior. Remove the tests that do not apply now.
- Write each new or changed prompt in STE.${lockRule}\n\n${STE_RULES}\n\n${IR_GUIDE}\n\nNODE CATALOG:\n${reg.catalog()}\n\nNODE REFERENCE:\n${nodeDocs(reg, reg.types())}`,
      user: `CURRENT SPEC:\n${shown}\n\nCHANGE REQUEST:\n${ctx.config.instruction}`,
      schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          operations: {
            type: "array",
            items: { type: "object", properties: { op: { type: "string" }, path: { type: "string" }, value: {}, from: { type: "string" } }, required: ["op", "path"] },
          },
          addTests: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, input: { type: "object" }, criteria: { type: "array", items: { type: "string" } }, checks: { type: "array" } },
              required: ["name", "input", "criteria"],
            },
          },
          removeTestIds: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "operations", "addTests", "removeTestIds"],
      },
      maxTokens: 12000,
    });
    let patched: unknown;
    try {
      const r = applyPatchLenient(spec, out.operations);
      if (!r.applied) throw new Error(r.skipped.slice(0, 3).join("; ") || "empty patch");
      if (r.skipped.length) ctx.log(`edit patch: ${r.applied} ops applied, ${r.skipped.length} skipped`, r.skipped, "warn");
      patched = r.doc;
    } catch (e) {
      ctx.log(`patch failed (${(e as Error).message}); asking for a full rewrite`, undefined, "warn");
      patched = await ctx.brain.json({
        purpose: "edit agent (rewrite)",
        tier: "balanced",
        system: `Return the COMPLETE modified Anvil agent spec JSON.${lockRule}\n\n${IR_GUIDE}\n\nNODE REFERENCE:\n${nodeDocs(reg, reg.types())}`,
        user: `CURRENT SPEC:\n${shown}\n\nCHANGE REQUEST:\n${ctx.config.instruction}`,
        maxTokens: 16000,
      });
    }
    // A locked step comes back as it was, before the compiler checks the result (docs/WORKFLOW_EDITOR.md).
    if (locked.length && patched && typeof patched === "object" && Array.isArray((patched as AgentSpec).nodes)) {
      const hit = lockedViolations(spec, patched as AgentSpec);
      if (hit.length) ctx.log(`the change touched locked step(s) ${hit.join(", ")}: they stay as they were`, undefined, "warn");
      patched = restoreLocked(spec, patched as AgentSpec);
    }
    artifact(ctx, "spec", { stage: "draft", spec: patched });
    const outcome = await validateAndRepair(patched, {
      brain: ctx.brain,
      registry: reg,
      getAgent: (id) => ctx.services.store.getAgent(id),
      maxAttempts: ctx.brain.config.repairMaxAttempts,
      context: `Change request: ${ctx.config.instruction}`,
      request: spec.meta?.request as string | undefined,
      sourcePlan: (spec.meta?.plan as { sourcePlan?: SourcePlan } | undefined)?.sourcePlan,
      onStep: (s) => {
        artifact(ctx, "validation", {
          attempt: s.attempt,
          strategy: s.strategy,
          errors: s.result.errors,
          warnings: s.result.warnings,
          diagnostics: s.result.diagnostics,
          fixes: s.fixes,
        });
        if (s.attempt > 0) artifact(ctx, "spec", { stage: "repaired", spec: s.spec, attempt: s.attempt });
      },
    });
    if (!outcome.spec) throw new Error(`Edited spec does not compile:\n${formatDiagnostics(outcome.result.diagnostics)}`);
    const lockedHit = lockedViolations(spec, outcome.spec);
    if (lockedHit.length) throw new Error(`The change needs a change of the locked step(s) ${lockedHit.join(", ")}. Unlock them in the workflow editor, or give another instruction.`);
    const kept = (spec.tests ?? []).filter((x) => !out.removeTestIds.includes(x.id));
    const added: TestCase[] = out.addTests.map((x, i) => ({
      id: `t${kept.length + i + 1}_${Date.now().toString(36).slice(-3)}`,
      name: x.name,
      input: x.input,
      criteria: x.criteria ?? [],
      checks: (x.checks as TestCase["checks"]) ?? [],
    }));
    const tests = [...kept, ...added].filter((x) => !schemaErrors(outcome.spec!.inputSchema, x.input).length);
    const before = new Set((spec.triggers ?? []).map((tr) => tr.id));
    const next: AgentSpec = {
      ...carryLayout(spec, outcome.spec),
      id: spec.id,
      tests,
      // The refiner keeps the definition of done when the model does not give a new one.
      acceptance: outcome.spec.acceptance?.length ? outcome.spec.acceptance : spec.acceptance,
      // Newly added triggers start disabled; existing ones keep their setting.
      triggers: outcome.spec.triggers?.map((tr) => (before.has(tr.id) ? tr : { ...tr, enabled: false })),
      meta: { ...spec.meta, refinements: [...((spec.meta?.refinements as unknown[]) ?? []), { at: Date.now(), instruction: ctx.config.instruction, summary: out.summary }] },
    };
    artifact(ctx, "spec", { stage: "compiled", spec: next });
    artifact(ctx, "tests", { tests });
    return { output: { spec: next, tests, summary: out.summary } };
  },
};

/* ============================== anvil_classgen ============================= */

const ClassgenConfig = z.object({
  plan: z.unknown().optional().describe("Architect plan; its newClasses are generated"),
  taskSpec: z.unknown().optional(),
  request: z.string().optional().describe("Standalone mode: a plain-language description of one class to create"),
  maxAttempts: z.number().int().min(1).max(5).default(3),
});

interface ClassgenResult {
  type: string;
  ok: boolean;
  reused?: boolean;
  status?: string;
  approved?: boolean;
  kind?: string;
  secrets?: string[];
  error?: string;
  attempts: number;
}

export async function generateClass(
  ctx: NodeContext<any>,
  want: { type?: string; kind?: string; purpose: string; service?: string },
  context: string,
  maxAttempts: number,
): Promise<{ result: ClassgenResult; def?: CustomClassDef }> {
  const svc = ctx.services.classes;
  if (!svc) throw new Error("class service unavailable");
  const reg = ctx.services.registry;
  const existing = svc
    .list()
    .slice(0, 8)
    .map((c) => ({ type: c.type, kind: c.impl.kind, description: c.description }));
  const history: { role: "assistant" | "user"; content: string }[] = [];
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const def = await ctx.brain.json<CustomClassDef>({
      purpose: `generate class ${want.type ?? ""} (attempt ${attempt})`.replace("  ", " "),
      tier: "balanced",
      system: `You design reusable node classes for Anvil, an agent-building system. A class must be general (its config sets its parameters), correct, and safe.\n\n${CLASS_GUIDE}\n\n${STE_RULES}\n\nEXISTING CUSTOM CLASSES (do not duplicate):\n${JSON.stringify(existing)}`,
      user: `${context ? `CONTEXT:\n${context}\n\n` : ""}CREATE THIS CLASS:\n${JSON.stringify(want)}${want.type ? `\nUse type "${want.type}".` : ""}\nReturn the complete class definition JSON.`,
      history,
      maxTokens: 6000,
      check: (d) =>
        validateClassDef({ ...d, createdBy: "anvil" }, reg)
          .diagnostics.filter((x) => x.severity === "error")
          .map((x) => `${x.path ?? ""} ${x.message}${x.hint ? ` (${x.hint})` : ""}`),
    });
    const saved = await svc.save(def, { brain: ctx.brain, test: true, createdBy: "anvil" });
    if (!saved.def) {
      lastError = saved.diagnostics.map((d) => d.message).join("; ");
      history.push({ role: "assistant", content: JSON.stringify(def).slice(0, 8000) }, { role: "user", content: `That definition was rejected: ${lastError}. Fix it.` });
      continue;
    }
    const d = saved.def;
    artifact(ctx, "class", { def: d, attempt, diagnostics: saved.diagnostics });
    ctx.log(`class ${d.type} (${d.impl.kind}) saved — tests ${d.status}`);
    if (d.status !== "failed") {
      return { def: d, result: { type: d.type, ok: true, status: d.status, approved: d.approved, kind: d.impl.kind, secrets: d.secrets, attempts: attempt } };
    }
    lastError = d.testReport
      .filter((r) => !r.passed)
      .map((r) => `${r.name}: ${r.error ?? JSON.stringify(r.checks.filter((c) => !(c as { passed: boolean }).passed))} — output: ${JSON.stringify(r.output ?? null).slice(0, 600)}`)
      .join("\n");
    history.push(
      { role: "assistant", content: JSON.stringify({ ...def, testReport: undefined }).slice(0, 8000) },
      {
        role: "user",
        content: `The class was executed for real and its tests FAILED:\n${lastError}\nFix the implementation (URL/params/transform/prompt) or the unrealistic checks, and return the full corrected definition.`,
      },
    );
  }
  return { result: { type: want.type ?? "(unnamed)", ok: false, error: lastError, attempts: maxAttempts } };
}

export const AnvilClassgenNode: NodeClass<z.infer<typeof ClassgenConfig>> = {
  type: "anvil_classgen",
  title: "Generate classes",
  category: "anvil",
  internal: true,
  defaultTimeoutMs: 0,
  description:
    "Extends the node library at runtime: writes a custom class (http | code | llm) for every capability the plan lacks, validates it, executes its tests for real, repairs it from the failures, then registers it so the composer can use it.",
  whenToUse: "Between architect and compose.",
  configSchema: ClassgenConfig,
  example: { plan: "{{nodes.architect.output.plan}}" },
  async execute(ctx) {
    const c = ctx.config;
    const t = c.taskSpec as TaskSpec | undefined;
    const context = t ? `Agent being built: ${t.name} — ${t.goal}` : "";

    if (c.request) {
      const { result } = await generateClass(ctx, { purpose: c.request }, "", c.maxAttempts);
      artifact(ctx, "classes", { results: [result] });
      if (!result.ok) throw new Error(`Could not create a working class: ${result.error}`);
      return { output: { classes: [result] } };
    }

    const plan = structuredClone((c.plan ?? { steps: [] }) as Plan);
    const wanted = plan.newClasses ?? [];
    const results: ClassgenResult[] = [];
    for (const w of wanted) {
      const cls = ctx.services.registry.get(w.type);
      if (cls?.custom) {
        results.push({ type: w.type, ok: true, reused: true, status: cls.custom.status, approved: cls.custom.approved, kind: cls.custom.kind, attempts: 0 });
        continue;
      }
      try {
        results.push((await generateClass(ctx, w, context, c.maxAttempts)).result);
      } catch (e) {
        results.push({ type: w.type, ok: false, error: (e as Error).message, attempts: 0 });
      }
    }
    // Steps whose class could not be created fall back to generic nodes.
    for (const r of results.filter((x) => !x.ok)) {
      for (const s of plan.steps.filter((x) => x.type === r.type)) {
        const w = wanted.find((x) => x.type === r.type);
        s.type = w?.kind === "llm" ? "llm_structured" : w?.kind === "code" ? "code" : "http";
        s.purpose = `${s.purpose} (custom class ${r.type} could not be generated — implement directly)`;
      }
      ctx.log(`class ${r.type} failed — falling back to a generic node`, r.error, "warn");
    }
    plan.newClasses = wanted.filter((w) => results.find((r) => r.type === w.type)?.ok);
    if (wanted.length) artifact(ctx, "classes", { results });
    return { output: { classes: results, plan } };
  },
};

export const ANVIL_NODE_CLASSES = [
  AnvilClassgenNode,
  AnvilTriageNode,
  AnvilAnalyzeNode,
  AnvilArchitectNode,
  AnvilComposeNode,
  AnvilTestgenNode,
  AnvilEvolveNode,
  AnvilPublishNode,
  AnvilLoadNode,
  AnvilEditNode,
];
