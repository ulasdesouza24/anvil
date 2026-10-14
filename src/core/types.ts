import { z } from "zod";

/**
 * Anvil Agent IR ("anvil/v1").
 *
 * An agent is a typed, versioned JSON document: a DAG of node instances whose
 * classes live in the registry. Edges carry control flow (with named ports for
 * branching); data flows through `{{ template }}` references to upstream nodes.
 */

export const NODE_ID = /^[a-z][a-z0-9_]{0,47}$/;

export type JSONSchema = {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  enum?: unknown[];
  description?: string;
  additionalProperties?: boolean | JSONSchema;
  [k: string]: unknown;
};

export const JSONSchemaZ: z.ZodType<JSONSchema> = z.record(z.string(), z.unknown()) as never;

export const RetryZ = z.object({
  maxAttempts: z.number().int().min(1).max(5).default(1),
  backoffMs: z.number().int().min(0).max(30_000).default(500),
});

export const NodeInstanceZ = z.object({
  id: z.string().regex(NODE_ID, "node id must be snake_case, start with a letter, max 48 chars"),
  type: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  retry: RetryZ.partial().optional(),
  timeoutMs: z.number().int().positive().max(900_000).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  /** The step does not run (docs/WORKFLOW_EDITOR.md). Only its "out" edges stay active, and its output is empty. */
  disabled: z.boolean().optional(),
  /** A note of a person for this step. The engine and the builder do not read it. */
  notes: z.string().optional(),
  /** The builder (edit, evolve) does not change or remove this step. A person changes it in the workflow editor. */
  locked: z.boolean().optional(),
});
export type NodeInstance = z.infer<typeof NodeInstanceZ>;

export const EdgeZ = z.object({
  id: z.string().optional(),
  from: z.string(),
  to: z.string(),
  /** Output port of `from`. Defaults to "out". Branching nodes expose named ports. */
  port: z.string().optional(),
});
export type Edge = z.infer<typeof EdgeZ>;

export const CheckZ = z.object({
  path: z.string().describe("dot path into the agent output, e.g. 'summary' or 'items[0].title'"),
  op: z.enum(["exists", "equals", "contains", "matches", "type", "minLength", "maxLength"]),
  value: z.unknown().optional(),
});
export type Check = z.infer<typeof CheckZ>;

export const TestCaseZ = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  /** Natural-language assertions judged by the decision model. */
  criteria: z.array(z.string()).default([]),
  /** Deterministic assertions on the output. */
  checks: z.array(CheckZ).default([]),
  /**
   * For a conversation agent: a simulated user talks to the agent. The model
   * plays the persona, starts with firstMessage, and stops at the goal or after
   * maxTurns. The criteria then judge the full transcript.
   */
  conversation: z
    .object({
      persona: z.string(),
      goal: z.string(),
      /** Empty: the simulated user writes the first message from the goal. */
      firstMessage: z.string().default(""),
      /** Facts that the user knows and gives when the agent asks (an order id, a name). */
      facts: z.record(z.string(), z.unknown()).default({}),
      maxTurns: z.number().int().min(1).max(20).default(6),
    })
    .optional(),
});
export type TestCase = z.infer<typeof TestCaseZ>;

/** One rule of the definition of done. A check is deterministic. A judge rule is a yes/no question for Jev. */
export const AcceptanceRuleZ = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("check"), check: CheckZ }),
  z.object({ id: z.string(), kind: z.literal("judge"), criterion: z.string().min(5) }),
]);
export type AcceptanceRule = z.infer<typeof AcceptanceRuleZ>;

export const PolicyZ = z.object({
  maxCostUsd: z.number().positive().max(50).default(0.5),
  maxNodeExecutions: z.number().int().positive().max(5000).default(500),
  timeoutMs: z.number().int().positive().max(3_600_000).default(600_000),
  requireApprovalForSideEffects: z.boolean().default(false),
  /** Paid web searches for one run. When not set, the config value applies. */
  maxPaidSearches: z.number().int().min(0).max(500).optional(),
  /** The harness: try, check, fix, try again. It is on when the spec has acceptance rules. */
  harness: z.object({ enabled: z.boolean().optional(), maxAttempts: z.number().int().min(1).max(8).optional() }).optional(),
  /** The Python sandbox: the domains that a person approves for programs, and the time limit for all programs of one run. */
  sandbox: z.object({ allowDomains: z.array(z.string()).optional(), maxSeconds: z.number().positive().max(3600).optional() }).optional(),
});
export type Policy = z.infer<typeof PolicyZ>;

/* ------------------------------------------------------------------ */
/* Triggers — how an agent runs on its own                             */
/* ------------------------------------------------------------------ */

