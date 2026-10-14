import type { AnvilConfig } from "./config.js";

/**
 * The settings that a user can change (docs/HOSTING.md). Each field is a path into AnvilConfig. A user setting
 * replaces the server value for the workspace of that user only. The System 1 model (Jev) is fixed: it is not here.
 * Server values (the port, the data folder, the sandbox, the browser, the webhooks) are not user settings.
 */

export type SettingType = "number" | "integer" | "boolean" | "enum" | "text" | "list";

export interface SettingField {
  path: string;
  group: string;
  label: string;
  help: string;
  type: SettingType;
  min?: number;
  max?: number;
  step?: number;
  /** For enum, and for each item of a list with fixed values. */
  options?: string[];
  /** Shown next to a number: ms, USD, tokens, chars. */
  unit?: string;
}

export const SETTING_GROUPS = [
  "Models",
  "Best-of-N",
  "Build and evolve",
  "System 1 decisions",
  "Runs",
  "Model requests",
  "Context",
  "Data sources",
  "Library",
  "Health checks",
] as const;

const M = "Models";
const B = "Best-of-N";
const E = "Build and evolve";
const D = "System 1 decisions";
const R = "Runs";
const Q = "Model requests";
const C = "Context";
const S = "Data sources";
const L = "Library";
const H = "Health checks";

const REASONING = ["minimal", "low", "medium", "high"];
const prob = (path: string, label: string, help: string, group = D): SettingField => ({ path, group, label, help, type: "number", min: 0, max: 1, step: 0.01 });

const tier = (t: "fast" | "balanced" | "deep", what: string): SettingField[] => [
  { path: `tiers.${t}.model`, group: M, label: `${t} tier: model`, help: `The OpenRouter model for ${what}. Empty: the System 2 model.`, type: "text" },
  { path: `tiers.${t}.reasoning`, group: M, label: `${t} tier: reasoning`, help: `The reasoning effort for ${what}.`, type: "enum", options: REASONING },
  {
    path: `tiers.${t}.maxTokens`,
    group: M,
    label: `${t} tier: max tokens`,
    help: `The token budget of one answer for ${what}.`,
    type: "integer",
    min: 256,
    max: 64000,
    unit: "tokens",
  },
];

