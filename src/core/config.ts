import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { parseEvery } from "./schedule.js";

/** Load .env from the working directory, falling back to the project root. */
const projectRoot = path.resolve(import.meta.dirname, "../..");
for (const candidate of [path.resolve(".env"), path.join(projectRoot, ".env")]) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, quiet: true });
    break;
  }
}

export type Tier = "fast" | "balanced" | "deep";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface TierConfig {
  model: string;
  reasoning: ReasoningEffort;
  maxTokens: number;
}

/**
 * The decision thresholds of the builder and the harness. Each value is a
 * probability (0 to 1) from the decision model, or a score difference.
 * Each one has an environment variable, so a benchmark run can calibrate it.
 */
export interface Thresholds {
  /** The confidence that a failure diagnosis needs before evolve acts on it. Below it, a second opinion runs. */
  diagnosisConfidence: number;
  /** The minimum probability that a candidate keeps the meaning of the request. */
  intentKeep: number;
  /** The minimum probability for a judge rule of the definition of done. */
  acceptanceJudge: number;
  /** The action gate (docs/GATE.md): a confirmation or a rule with a lower probability blocks the action. */
  actionGate: number;
  /** The minimum probability for a test criterion to pass. */
  criterionPass: number;
  /** The minimum relevance of a data source sample. */
  sourceRelevance: number;
  /** The minimum probability that a library class gives the data of a need. */
  libraryMatch: number;
  /** The score gain that an evolve candidate needs to win with the same pass rate. */
  evolveMinGain: number;
  /** The score loss that an evolve candidate may have when its pass rate is higher. */
  evolveScoreTolerance: number;
  /** The pass rate loss that an evolve candidate may have. A candidate with a higher score but fewer passed tests does not win. */
  evolvePassDrop: number;
  /** Below this clarity, the builder asks the person its questions. */
  clarifyBelow: number;
  /** The minimum completeness and minimality of an architect plan before a review. */
  planComplete: number;
  planMinimal: number;
  /** The probability above which a yes/no triage flag counts as yes. */
  triageFlag: number;
  /** With the sandbox on: the probability above which the plan review makes a step a code_agent step. */
  codeStep: number;
  /** The source plan stops a build early only when less than this share of the required data needs has a source. */
  minResolvedShare: number;
  /** The minimum similarity (from Jev) for a library agent to be an example of a new build. */
  exampleMatch: number;
  /** The minimum evaluation score for a library agent to be an example. Its quality must also be "passed". */
  exampleMinScore: number;
  /** The minimum probability (from Jev) that a lesson of the domain applies to the new task. */
  lessonMatch: number;
  /** The minimum probability that the request asks for the trigger that the analysis gives. Below it, the agent starts manually. */
  triggerAsked: number;
}

/** Calls to live data sources (docs/LIVE_DATA.md). */
export interface LiveConfig {
  /** New attempts for a transient failure (network error, timeout, HTTP 408/425/429/5xx) of a GET request. */
  retries: number;
  /** The first wait before a new attempt (ms). It doubles each time. */
  backoffMs: number;
  /** A Retry-After up to this wait (ms) is respected. A longer one is a rate limit: the answer goes back at once. */
  maxRetryAfterMs: number;
  /** Cache GET answers: in evaluation runs ("eval"), in all runs ("all"), or never ("off"). */
  cache: "eval" | "all" | "off";
  cacheTtlMs: number;
  cacheMax: number;
  /** Headers for an exact host, for example {"api.github.com": {"Authorization": "Bearer ${GITHUB_TOKEN}"}}. ${NAME} reads .env. */
  hostHeaders: Record<string, Record<string, string>>;
}

/** Given tools (docs/TOOLS.md). */
export interface ToolsConfig {
  /** The call adapter of a tool without its own: "http" or "mock" (a platform can register more). */
  adapter: string;
  /** The base URL of the http adapter: a tool without an endpoint calls <endpoint>/<name>. */
  endpoint: string;
  /** The most characters of tool data (mock start data, results of list tools) that testgen sees. */
  dataChars: number;
}

/** Best-of-N with several builder models (docs/SELECTION.md). */
export interface BestOfConfig {
  /** on: each build is a best-of-N build. A build request can also ask for it. */
  enabled: boolean;
  /** The builder models: one candidate for each model. */
  models: string[];
  /** The model that decides between candidates with close scores. */
  judgeModel: string;
  /** A lead larger than this value wins without the judge. */
  margin: number;
  /** The most tests in the shared suite. Given tests always stay. */
  maxTests: number;
  /** A candidate that takes longer is out. */
  candidateTimeoutMs: number;
  /** When two candidates are ready, the others have this much more time. */
  candidateGraceMs: number;
  /** The weight of a given test in the selection. A generated test has the weight 1. */
  givenWeight: number;
}