const TriggerBase = {
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "trigger id must be snake_case"),
  description: z.string().optional(),
  /** Default on/off state; the runtime can override it (the UI toggle). */
  enabled: z.boolean().default(true),
  /**
   * Maps the trigger event to the agent input. Templates can use {{trigger.*}}
   * plus the event roots of each type (payload/headers/query, item, output).
   * Omitted: the natural event object is passed as input.
   */
  input: z.unknown().optional(),
};

export const TriggerZ = z.discriminatedUnion("type", [
  z.object({
    ...TriggerBase,
    type: z.literal("schedule"),
    /** 5-field cron ("0 9 * * 1-5"), evaluated in `timezone`. */
    cron: z.string().optional(),
    /** Fixed interval: "30s", "15m", "2h", "1d". */
    every: z.string().optional(),
    timezone: z.string().optional().describe('IANA timezone, e.g. "Europe/Istanbul"; defaults to the server timezone'),
  }),
  z.object({
    ...TriggerBase,
    type: z.literal("webhook"),
    /** Respond with the agent output (synchronous) instead of just accepting the event. */
    respond: z.boolean().default(false),
  }),
  z.object({
    ...TriggerBase,
    type: z.literal("poll"),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("rss"), url: z.string().url() }),
      z.object({ kind: z.literal("json"), url: z.string().url(), itemsPath: z.string().default(""), idPath: z.string().default("id") }),
      z.object({ kind: z.literal("page"), url: z.string().url() }),
    ]),
    every: z.string().default("15m"),
    /** On the first check, treat existing items as already seen (no flood). */
    skipExisting: z.boolean().default(true),
    maxPerCheck: z.number().int().min(1).max(50).default(5),
  }),
  z.object({
    ...TriggerBase,
    type: z.literal("agent"),
    /** Run when this other agent finishes. */
    agentId: z.string(),
    on: z.enum(["completed", "failed", "any"]).default("completed"),
  }),
]);
export type Trigger = z.infer<typeof TriggerZ>;

export const AgentSpecZ = z.object({
  specVersion: z.literal("anvil/v1").default("anvil/v1"),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "agent id must be kebab-case"),
  name: z.string().min(1),
  description: z.string().default(""),
  version: z.number().int().min(1).default(1),
  inputSchema: JSONSchemaZ.default({ type: "object", properties: {} }),
  outputSchema: JSONSchemaZ.optional(),
  nodes: z.array(NodeInstanceZ).min(1),
  edges: z.array(EdgeZ).default([]),
  policy: PolicyZ.default({
    maxCostUsd: 0.5,
    maxNodeExecutions: 500,
    timeoutMs: 600_000,
    requireApprovalForSideEffects: false,
  }),
  tests: z.array(TestCaseZ).default([]),
  triggers: z.array(TriggerZ).optional(),
  /** The definition of done. The harness checks each attempt against these rules. */
  acceptance: z.array(AcceptanceRuleZ).optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type AgentSpec = z.infer<typeof AgentSpecZ>;

/** The layout data of the workflow editor in spec.meta.canvas. The engine does not read it. */
export interface StickyNote {
  id: string;
  text: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  color?: string;
}

export interface CanvasMeta {
  notes?: StickyNote[];
  viewport?: { x: number; y: number; zoom: number };
}

/* ------------------------------------------------------------------ */
/* Diagnostics                                                         */
/* ------------------------------------------------------------------ */

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  /** JSON pointer into the spec, e.g. /nodes/2/config/prompt */
  path?: string;
  nodeId?: string;
  hint?: string;
}

/* ------------------------------------------------------------------ */
/* Usage                                                               */
/* ------------------------------------------------------------------ */

export interface Usage {
  llmCalls: number;
  decisionCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** The time that programs of the run used in the Python sandbox. */
  sandboxMs?: number;
}

export const emptyUsage = (): Usage => ({
  llmCalls: 0,
  decisionCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
});

export function addUsage(into: Usage, u: Partial<Usage>): Usage {
  into.llmCalls += u.llmCalls ?? 0;
  into.decisionCalls += u.decisionCalls ?? 0;
  into.inputTokens += u.inputTokens ?? 0;
  into.outputTokens += u.outputTokens ?? 0;
  into.costUsd += u.costUsd ?? 0;
  if (u.sandboxMs) into.sandboxMs = (into.sandboxMs ?? 0) + u.sandboxMs;
  return into;
}

/* ------------------------------------------------------------------ */
/* Decisions (Jev / System One)                                        */
/* ------------------------------------------------------------------ */

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } };

export type Answer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | {
      type: "score";
      score: number;
      confidence: number;
      probabilities: Record<string, number>;
      legend?: Record<string, string>;
    }
  | { type: "noul"; noul: number };