export const SETTING_FIELDS: SettingField[] = [
  /* Models */
  { path: "llmModel", group: M, label: "System 2 model", help: "The OpenRouter model for reasoning, writing, and building (for example z-ai/glm-5.3-flash).", type: "text" },
  ...tier("fast", "short steps"),
  ...tier("balanced", "most steps"),
  ...tier("deep", "the hardest steps (the critic, the architect)"),
  {
    path: "providerSort",
    group: M,
    label: "Provider order",
    help: "How OpenRouter selects a provider for a chat call.",
    type: "enum",
    options: ["throughput", "latency", "price", "none"],
  },

  /* Best-of-N */
  {
    path: "bestOf.enabled",
    group: B,
    label: "Best-of-N for each build",
    help: "Each build makes one candidate for each builder model and keeps the best tested one. It costs more.",
    type: "boolean",
  },
  { path: "bestOf.models", group: B, label: "Builder models", help: "One candidate for each model (OpenRouter model ids).", type: "list" },
  { path: "bestOf.judgeModel", group: B, label: "Judge model", help: "The model that decides between candidates with close scores.", type: "text" },
  { path: "bestOf.margin", group: B, label: "Win margin", help: "A lead larger than this score wins without the judge.", type: "number", min: 0, max: 1, step: 0.01 },
  {
    path: "bestOf.maxTests",
    group: B,
    label: "Shared tests",
    help: "The most tests in the suite that all candidates run. Given tests always stay.",
    type: "integer",
    min: 1,
    max: 50,
  },
  {
    path: "bestOf.candidateTimeoutMs",
    group: B,
    label: "Candidate time limit",
    help: "A candidate that takes longer is out.",
    type: "integer",
    min: 60_000,
    max: 3_600_000,
    unit: "ms",
  },
  {
    path: "bestOf.candidateGraceMs",
    group: B,
    label: "Grace time",
    help: "When two candidates are ready, the others get this much more time.",
    type: "integer",
    min: 0,
    max: 1_800_000,
    unit: "ms",
  },
  {
    path: "bestOf.givenWeight",
    group: B,
    label: "Given test weight",
    help: "The weight of a given test in the selection. A generated test has the weight 1.",
    type: "number",
    min: 1,
    max: 10,
    step: 0.5,
  },
  {
    path: "selectRepeats",
    group: B,
    label: "Runs of each test (pass^k)",
    help: "In the selection, a test passes only when each of its runs passes.",
    type: "integer",
    min: 1,
    max: 5,
  },

  /* Build and evolve */
  { path: "evolveTarget", group: E, label: "Target pass rate", help: "Evolve stops when the tests reach this pass rate.", type: "number", min: 0, max: 1, step: 0.01 },
  { path: "evolveMaxRounds", group: E, label: "Evolve rounds", help: "The most evolve rounds for one build.", type: "integer", min: 0, max: 10 },
  { path: "evolveMaxRejected", group: E, label: "Rejected rounds before a stop", help: "Evolve stops after this many rejected rounds in a row.", type: "integer", min: 1, max: 10 },
  {
    path: "repairMaxAttempts",
    group: E,
    label: "Compiler repair attempts",
    help: "How many times the model fixes a draft that does not compile.",
    type: "integer",
    min: 1,
    max: 10,
  },
  {
    path: "composeRetries",
    group: E,
    label: "New drafts",
    help: "When the repair loop cannot fix a draft, compose writes a new draft this many times.",
    type: "integer",
    min: 0,
    max: 5,
  },
  {
    path: "sourceRetryRounds",
    group: E,
    label: "Source retry rounds",
    help: "When no source gives the data of a need, the model proposes new sources this many times.",
    type: "integer",
    min: 0,
    max: 5,
  },
  {
    path: "evalRepeats",
    group: E,
    label: "Runs of each test in evolve",
    help: "pass^k in evolve: a test passes only when each of its runs passes.",
    type: "integer",
    min: 1,
    max: 5,
  },
  { path: "evalSmokeFirst", group: E, label: "Smoke test first", help: "Run the first test alone, and run the others only when it passes.", type: "boolean" },
  {
    path: "evalSmokeMinScore",
    group: E,
    label: "Smoke test minimum score",
    help: "The other tests do not run when the smoke test scores below this value.",
    type: "number",
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    path: "evalBudgetUsd",
    group: E,
    label: "Evaluation budget",
    help: "The most money for the tests of one build or evolve run.",
    type: "number",
    min: 0.01,
    max: 20,
    step: 0.05,
    unit: "USD",
  },
  {
    path: "buildConfirmUsd",
    group: E,
    label: "Ask above this estimate",
    help: "A build asks you first when its high estimate is above this value.",
    type: "number",
    min: 0,
    max: 50,
    step: 0.1,
    unit: "USD",
  },
  {
    path: "criticEvidenceChars",
    group: E,
    label: "Critic evidence",
    help: "The most characters of test evidence in one critic prompt.",
    type: "integer",
    min: 2000,
    max: 100_000,
    unit: "chars",
  },
  {
    path: "unattended",
    group: E,
    label: "Unattended mode",
    help: "Runs approve their approval steps and skip their questions at once. The builder asks no questions.",
    type: "boolean",
  },
  {
    path: "rules.maxAcceptance",
    group: E,
    label: "Most acceptance rules",
    help: "The most rules from a policy in the definition of done of one agent.",
    type: "integer",
    min: 1,
    max: 20,
  },
  { path: "rules.maxTests", group: E, label: "Tests for each rule", help: "The most tests that try to break one rule.", type: "integer", min: 0, max: 10 },
  { path: "steMaxPer100w", group: E, label: "STE limit", help: "The most STE violations in 100 words of a prompt.", type: "number", min: 0, max: 20, step: 0.5 },
  {
    path: "stePrompts",
    group: E,
    label: "STE for prompts",
    help: "error: the repair loop rewrites a prompt that is not in STE. warning: only a note. off: no check.",
    type: "enum",
    options: ["error", "warning", "off"],
  },

  /* System 1 decisions */
  prob("confidenceThreshold", "Escalation confidence", "A Jev answer below this confidence goes to System 2."),
  prob("thresholds.criterionPass", "Criterion pass", "The minimum probability for a test criterion to pass."),
  prob("thresholds.acceptanceJudge", "Acceptance judge", "The minimum probability for a judge rule of the definition of done."),
  prob("thresholds.actionGate", "Action gate", "An action with a lower probability for its confirmation or its rules is blocked."),
  prob("thresholds.diagnosisConfidence", "Diagnosis confidence", "Below this confidence, a failure diagnosis gets a second opinion."),
  prob("thresholds.intentKeep", "Intent kept", "The minimum probability that a candidate keeps the meaning of the request."),
  prob("thresholds.sourceRelevance", "Source relevance", "The minimum relevance of a data source sample."),
  prob("thresholds.libraryMatch", "Library class match", "The minimum probability that a library class gives the data of a need."),
  {
    path: "thresholds.evolveMinGain",
    group: D,
    label: "Evolve minimum gain",
    help: "The score gain that a candidate needs to win with the same pass rate.",
    type: "number",
    min: 0,
    max: 0.5,
    step: 0.001,
  },
  {
    path: "thresholds.evolveScoreTolerance",
    group: D,
    label: "Evolve score tolerance",
    help: "The score loss that a candidate may have when its pass rate is higher.",
    type: "number",
    min: 0,
    max: 0.5,
    step: 0.005,
  },
  {
    path: "thresholds.evolvePassDrop",
    group: D,
    label: "Evolve pass rate drop",
    help: "The pass rate loss that a candidate may have.",
    type: "number",
    min: 0,
    max: 0.5,
    step: 0.01,
  },
  prob("thresholds.clarifyBelow", "Ask questions below", "Below this clarity, the builder asks you its questions."),
  prob("thresholds.planComplete", "Plan completeness", "The minimum completeness of an architect plan before a review."),
  prob("thresholds.planMinimal", "Plan minimality", "The minimum minimality of an architect plan before a review."),
  prob("thresholds.triageFlag", "Triage flag", "The probability above which a yes/no triage flag counts as yes."),
  prob("thresholds.codeStep", "Code step", "With the sandbox on: the probability above which a plan step becomes a code step."),
  prob("thresholds.minResolvedShare", "Resolved sources", "A build stops early only when less than this share of the data needs has a source."),
  prob("thresholds.exampleMatch", "Example match", "The minimum similarity for a library agent to be an example of a new build."),
  prob("thresholds.exampleMinScore", "Example score", "The minimum evaluation score for a library agent to be an example."),
  prob("thresholds.lessonMatch", "Lesson match", "The minimum probability that a lesson of the domain applies to the new task."),
  prob("thresholds.triggerAsked", "Trigger asked", "Below this probability, the agent starts manually and gets no trigger."),

  /* Runs */
  { path: "maxParallel", group: R, label: "Parallel steps", help: "The most steps of one run that run at the same time.", type: "integer", min: 1, max: 16 },
  { path: "nodeTimeoutMs", group: R, label: "Step time limit", help: "The default time limit of one step.", type: "integer", min: 10_000, max: 900_000, unit: "ms" },
  {
    path: "harnessMaxAttempts",
    group: R,
    label: "Harness attempts",
    help: "The attempts of a run with acceptance rules (try, check, fix, try again).",
    type: "integer",
    min: 1,
    max: 8,
  },
  { path: "harnessEvalAttempts", group: R, label: "Harness attempts in tests", help: "The attempts of a test run.", type: "integer", min: 1, max: 8 },
  {
    path: "maxPaidSearchesPerRun",
    group: R,
    label: "Paid searches for each run",
    help: "The most paid web searches of one run, when the agent does not set a value.",
    type: "integer",
    min: 0,
    max: 500,
  },
  { path: "searchProviders", group: R, label: "Search providers", help: "The web search providers, in order.", type: "list", options: ["openrouter", "wikipedia", "duckduckgo"] },
  {
    path: "searchCacheTtlMs",
    group: R,
    label: "Search cache time",
    help: "How long a search result stays valid. 0 turns the cache off.",
    type: "integer",
    min: 0,
    max: 7 * 86_400_000,
    unit: "ms",
  },
  {
    path: "effects.perTurnMax",
    group: R,
    label: "Actions for each turn",
    help: "The most actions of one tool in one turn of an agent step. 0: no limit.",
    type: "integer",
    min: 0,
    max: 20,
  },

  /* Model requests */
  {
    path: "requestTimeoutMs",
    group: Q,
    label: "Request time limit",
    help: "The shortest time limit of one model request.",
    type: "integer",
    min: 10_000,
    max: 600_000,
    unit: "ms",
  },
  { path: "timeoutTokensPerSec", group: Q, label: "Time limit rate", help: "A request with a large token budget gets budget / rate seconds.", type: "number", min: 5, max: 500 },
  { path: "timeoutRetries", group: Q, label: "Retries after a time-out", help: "How many times a request that hit its time limit runs again.", type: "integer", min: 0, max: 5 },
  {
    path: "maxRetryTokens",
    group: Q,
    label: "Retry token budget",
    help: "An answer that used its budget for reasoning runs again with at most this budget.",
    type: "integer",
    min: 1000,
    max: 128_000,
    unit: "tokens",
  },
  {
    path: "retryReasoningShare",
    group: Q,
    label: "Retry reasoning share",
    help: "In the retry, the reasoning gets at most this share of the budget.",
    type: "number",
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    path: "slowCallMs",
    group: Q,
    label: "Slow call",
    help: "A call slower than this (and below the token rate) marks its provider slow.",
    type: "integer",
    min: 1000,
    max: 300_000,
    unit: "ms",
  },
  { path: "minTokensPerSec", group: Q, label: "Minimum token rate", help: "A provider below this rate on a slow call is avoided for a time.", type: "number", min: 1, max: 500 },
  { path: "providerCooldownMs", group: Q, label: "Slow provider pause", help: "How long a slow provider is avoided.", type: "integer", min: 0, max: 86_400_000, unit: "ms" },

  /* Context */
  {
    path: "contextCompactAt",
    group: C,
    label: "Summaries start at",
    help: "Summaries start above this many tokens (and at most 60% of the model window).",
    type: "integer",
    min: 8000,
    max: 2_000_000,
    unit: "tokens",
  },
  { path: "modelContextTokens", group: C, label: "Model window", help: "The context window of the model.", type: "integer", min: 8000, max: 2_000_000, unit: "tokens" },
  {
    path: "recentTurnShare",
    group: C,
    label: "Recent turns share",
    help: "The share of the threshold that recent turns use without a summary.",
    type: "number",
    min: 0.05,
    max: 0.9,
    step: 0.05,
  },
  {
    path: "partCapShare",
    group: C,
    label: "One part share",
    help: "The share of the threshold that one part (a tool result, a file) can use.",
    type: "number",
    min: 0.05,
    max: 0.9,
    step: 0.05,
  },

  /* Data sources */
  {
    path: "sourceWeights.freshness",
    group: S,
    label: "Freshness weight",
    help: "The share of the source score that freshness controls.",
    type: "number",
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    path: "sourceWeights.coverage",
    group: S,
    label: "Coverage weight",
    help: "The share of the source score that field coverage controls.",
    type: "number",
    min: 0,
    max: 1,
    step: 0.05,
  },
  { path: "sourceWeights.browserFactor", group: S, label: "Browser factor", help: "The factor for a source that needs the browser.", type: "number", min: 0, max: 1, step: 0.05 },
  {
    path: "sourceWeights.textFactor",
    group: S,
    label: "Text factor",
    help: "The factor for a source that gives page text, not JSON fields.",
    type: "number",
    min: 0,
    max: 1,
    step: 0.05,
  },
  { path: "sourceWeights.libraryBonus", group: S, label: "Library bonus", help: "The bonus for a tested class from the library.", type: "number", min: 0, max: 1, step: 0.01 },
  { path: "sourceWeights.namedBonus", group: S, label: "Named URL bonus", help: "The bonus for a URL that the request names.", type: "number", min: 0, max: 2, step: 0.05 },
  {
    path: "sourceWeights.slowMs",
    group: S,
    label: "Slow source",
    help: "A source slower than this in the probe gets the slow factor.",
    type: "integer",
    min: 500,
    max: 60_000,
    unit: "ms",
  },
  { path: "sourceWeights.slowFactor", group: S, label: "Slow factor", help: "The factor for a slow source.", type: "number", min: 0, max: 1, step: 0.05 },
  { path: "live.retries", group: S, label: "Retries of a live call", help: "New attempts for a transient failure of a GET request.", type: "integer", min: 0, max: 5 },
  { path: "live.backoffMs", group: S, label: "First wait", help: "The first wait before a new attempt. It doubles each time.", type: "integer", min: 0, max: 30_000, unit: "ms" },
  {
    path: "live.maxRetryAfterMs",
    group: S,
    label: "Longest Retry-After",
    help: "A longer Retry-After is a rate limit: the answer goes back at once.",
    type: "integer",
    min: 0,
    max: 120_000,
    unit: "ms",
  },
  { path: "live.cache", group: S, label: "Cache GET answers", help: "In test runs only, in all runs, or never.", type: "enum", options: ["eval", "all", "off"] },
  { path: "live.cacheTtlMs", group: S, label: "Cache time", help: "How long a cached answer stays valid.", type: "integer", min: 0, max: 86_400_000, unit: "ms" },
  {
    path: "tools.dataChars",
    group: S,
    label: "Tool data in test generation",
    help: "The most characters of tool data that test generation sees.",
    type: "integer",
    min: 500,
    max: 50_000,
    unit: "chars",
  },

  /* Library */
  { path: "library.examples", group: L, label: "Use examples", help: "Give the best library agents of the same class to a new build as examples.", type: "boolean" },
  { path: "library.maxExamples", group: L, label: "Examples for each build", help: "The most examples for one build.", type: "integer", min: 0, max: 10 },
  { path: "library.maxCandidates", group: L, label: "Agents to compare", help: "The most library agents that Jev compares with a new task.", type: "integer", min: 1, max: 50 },
  { path: "library.exampleChars", group: L, label: "Example size", help: "The most characters of one example in a prompt.", type: "integer", min: 500, max: 20_000, unit: "chars" },
  { path: "library.maxLessons", group: L, label: "Lessons for each domain", help: "The most lessons that one domain keeps.", type: "integer", min: 0, max: 500 },
  { path: "library.lessonsInPrompt", group: L, label: "Lessons in a prompt", help: "The most lessons in one prompt.", type: "integer", min: 0, max: 50 },
  { path: "library.lessonMaxAgeDays", group: L, label: "Lesson age", help: "A lesson older than this is not used.", type: "integer", min: 1, max: 3650, unit: "days" },
  { path: "library.domains", group: L, label: "Known domains", help: "Jev selects one of them for a new agent, or the builder names a new one.", type: "list" },

  /* Health checks */
  {
    path: "health.everyMs",
    group: H,
    label: "Check interval",
    help: "The time between two checks of a live data agent. 0 turns the checks off. Each check runs tests with your key.",
    type: "integer",
    min: 0,
    max: 30 * 86_400_000,
    unit: "ms",
  },
  {
    path: "health.minScore",
    group: H,
    label: "Broken below",
    help: "An agent is broken when the score of a check is below this value.",
    type: "number",
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    path: "health.maxDrop",
    group: H,
    label: "Broken after a drop of",
    help: "An agent is broken when the score falls more than this below its last evaluation.",
    type: "number",
    min: 0,
    max: 1,
    step: 0.05,
  },
  { path: "health.budgetUsd", group: H, label: "Budget of a check", help: "The most money for one check.", type: "number", min: 0.01, max: 10, step: 0.05, unit: "USD" },
  { path: "health.evolve", group: H, label: "Evolve a broken agent", help: "Start evolve for a broken agent. The fix is a new version that you publish.", type: "boolean" },
];