/** Health checks of live data agents (docs/HEALTH.md). */
export interface HealthConfig {
  /** The interval between two checks of one agent. 0 turns the checks off. */
  everyMs: number;
  /** An agent is broken when the score of a check is below this value. */
  minScore: number;
  /** An agent is broken when the score falls more than this value below the score of its last evaluation. */
  maxDrop: number;
  /** The most money for one check. */
  budgetUsd: number;
  /** Start evolve for a broken agent. The fix is a new version that a person publishes. */
  evolve: boolean;
  /** The checks that the history of one agent keeps. */
  historyMax: number;
}

/** Attached files (docs/FILES.md). */
export interface FilesConfig {
  /** The largest file (bytes). */
  maxBytes: number;
  /** The most characters of text that a file keeps. */
  maxTextChars: number;
  /** The most rows of a table that a file keeps. */
  maxRows: number;
}

/** The library (docs/LIBRARY.md): classes of agents, examples for new builds, and the lessons of each domain. */
export interface LibraryConfig {
  /** Give the best library agents of the same class to a new build as examples. */
  examples: boolean;
  /** The known domains. Jev selects one of them, or the builder names a new one. */
  domains: string[];
  /** The most examples for one build. */
  maxExamples: number;
  /** The most library agents that Jev compares with a new task. */
  maxCandidates: number;
  /** The most characters of one example in a prompt. */
  exampleChars: number;
  /** The most lessons that one domain keeps. */
  maxLessons: number;
  /** The most lessons in one prompt. */
  lessonsInPrompt: number;
  /** A lesson that is older than this is not used. */
  lessonMaxAgeDays: number;
}

/** The weights of the source score: score = relevance × (1 − freshness weight + freshness weight × freshness) × factors + bonuses. */
export interface SourceWeights {
  /** The share of the score that freshness controls (0: freshness has no effect). */
  freshness: number;
  /** The share of the score that the field coverage controls (0: only the topic counts). */
  coverage: number;
  /** The factor for a source that needs the browser (slower and more fragile than plain HTTP). */
  browserFactor: number;
  /** The factor for a source that gives page text, not JSON fields. */
  textFactor: number;
  /** The bonus for a tested class from the library. */
  libraryBonus: number;
  /** The bonus for a URL that the request names. */
  namedBonus: number;
  /** A source that answers slower than this (ms) in the probe gets slowFactor: it can time out when the agent runs. */
  slowMs: number;
  slowFactor: number;
}