/* ------------------------------------------------------------------ */
/* Runs & events                                                       */
/* ------------------------------------------------------------------ */

export type NodeStatus = "pending" | "running" | "waiting" | "done" | "skipped" | "failed";
export type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface HumanRequest {
  kind: "approval" | "input";
  title: string;
  message?: string;
  /** For kind=input: the questions to answer. */
  questions?: string[];
  /** Arbitrary payload to show (e.g. the draft being approved). */
  payload?: unknown;
}

export type RunEvent =
  | { type: "run.started"; t: number; runId: string; agentId: string; version: number; input: unknown }
  | { type: "node.started"; t: number; nodeId: string; attempt: number; config?: unknown }
  | { type: "node.completed"; t: number; nodeId: string; output: unknown; ports: string[]; usage: Usage; durationMs: number }
  | { type: "node.skipped"; t: number; nodeId: string; reason: string }
  | { type: "node.failed"; t: number; nodeId: string; error: string; attempt: number; willRetry: boolean }
  | { type: "node.waiting"; t: number; nodeId: string; request: HumanRequest }
  | { type: "node.resumed"; t: number; nodeId: string; value: unknown }
  | { type: "log"; t: number; nodeId?: string; level: "info" | "warn" | "error"; message: string; data?: unknown }
  /** The cost of the nested runs since the last such event (docs/RUNS.md): the counters of a run grow while its children work. */
  | { type: "usage"; t: number; usage: Usage }
  | {
      type: "llm";
      t: number;
      nodeId?: string;
      purpose: string;
      model: string;
      tier?: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      latencyMs: number;
      /** Input tokens read from the prompt cache of the provider. */
      cachedTokens?: number;
    }
  | {
      type: "decision";
      t: number;
      nodeId?: string;
      purpose: string;
      questions: Record<string, Question>;
      answers: Record<string, Answer>;
      costUsd: number;
      latencyMs: number;
      escalated?: boolean;
    }
  | { type: "artifact"; t: number; nodeId?: string; kind: string; data: unknown }
  | { type: "run.completed"; t: number; output: unknown; usage: Usage; durationMs: number }
  | { type: "run.failed"; t: number; error: string; usage: Usage; durationMs: number }
  | { type: "run.cancelled"; t: number };

export type RunEventInput = RunEvent extends infer E ? (E extends { t: number } ? Omit<E, "t"> : never) : never;

export type FailureClass =
  "no_data" | "source_blocked" | "rate_limited" | "bad_format" | "tool_error" | "timeout" | "wrong_reasoning" | "input_problem" | "valid_empty" | "rule_violation" | "rule_refusal";

export interface HarnessSummary {
  status: "accepted" | "partial" | "off";
  attempts: number;
  strategies: string[];
  failureClass?: FailureClass;
  gaps: string[];
  /** The ids of the acceptance rules that the last attempt did not meet. */
  unmetRules?: string[];
  reason?: string;
}

export interface RunRecord {
  /** The process that runs it. Another process (the server next to the CLI) does not mark a run of a live process as interrupted. */
  pid?: number;
  id: string;
  agentId: string;
  agentName: string;
  version: number;
  kind: "run" | "build" | "refine" | "eval" | "trigger";
  /** Set when a person started the run from the workflow editor (docs/WORKFLOW_EDITOR.md). */
  origin?: "editor";
  /** The run did no action with a side effect: each action gave a preview (docs/WORKFLOW_EDITOR.md). */
  dryRun?: boolean;
  /** For a partial run of the editor: the step where the run stops. */
  targetNodeId?: string;
  /**
   * Only for a run of the workflow editor: the full output and the ports of each finished step (secrets redacted).
   * The editor shows this data, and "execute step" uses it again for the steps before the step.
   */
  stepData?: Record<string, { output: unknown; ports: string[] }>;
  /** For kind=trigger: which trigger fired and why. */
  trigger?: { agentId: string; triggerId: string; type: Trigger["type"]; chainDepth?: number; event?: string };
  parentRunId?: string;
  status: RunStatus;
  input: unknown;
  output?: unknown;
  error?: string;
  startedAt: number;
  endedAt?: number;
  usage: Usage;
  nodeStates: Record<string, NodeStatus>;
  events: RunEvent[];
  /** For builds: the agent that was produced. */
  resultAgentId?: string;
  /** What the harness did in this run. */
  harness?: HarnessSummary;
  /**
   * Only while the run waits for a person (docs/RECOVERY.md): the full output and the ports of each finished step.
   * After a restart, the server runs the agent again and replays these steps, so no action runs two times.
   */
  checkpoint?: { nodes: Record<string, { output: unknown; ports: string[] }> };
}

/* ------------------------------------------------------------------ */
/* Stored agents                                                       */
/* ------------------------------------------------------------------ */