const FIELD = new Map(SETTING_FIELDS.map((f) => [f.path, f]));

function getAt(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function setAt(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== "object") o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[keys.at(-1)!] = value;
}

/** The current value of each setting in a config. */
export function settingValues(cfg: AnvilConfig): Record<string, unknown> {
  return Object.fromEntries(SETTING_FIELDS.map((f) => [f.path, getAt(cfg, f.path)]));
}

/** Checks one value. Gives the clean value, or throws an error with the reason. */
export function cleanSetting(path: string, raw: unknown): unknown {
  const f = FIELD.get(path);
  if (!f) throw new Error(`"${path}" is not a setting`);
  const range = (n: number) => {
    if (!Number.isFinite(n)) throw new Error(`${f.label}: give a number`);
    if (f.min !== undefined && n < f.min) throw new Error(`${f.label}: the minimum is ${f.min}`);
    if (f.max !== undefined && n > f.max) throw new Error(`${f.label}: the maximum is ${f.max}`);
    return n;
  };
  switch (f.type) {
    case "number":
      return range(Number(raw));
    case "integer":
      return Math.round(range(Number(raw)));
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "false") return raw === "true";
      throw new Error(`${f.label}: give true or false`);
    case "enum":
      if (!f.options!.includes(String(raw))) throw new Error(`${f.label}: give one of ${f.options!.join(", ")}`);
      return String(raw);
    case "text": {
      const t = String(raw ?? "").trim();
      if (t.length > 200) throw new Error(`${f.label}: the text is too long`);
      if (t && !/^[\w.:/@-]+$/.test(t)) throw new Error(`${f.label}: give a model id, for example z-ai/glm-5.3-flash`);
      return t;
    }
    case "list": {
      const items = (Array.isArray(raw) ? raw : String(raw ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean);
      if (items.length > 30) throw new Error(`${f.label}: at most 30 items`);
      for (const x of items) {
        if (f.options && !f.options.includes(x)) throw new Error(`${f.label}: "${x}" is not one of ${f.options.join(", ")}`);
        if (!/^[\w.:/@-]{1,120}$/.test(x)) throw new Error(`${f.label}: "${x}" is not a valid item`);
      }
      return items;
    }
  }
}