export interface AnvilConfig {
  apiKey: string;
  baseUrl: string;
  llmModel: string;
  decisionModel: string;
  tiers: Record<Tier, TierConfig>;
  port: number;
  /** The address that the server listens on. 0.0.0.0 in a container. */
  host: string;
  /** When set, each /api and /mcp request must give this token (Authorization: Bearer, X-Anvil-Token, or ?token= for event streams). */
  apiToken: string;
  /**
   * The hosted mode (docs/HOSTING.md): accounts, one workspace for each user, the OpenRouter key of each user,
   * and a network guard. Off: the local, single-user Anvil.
   */
  hosted: boolean;
  /** The web origins that can call the API from a browser (the address of the web app, for example on Vercel). */
  corsOrigins: string[];
  /** The public address of the API (for webhook URLs), for example https://anvil-api.example.com. */
  publicUrl: string;
  dataDir: string;
  /** Jev confidence below this escalates the decision to a reasoning model (System 2). */
  confidenceThreshold: number;
  /** Target pass-rate for the evolve loop. */
  evolveTarget: number;
  evolveMaxRounds: number;
  repairMaxAttempts: number;
  maxParallel: number;
  /** The shortest time limit of one model request. */
  requestTimeoutMs: number;
  /**
   * The time limit of a chat request grows with its token budget: budget / this rate.
   * A deep call with a large budget (for example the critic) gets more time than a short call.
   */
  timeoutTokensPerSec: number;
  /** How many times a request that hit its time limit runs again. The same request is often slow again. */
  timeoutRetries: number;
  /** An answer that used its token budget for reasoning runs again with a larger budget, at most this many tokens. */
  maxRetryTokens: number;
  /** In that new attempt, the reasoning gets at most this share of the budget. The third attempt turns the reasoning off. */
  retryReasoningShare: number;
  /** OpenRouter provider ordering for chat calls: throughput | latency | price | none. */
  providerSort: "throughput" | "latency" | "price" | "none";
  /** A completed call slower than this (and below minTokensPerSec) marks its provider slow. */
  slowCallMs: number;
  minTokensPerSec: number;
  /** How long a slow provider is avoided. */
  providerCooldownMs: number;
  /** Default per-node timeout for classes that don't declare their own. */
  nodeTimeoutMs: number;
  /** Paid web searches for one run, when the agent policy does not set a value. */
  maxPaidSearchesPerRun: number;
  /** Time that a cached search result stays valid. 0 turns the cache off. */
  searchCacheTtlMs: number;
  /** How often the cost of nested runs goes to the parent run while they work. */
  liveUsageMs: number;
  /** Evaluation: run the first test alone, and run the others only when it passes. */
  evalSmokeFirst: boolean;
  /** Best-of-N (docs/SELECTION.md). */
  bestOf: BestOfConfig;
  /** pass^k (docs/SELECTION.md): the runs of each test in an evaluation of evolve, and in the selection of best-of-N. */
  evalRepeats: number;
  selectRepeats: number;
  /** The other tests do not run only when the score of the failed smoke test is below this value. */
  evalSmokeMinScore: number;
  /**
   * No person is there: every run approves its human_approval steps and skips its
   * human_input steps at once, with a record. The builder asks no questions and adds no human steps.
   */
  unattended: boolean;
  /** The profile of the defaults (ANVIL_PROFILE): "default" or "fast". */
  profile: string;
  /**
   * A regular expression (case-insensitive) that finds a rate limit or a quota of a source in an error.
   * Such a failure comes from the environment, not from the agent: the evaluation does not score that test.
   */
  rateLimitPattern: string;
  library: LibraryConfig;
  live: LiveConfig;
  files: FilesConfig;
  tools: ToolsConfig;
  /** Rules from a policy (docs/POLICY.md): the most rules in the acceptance of an agent, and the most tests that try to break a rule. */
  rules: { maxAcceptance: number; maxTests: number };
  health: HealthConfig;
  /** Evaluation money for one build or evolve run (all rounds together). */
  evalBudgetUsd: number;
  /** The most characters of test evidence (outputs and traces of the failed tests) in one critic prompt. */
  criticEvidenceChars: number;
  /** When no candidate source gives the data of a need, the model proposes new candidates this many times. */
  sourceRetryRounds: number;
  /** When the repair loop cannot fix a draft, compose writes a new draft this many times. */
  composeRetries: number;
  /** Stop the evolve loop after this many rejected rounds in a row. */
  evolveMaxRejected: number;
  /** Ask a person before a build when the high estimate is above this value. */
  buildConfirmUsd: number;
  /** Browser for JavaScript pages. An empty path uses the Playwright Chromium, then the installed browsers. */
  /** The Python sandbox (docs/SANDBOX.md). */
  sandbox: {
    mode: "docker" | "off";
    image: string;
    network: "isolated" | "allowlist" | "open";
    pool: number;
    timeoutMs: number;
    memory: string;
    cpus: number;
    maxOutputBytes: number;
    /** The index that the package gate uses: PyPI or a company mirror such as Nexus. */
    packageIndex: string;
    /** "osv" checks each package version for known vulnerabilities. "off" trusts the index (for example a vetted Nexus). */
    vulnCheck: "osv" | "off";
    packageAllow: string[];
    packageDeny: string[];
    /** The port of the package gate on the host. */
    gatePort: number;
    /** The address that the package gate listens on. 0.0.0.0 when Anvil runs in a container. */
    gateBind: string;
    /** The host name that the gate sidecar uses to reach the package gate. */
    gateTargetHost: string;
    /** The most data that one outbound request of a program can send. */
    egressMaxBody: number;
    /** The time that all programs of one run can use (seconds). The policy of an agent can set less. */
    maxSecondsPerRun: number;
    /** A code_agent step keeps its working program and runs it again for the next inputs. It writes a new program only when the kept one fails. */
    programCache: boolean;
    /** The container runtime of the sandbox and its gate (docs/HOSTING.md): "runsc" (gVisor) gives each container its own kernel. Empty: the Docker default. */
    runtime: string;
    /**
     * The Docker network that the gate sidecar joins to reach the package gate of Anvil, when Anvil runs in a container
     * (docs/HOSTING.md). Empty: the sidecar reaches the host through host.docker.internal.
     */
    gateNetwork: string;
  };
  browserPath?: string;
  /**
   * A remote browser (docs/HOSTING.md): the WebSocket of a Playwright browser server, for example in a container
   * without a route to the network of the server. Empty: Anvil starts a local browser.
   */
  browserWsEndpoint: string;
  /** The port of the guarded forward proxy for the remote browser (docs/HOSTING.md). 0: no proxy. */
  egressProxyPort: number;
  browserHeadless: boolean;
  browserMaxPages: number;
  browserNavTimeoutMs: number;
  /** Minimum time between two page visits to the same domain. */
  browserDomainIntervalMs: number;
  browserRespectRobots: boolean;
  /** Harness: attempts for each run, and for each evaluation run. */
  harnessMaxAttempts: number;
  harnessEvalAttempts: number;
  /** Context: summaries start above this many tokens (also limited to 60% of the model window). */
  contextCompactAt: number;
  /** The context window of the model, in tokens. */
  modelContextTokens: number;
  /** The share of the threshold that the recent turns can use without a summary. */
  recentTurnShare: number;
  /** The share of the threshold that one part (a tool result, an attachment) can use. */
  partCapShare: number;
  thresholds: Thresholds;
  sourceWeights: SourceWeights;
  /** STE: the limit for prompt text and prose (violations for each 100 words). */
  steMaxPer100w: number;
  /** STE: how the builder treats prompt text that is not in STE. "error" rewrites it in the repair loop. */
  stePrompts: "error" | "warning" | "off";
  /** Web search providers, tried in order until one returns results. */
  searchProviders: ("openrouter" | "wikipedia" | "duckduckgo")[];
  /** Trigger queues (docs/TRIGGERS.md): an event that comes while the run of its trigger is active waits in the queue. */
  triggers: TriggerQueueConfig;
  /** Incoming webhooks (docs/TRIGGERS.md): the signature, the replay window, the dedupe window, and the body limit. */
  webhook: WebhookConfig;
  /** The effect record (docs/EFFECTS.md): an action with a side effect runs one time for each run. */
  effects: EffectsConfig;
}