export interface AgentVersion {
  version: number;
  spec: AgentSpec;
  createdAt: number;
  note: string;
  score?: number;
  evaluation?: EvaluationReport;
  buildRunId?: string;
}

/**
 * The class of an agent in the library (docs/LIBRARY.md). It is in spec.meta.taxonomy.
 * A new build takes the best agents of the same class as examples.
 */
export interface Taxonomy {
  /** The architecture pattern, for example pipeline or classify_route. */
  pattern: string;
  /** The subject area, for example currency_exchange. The list is open: a build can add a domain. */
  domain: string;
  /** Where the data of the agent comes from. */
  sourceKind: "api" | "web_page" | "document" | "input_only" | "mixed";
  /** What the agent gives. */
  outputKind: "table" | "report" | "decision" | "message" | "data";
}

/** One lesson of a domain: what a build learned, for the next builds of the same domain. */
export interface Lesson {
  id: string;
  domain: string;
  pattern: string;
  kind: "agent_fix" | "test_problem" | "source_ok" | "source_blocked";
  text: string;
  /** A URL or a class type, for the source lessons. */
  source?: string;
  /** How many builds found this lesson. */
  count: number;
  firstAt: number;
  lastAt: number;
  /** The build or the agent that found it last. */
  from?: { agentId?: string; runId?: string };
}

export interface StoredAgent {
  id: string;
  name: string;
  description: string;
  system?: boolean;
  createdAt: number;
  updatedAt: number;
  currentVersion: number;
  versions: AgentVersion[];
}

export interface CriterionResult {
  criterion: string;
  probability: number;
  passed: boolean;
}

export interface CheckResult {
  check: Check;
  passed: boolean;
  actual?: unknown;
}

/**
 * Who is wrong when a test item fails: the agent, or the test. A test can be
 * wrong when it expects exact live values, contradicts the task, needs
 * outside knowledge, or expects a waiting state in an unattended test.
 */
export type FailureBlame = "agent" | "test_live_value" | "test_contradicts" | "test_outside" | "test_unattended" | "unclear";

export interface FailureDiagnosis {
  kind: "criterion" | "check";
  /** The criterion text, or the check as "path op value". */
  item: string;
  blame: FailureBlame;
  confidence: number;
  /** Set when Jev was not sure and the reasoning model gave a second opinion. */
  secondOpinion?: FailureBlame;
  reason?: string;
  /** The two opinions do not agree. A person must decide: evolve neither removes the item nor fixes the agent for it. */
  disputed?: boolean;
}

export interface TestResult {
  testId: string;
  name: string;
  passed: boolean;
  /** Set when the test did not run, with the reason. */
  skipped?: string;
  /** The STE score of the prose in the output. */
  ste?: { per100w: number; words: number; language: "en" | "other" };
  /** Set when the harness stopped with a partial result. */
  partial?: boolean;
  failureClass?: FailureClass;
  /** For a partial result: the ids of the acceptance rules of the agent that the output did not meet. */
  unmetRules?: string[];
  /**
   * Set when the test failed because of the environment (for example the rate limit of a source), with the evidence.
   * The test has no score, and the pass rate does not count it.
   */
  environment?: string;
  score: number;
  /** pass^k (docs/SELECTION.md): the runs of the test, and the runs that passed. "passed" is true only when every run passed. */
  runs?: number;
  passes?: number;
  output?: unknown;
  error?: string;
  criteria: CriterionResult[];
  checks: CheckResult[];
  /** For a failed test: who is wrong for each failed item. */
  diagnosis?: FailureDiagnosis[];
  runId?: string;
  costUsd: number;
  durationMs: number;
}

export interface EvaluationReport {
  version: number;
  /** The share of the tests that passed. With repeats, a test passes only when every run passed (pass^k). */
  passRate: number;
  /** With repeats: the share of the tests with at least one run that passed. */
  passAny?: number;
  /** The runs of each test (pass^k). */
  repeats?: number;
  score: number;
  results: TestResult[];
  costUsd: number;
  /** Tests that did not run (smoke test failed, or the budget was used). */
  skippedTests?: number;
  /** Tests that failed because of the environment (for example a rate limit). They have no score. */
  environmentTests?: number;
  /** The mean STE score of the prose in the outputs (violations for each 100 words). Lower is better. */
  stePer100w?: number;
  /** Failed items that the diagnosis gives to the agent, and to the tests. */
  agentProblems?: number;
  testProblems?: number;
  /** Failed items where the two opinions do not agree. A person must decide. */
  disputedProblems?: number;
  at: number;
}

/** The output fields that can hold the reply of a conversation turn, in order (docs/CONVERSATIONS.md). */
export const REPLY_FIELDS = ["reply", "answer", "message", "text"] as const;