/** Checks each value of a change. Gives the clean values. */
export function cleanSettings(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, cleanSetting(k, v)]));
}

/**
 * The config of a workspace: the server config with the settings of the user on top. A tier model that the user
 * did not set follows the System 2 model of the user. The result is a new object: the server config does not change.
 */
export function applySettings(base: AnvilConfig, settings: Record<string, unknown>): AnvilConfig {
  const cfg = structuredClone(base) as unknown as Record<string, unknown> & AnvilConfig;
  for (const [path, value] of Object.entries(settings)) {
    if (!FIELD.has(path)) continue;
    // An empty tier model means "the System 2 model".
    if (/^tiers\.\w+\.model$/.test(path) && value === "") continue;
    setAt(cfg, path, value);
  }
  for (const t of ["fast", "balanced", "deep"] as const)
    if (settings[`tiers.${t}.model`] === undefined || settings[`tiers.${t}.model`] === "") {
      if (getAt(base, `tiers.${t}.model`) === base.llmModel) cfg.tiers[t].model = cfg.llmModel;
    }
  return cfg;
}

/** Writes the values of `from` into `into` (the live config object of a workspace): running services see the change. */
export function assignConfig(into: AnvilConfig, from: AnvilConfig): void {
  const walk = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(b)) {
      if (v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k]))
        walk(a[k] as Record<string, unknown>, v as Record<string, unknown>);
      else a[k] = v;
    }
  };
  walk(into as unknown as Record<string, unknown>, from as unknown as Record<string, unknown>);
}