export interface TriggerQueueConfig {
  /** The maximum number of waiting events for each trigger. A full queue rejects the event with 429. */
  queueMax: number;
  /** A waiting event older than this does not start a run. */
  queueTtlMs: number;
}

export interface WebhookConfig {
  /** "hmac": only a signed request. "token": only the token header. "either": a signature or the token header. */
  auth: "hmac" | "token" | "either";
  /** The time window of a signed request (X-Anvil-Timestamp). A request outside it is a replay. */
  toleranceMs: number;
  /** The largest request body in bytes. */
  maxBodyBytes: number;
  /** A delivery id that comes again in this time does not start a second run. */
  dedupeTtlMs: number;
  /** The headers that can hold a delivery id (lower case), in order. */
  idHeaders: string[];
  /** The maximum number of delivery ids that each trigger keeps. */
  dedupeMax: number;
}

export interface EffectsConfig {
  /** How long the record of a done action stays. */
  ttlMs: number;
  /** The most actions of one tool in one turn of an agent step. 0: no limit. */
  perTurnMax: number;
}

/** ANVIL_HOST_HEADERS: a JSON object of host → headers. Host names are lower case. A bad value stops the start, with the reason. */
function hostHeaders(raw: string | undefined): LiveConfig["hostHeaders"] {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Config ANVIL_HOST_HEADERS must be JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Config ANVIL_HOST_HEADERS must be a JSON object of host → headers");
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([host, h]) => {
      if (!h || typeof h !== "object") throw new Error(`Config ANVIL_HOST_HEADERS: the headers of "${host}" must be an object`);
      return [host.toLowerCase(), Object.fromEntries(Object.entries(h as Record<string, unknown>).map(([k, v]) => [k, String(v)]))];
    }),
  );
}

/**
 * Profiles: a set of defaults for many settings at once.
 * "fast" makes builds short and cheap, for an event with a time limit.
 * A variable in the environment still overrides the value of the profile.
 */
export const PROFILES: Record<string, Record<string, number>> = {
  default: {},
  fast: {
    ANVIL_EVOLVE_MAX_ROUNDS: 1,
    ANVIL_EVOLVE_MAX_REJECTED: 1,
    ANVIL_EVAL_BUDGET_USD: 0.25,
    ANVIL_HARNESS_MAX_ATTEMPTS: 2,
    ANVIL_HARNESS_EVAL_ATTEMPTS: 1,
    ANVIL_REPAIR_MAX_ATTEMPTS: 3,
    ANVIL_SOURCE_RETRY_ROUNDS: 0,
    ANVIL_NODE_TIMEOUT_MS: 90_000,
    ANVIL_REQUEST_TIMEOUT_MS: 60_000,
    ANVIL_RULES_MAX_TESTS: 2,
  },
};

/** The selected profile (ANVIL_PROFILE). An unknown name is an error, so a typing error does not go unseen. */
export function profileName(): string {
  const p = (process.env.ANVIL_PROFILE || "default").toLowerCase();
  if (!PROFILES[p]) throw new Error(`Config ANVIL_PROFILE must be one of ${Object.keys(PROFILES).join(", ")}, got "${p}"`);
  return p;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return PROFILES[profileName()][name] ?? fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Config ${name} must be a number, got "${raw}"`);
  return n;
}

function loadTiers(llmModel: string): Record<Tier, TierConfig> {
  const defaults: Record<Tier, TierConfig> = {
    fast: { model: llmModel, reasoning: "low", maxTokens: 4096 },
    balanced: { model: llmModel, reasoning: "medium", maxTokens: 8192 },
    deep: { model: llmModel, reasoning: "high", maxTokens: 16384 },
  };
  const raw = process.env.ANVIL_TIERS;
  if (!raw) return defaults;
  let parsed: Partial<Record<Tier, Partial<TierConfig>>>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ANVIL_TIERS must be valid JSON");
  }
  for (const tier of Object.keys(defaults) as Tier[]) {
    defaults[tier] = { ...defaults[tier], ...(parsed[tier] ?? {}) };
  }
  return defaults;
}

export function loadConfig(): AnvilConfig {
  const llmModel = process.env.ANVIL_LLM_MODEL || "z-ai/glm-5.3-flash";
  return {
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api",
    llmModel,
    decisionModel: process.env.ANVIL_DECISION_MODEL || "typesafe/jev-1.13",
    tiers: loadTiers(llmModel),
    port: num("ANVIL_PORT", 8787),
    host: process.env.ANVIL_HOST || "127.0.0.1",
    apiToken: process.env.ANVIL_API_TOKEN ?? "",
    hosted: ["on", "true", "1"].includes((process.env.ANVIL_HOSTED ?? "").toLowerCase()),
    corsOrigins: (process.env.ANVIL_CORS_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean),
    publicUrl: (process.env.ANVIL_PUBLIC_URL ?? "").replace(/\/+$/, ""),
    dataDir: path.resolve(process.env.ANVIL_DATA_DIR || path.join(projectRoot, "data")),
    confidenceThreshold: num("ANVIL_CONFIDENCE_THRESHOLD", 0.6),
    evolveTarget: num("ANVIL_EVOLVE_TARGET", 0.85),
    evolveMaxRounds: num("ANVIL_EVOLVE_MAX_ROUNDS", 2),
    repairMaxAttempts: num("ANVIL_REPAIR_MAX_ATTEMPTS", 4),
    maxParallel: num("ANVIL_MAX_PARALLEL", 8),
    requestTimeoutMs: num("ANVIL_REQUEST_TIMEOUT_MS", 90_000),
    timeoutTokensPerSec: num("ANVIL_TIMEOUT_TOKENS_PER_SEC", 40),
    timeoutRetries: num("ANVIL_TIMEOUT_RETRIES", 1),
    maxRetryTokens: num("ANVIL_MAX_RETRY_TOKENS", 32_000),
    retryReasoningShare: num("ANVIL_RETRY_REASONING_SHARE", 0.4),
    providerSort: (["throughput", "latency", "price", "none"].includes(process.env.ANVIL_PROVIDER_SORT ?? "")
      ? process.env.ANVIL_PROVIDER_SORT
      : "throughput") as AnvilConfig["providerSort"],
    slowCallMs: num("ANVIL_SLOW_CALL_MS", 25_000),
    minTokensPerSec: num("ANVIL_MIN_TOKENS_PER_SEC", 15),
    providerCooldownMs: num("ANVIL_PROVIDER_COOLDOWN_MS", 10 * 60_000),
    nodeTimeoutMs: num("ANVIL_NODE_TIMEOUT_MS", 180_000),
    maxPaidSearchesPerRun: num("ANVIL_MAX_PAID_SEARCHES", 12),
    searchCacheTtlMs: num("ANVIL_SEARCH_CACHE_TTL_MS", 6 * 3_600_000),
    liveUsageMs: num("ANVIL_LIVE_USAGE_MS", 2000),
    evalSmokeFirst: (process.env.ANVIL_EVAL_SMOKE_FIRST ?? "true") !== "false",
    evalSmokeMinScore: num("ANVIL_EVAL_SMOKE_MIN_SCORE", 0.5),
    bestOf: {
      enabled: ["on", "true", "1"].includes((process.env.ANVIL_BEST_OF ?? "").toLowerCase()),
      models: (process.env.ANVIL_BUILD_MODELS || "z-ai/glm-5.3-flash,deepseek/deepseek-v4.1-flash")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
      judgeModel: process.env.ANVIL_SELECT_JUDGE_MODEL || "moonshotai/kimi-k3",
      margin: num("ANVIL_SELECT_MARGIN", 0.05),
      maxTests: Math.max(1, Math.round(num("ANVIL_SELECT_MAX_TESTS", 12))),
      // A conversation build runs each test as many turns: 15 minutes is too short for a slower model.
      candidateTimeoutMs: num("ANVIL_CANDIDATE_TIMEOUT_MS", 1_800_000),
      candidateGraceMs: num("ANVIL_CANDIDATE_GRACE_MS", 180_000),
      givenWeight: num("ANVIL_SELECT_GIVEN_WEIGHT", 2),
    },
    evalRepeats: Math.max(1, Math.round(num("ANVIL_EVAL_REPEATS", 1))),
    selectRepeats: Math.max(1, Math.round(num("ANVIL_SELECT_REPEATS", 3))),
    profile: profileName(),
    unattended: ["on", "true", "1"].includes((process.env.ANVIL_UNATTENDED ?? "").toLowerCase()),
    criticEvidenceChars: num("ANVIL_CRITIC_EVIDENCE_CHARS", 16_000),
    sourceRetryRounds: num("ANVIL_SOURCE_RETRY_ROUNDS", 1),
    health: {
      everyMs: ["off", "0", "false", ""].includes((process.env.ANVIL_HEALTH_EVERY ?? "1d").toLowerCase()) ? 0 : parseEvery(process.env.ANVIL_HEALTH_EVERY ?? "1d"),
      minScore: num("ANVIL_HEALTH_MIN_SCORE", 0.6),
      maxDrop: num("ANVIL_HEALTH_MAX_DROP", 0.25),
      budgetUsd: num("ANVIL_HEALTH_BUDGET_USD", 0.3),
      evolve: ["on", "true", "1"].includes((process.env.ANVIL_HEALTH_EVOLVE ?? "").toLowerCase()),
      historyMax: num("ANVIL_HEALTH_HISTORY", 30),
    },
    rules: { maxAcceptance: num("ANVIL_RULES_MAX_ACCEPTANCE", 6), maxTests: num("ANVIL_RULES_MAX_TESTS", 3) },
    tools: {
      adapter: process.env.ANVIL_TOOL_ADAPTER || "http",
      endpoint: process.env.ANVIL_TOOL_ENDPOINT || "",
      dataChars: num("ANVIL_TOOL_DATA_CHARS", 4000),
    },
    files: {
      maxBytes: num("ANVIL_FILE_MAX_BYTES", 20 * 1024 * 1024),
      maxTextChars: num("ANVIL_FILE_MAX_TEXT_CHARS", 200_000),
      maxRows: num("ANVIL_FILE_MAX_ROWS", 5000),
    },
    live: {
      retries: num("ANVIL_LIVE_RETRIES", 2),
      backoffMs: num("ANVIL_LIVE_BACKOFF_MS", 800),
      maxRetryAfterMs: num("ANVIL_LIVE_MAX_RETRY_AFTER_MS", 15_000),
      cache: (["eval", "all", "off"].includes(process.env.ANVIL_LIVE_CACHE ?? "") ? process.env.ANVIL_LIVE_CACHE : "eval") as LiveConfig["cache"],
      cacheTtlMs: num("ANVIL_LIVE_CACHE_TTL_MS", 600_000),
      cacheMax: num("ANVIL_LIVE_CACHE_MAX", 500),
      hostHeaders: hostHeaders(process.env.ANVIL_HOST_HEADERS),
    },
    library: {
      examples: (process.env.ANVIL_LIBRARY_EXAMPLES ?? "on") !== "off",
      domains: (
        process.env.ANVIL_LIBRARY_DOMAINS ||
        "finance,currency_exchange,earthquakes_geology,weather_climate,software_development,news_media,ecommerce_retail,customer_support,documents_text,marketing_sales,health_medicine,legal_compliance,government_open_data,sports,travel_transport,education,human_resources"
      )
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
      maxExamples: num("ANVIL_LIBRARY_MAX_EXAMPLES", 2),
      maxCandidates: num("ANVIL_LIBRARY_MAX_CANDIDATES", 8),
      exampleChars: num("ANVIL_LIBRARY_EXAMPLE_CHARS", 4000),
      maxLessons: num("ANVIL_LIBRARY_MAX_LESSONS", 60),
      lessonsInPrompt: num("ANVIL_LIBRARY_LESSONS_IN_PROMPT", 8),
      lessonMaxAgeDays: num("ANVIL_LIBRARY_LESSON_MAX_AGE_DAYS", 120),
    },
    rateLimitPattern: process.env.ANVIL_RATE_LIMIT_PATTERN || String.raw`\b429\b|rate[ _-]?limit|too many requests|quota (?:exceeded|exhausted|reached)|retry-after`,
    evalBudgetUsd: num("ANVIL_EVAL_BUDGET_USD", 0.5),
    evolveMaxRejected: num("ANVIL_EVOLVE_MAX_REJECTED", 2),
    composeRetries: num("ANVIL_COMPOSE_RETRIES", 1),
    buildConfirmUsd: num("ANVIL_BUILD_CONFIRM_USD", 0.5),
    harnessMaxAttempts: num("ANVIL_HARNESS_MAX_ATTEMPTS", 3),
    harnessEvalAttempts: num("ANVIL_HARNESS_EVAL_ATTEMPTS", 2),
    contextCompactAt: num("ANVIL_CONTEXT_COMPACT_AT", 200_000),
    modelContextTokens: num("ANVIL_MODEL_CONTEXT_TOKENS", 1_048_576),
    recentTurnShare: num("ANVIL_RECENT_TURN_SHARE", 0.4),
    partCapShare: num("ANVIL_PART_CAP_SHARE", 0.25),
    steMaxPer100w: num("ANVIL_STE_MAX_PER_100W", 4),
    thresholds: {
      diagnosisConfidence: num("ANVIL_TH_DIAGNOSIS_CONFIDENCE", 0.6),
      intentKeep: num("ANVIL_TH_INTENT_KEEP", 0.5),
      acceptanceJudge: num("ANVIL_TH_ACCEPTANCE_JUDGE", 0.5),
      actionGate: num("ANVIL_TH_ACTION_GATE", 0.6),
      criterionPass: num("ANVIL_TH_CRITERION_PASS", 0.5),
      sourceRelevance: num("ANVIL_TH_SOURCE_RELEVANCE", 0.5),
      libraryMatch: num("ANVIL_TH_LIBRARY_MATCH", 0.6),
      evolveMinGain: num("ANVIL_TH_EVOLVE_MIN_GAIN", 0.005),
      evolveScoreTolerance: num("ANVIL_TH_EVOLVE_SCORE_TOLERANCE", 0.02),
      evolvePassDrop: num("ANVIL_TH_EVOLVE_PASS_DROP", 0),
      clarifyBelow: num("ANVIL_TH_CLARIFY_BELOW", 0.5),
      planComplete: num("ANVIL_TH_PLAN_COMPLETE", 0.5),
      planMinimal: num("ANVIL_TH_PLAN_MINIMAL", 0.35),
      triageFlag: num("ANVIL_TH_TRIAGE_FLAG", 0.5),
      codeStep: num("ANVIL_TH_CODE_STEP", 0.6),
      minResolvedShare: num("ANVIL_TH_MIN_RESOLVED_SHARE", 0.5),
      exampleMatch: num("ANVIL_TH_EXAMPLE_MATCH", 0.6),
      exampleMinScore: num("ANVIL_TH_EXAMPLE_MIN_SCORE", 0.85),
      lessonMatch: num("ANVIL_TH_LESSON_MATCH", 0.5),
      triggerAsked: num("ANVIL_TH_TRIGGER_ASKED", 0.5),
    },
    sourceWeights: {
      freshness: num("ANVIL_SW_FRESHNESS", 0.5),
      coverage: num("ANVIL_SW_COVERAGE", 0.7),
      browserFactor: num("ANVIL_SW_BROWSER_FACTOR", 0.9),
      textFactor: num("ANVIL_SW_TEXT_FACTOR", 0.9),
      libraryBonus: num("ANVIL_SW_LIBRARY_BONUS", 0.05),
      namedBonus: num("ANVIL_SW_NAMED_BONUS", 1),
      slowMs: num("ANVIL_SW_SLOW_MS", 8000),
      slowFactor: num("ANVIL_SW_SLOW_FACTOR", 0.7),
    },
    triggers: {
      queueMax: num("ANVIL_TRIGGER_QUEUE_MAX", 100),
      queueTtlMs: num("ANVIL_TRIGGER_QUEUE_TTL_MS", 86_400_000),
    },
    webhook: {
      auth: (["hmac", "token", "either"].includes(process.env.ANVIL_WEBHOOK_AUTH ?? "") ? process.env.ANVIL_WEBHOOK_AUTH : "either") as WebhookConfig["auth"],
      toleranceMs: num("ANVIL_WEBHOOK_TOLERANCE_MS", 300_000),
      maxBodyBytes: num("ANVIL_WEBHOOK_MAX_BODY_BYTES", 1_000_000),
      dedupeTtlMs: num("ANVIL_WEBHOOK_DEDUPE_TTL_MS", 86_400_000),
      idHeaders: (process.env.ANVIL_WEBHOOK_ID_HEADERS ?? "idempotency-key,x-anvil-delivery,x-request-id,x-github-delivery,webhook-id,x-webhook-id")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
      dedupeMax: num("ANVIL_WEBHOOK_DEDUPE_MAX", 1000),
    },
    effects: { ttlMs: num("ANVIL_EFFECTS_TTL_MS", 7 * 86_400_000), perTurnMax: num("ANVIL_EFFECTS_PER_TURN", 1) },
    stePrompts: (["error", "warning", "off"].includes(process.env.ANVIL_STE_PROMPTS ?? "") ? process.env.ANVIL_STE_PROMPTS : "error") as AnvilConfig["stePrompts"],
    sandbox: {
      mode: process.env.ANVIL_SANDBOX === "off" ? "off" : "docker",
      image: process.env.ANVIL_SANDBOX_IMAGE || "anvil-sandbox:py312",
      network: (["isolated", "allowlist", "open"].includes(process.env.ANVIL_SANDBOX_NETWORK ?? "") ? process.env.ANVIL_SANDBOX_NETWORK : "isolated") as
        "isolated" | "allowlist" | "open",
      pool: num("ANVIL_SANDBOX_POOL", 2),
      timeoutMs: num("ANVIL_SANDBOX_TIMEOUT_MS", 60_000),
      memory: process.env.ANVIL_SANDBOX_MEMORY || "512m",
      cpus: num("ANVIL_SANDBOX_CPUS", 1),
      maxOutputBytes: num("ANVIL_SANDBOX_MAX_OUTPUT", 1_000_000),
      packageIndex: process.env.ANVIL_PACKAGE_INDEX || "https://pypi.org/simple",
      vulnCheck: process.env.ANVIL_PACKAGE_VULN_CHECK === "off" ? "off" : "osv",
      packageAllow: (process.env.ANVIL_PACKAGE_ALLOW ?? "")
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
      packageDeny: (process.env.ANVIL_PACKAGE_DENY ?? "")
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean),
      gatePort: num("ANVIL_PACKAGE_GATE_PORT", 3141),
      gateBind: process.env.ANVIL_GATE_BIND || "127.0.0.1",
      gateTargetHost: process.env.ANVIL_GATE_TARGET_HOST || "host.docker.internal",
      egressMaxBody: num("ANVIL_EGRESS_MAX_BODY", 65_536),
      maxSecondsPerRun: num("ANVIL_SANDBOX_MAX_SECONDS_PER_RUN", 300),
      programCache: (process.env.ANVIL_CODE_PROGRAM_CACHE ?? "on") !== "off",
      runtime: process.env.ANVIL_SANDBOX_RUNTIME ?? "",
      gateNetwork: process.env.ANVIL_SANDBOX_GATE_NETWORK ?? "",
    },
    browserPath: process.env.ANVIL_BROWSER_PATH || undefined,
    browserWsEndpoint: process.env.ANVIL_BROWSER_WS ?? "",
    egressProxyPort: num("ANVIL_EGRESS_PROXY_PORT", 0),
    browserHeadless: (process.env.ANVIL_BROWSER_HEADLESS ?? "true") !== "false",
    browserMaxPages: num("ANVIL_BROWSER_MAX_PAGES", 3),
    browserNavTimeoutMs: num("ANVIL_BROWSER_NAV_TIMEOUT_MS", 30_000),
    browserDomainIntervalMs: num("ANVIL_BROWSER_DOMAIN_INTERVAL_MS", 1000),
    browserRespectRobots: (process.env.ANVIL_BROWSER_RESPECT_ROBOTS ?? "true") !== "false",
    searchProviders: (process.env.ANVIL_SEARCH_PROVIDERS || "openrouter,wikipedia,duckduckgo")
      .split(",")
      .map((x) => x.trim())
      .filter((x): x is "openrouter" | "wikipedia" | "duckduckgo" => ["openrouter", "wikipedia", "duckduckgo"].includes(x)),
  };
}
