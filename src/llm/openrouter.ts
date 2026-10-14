import type { AnvilConfig, ReasoningEffort, Tier } from "../core/config.js";
import type { Answer, JSONSchema, Question } from "../core/types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: JSONSchema };
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Tier or explicit model slug. */
  tier?: Tier;
  model?: string;
  reasoning?: ReasoningEffort;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDef[];
  toolChoice?: "auto" | "none" | "required";
  json?: { schema?: JSONSchema; name?: string; strict?: boolean } | true;
  signal?: AbortSignal;
}

export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Input tokens that the provider read from its prompt cache. */
  cachedTokens?: number;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  model: string;
  provider?: string;
  usage: CallUsage;
  latencyMs: number;
}

export interface DecideRequest {
  state: unknown;
  questions: Record<string, Question>;
  model?: string;
  signal?: AbortSignal;
}

export interface DecideResult {
  answers: Record<string, Answer>;
  model: string;
  usage: CallUsage;
  latencyMs: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryable: boolean,
  ) {
    super(message);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });

/**
 * Thin, dependency-free OpenRouter client for both halves of the brain:
 *  - System 2 (reasoning / generation): chat completions, GLM by default
 *  - System 1 (fast typed decisions): the Decisions API, Jev by default
 */
/**
 * Tracks observed provider speed and temporarily avoids providers that are
 * currently slow — self-calibrating instead of a hardcoded allow/deny list.
 */
export class ProviderHealth {
  private slowUntil = new Map<string, number>();
  private stats = new Map<string, { calls: number; tps: number; latencyMs: number }>();

  constructor(private cfg: Pick<AnvilConfig, "slowCallMs" | "minTokensPerSec" | "providerCooldownMs">) {}

  record(provider: string | undefined, outputTokens: number, latencyMs: number) {
    if (!provider) return;
    const tps = outputTokens / Math.max(0.001, latencyMs / 1000);
    const prev = this.stats.get(provider);
    const a = 0.3; // EWMA weight of the newest observation
    this.stats.set(
      provider,
      prev ? { calls: prev.calls + 1, tps: prev.tps * (1 - a) + tps * a, latencyMs: prev.latencyMs * (1 - a) + latencyMs * a } : { calls: 1, tps, latencyMs },
    );
    if (latencyMs > this.cfg.slowCallMs && tps < this.cfg.minTokensPerSec) this.slowUntil.set(provider, Date.now() + this.cfg.providerCooldownMs);
  }

  avoided(): string[] {
    const now = Date.now();
    return [...this.slowUntil.entries()].filter(([, until]) => until > now).map(([p]) => p);
  }

  snapshot() {
    return { avoided: this.avoided(), providers: Object.fromEntries(this.stats) };
  }
}

export class OpenRouterClient {
  readonly health: ProviderHealth;
  constructor(private cfg: AnvilConfig) {
    this.health = new ProviderHealth(cfg);
  }

  get config() {
    return this.cfg;
  }

  /** The time limit of a request with this token budget: the budget at the configured rate, never below requestTimeoutMs. */
  timeoutFor(maxTokens?: number): number {
    const rate = this.cfg.timeoutTokensPerSec;
    const byBudget = maxTokens && rate > 0 ? Math.ceil((maxTokens / rate) * 1000) : 0;
    return Math.max(this.cfg.requestTimeoutMs, byBudget);
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<any> {
    if (!this.cfg.apiKey)
      throw new ApiError(this.cfg.hosted ? "Add your OpenRouter key in Settings: runs use your own key." : "OPENROUTER_API_KEY is not set", 401, false);
    const maxAttempts = 4;
    const timeoutMs = this.timeoutFor((body as { max_tokens?: number }).max_tokens);
    let timeouts = 0;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      signal?.addEventListener("abort", onAbort);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, timeoutMs);
      try {
        const res = await fetch(`${this.cfg.baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.cfg.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost/anvil",
            "X-Title": "Anvil",
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await res.text();
        let data: any;
        try {
          data = JSON.parse(text);
        } catch {
          throw new ApiError(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`, res.status, res.status >= 500);
        }
        if (!res.ok || data.error) {
          const status = data?.error?.code ?? res.status;
          const msg = data?.error?.message ?? `HTTP ${res.status}`;
          const retryable = status === 429 || status === 408 || (typeof status === "number" && status >= 500);
          throw new ApiError(`${msg}`, typeof status === "number" ? status : res.status, retryable);
        }
        return data;
      } catch (e) {
        lastErr = e;
        if (signal?.aborted) throw new Error("aborted");
        // A request that hit its time limit runs again only timeoutRetries times: the same request is often slow again.
        if (timedOut) {
          lastErr = new ApiError(`The model did not answer in ${Math.round(timeoutMs / 1000)} s (time limit of the request)`, 408, true);
          if (++timeouts > this.cfg.timeoutRetries || attempt === maxAttempts) throw lastErr;
          continue;
        }
        const retryable = e instanceof ApiError ? e.retryable : true; // network / timeout errors
        if (!retryable || attempt === maxAttempts) throw e;
        await sleep(Math.min(8000, 600 * 2 ** (attempt - 1)) + Math.random() * 300, signal);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    throw lastErr;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const tier = req.tier ? this.cfg.tiers[req.tier] : undefined;
    const model = req.model ?? tier?.model ?? this.cfg.llmModel;
    let reasoning = req.reasoning ?? tier?.reasoning ?? "low";
    let maxTokens = req.maxTokens ?? tier?.maxTokens ?? 4096;
    const started = Date.now();
    const usage: CallUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, cachedTokens: 0 };

    // Reasoning is mandatory on some providers and shares the token budget with
    // the answer; if the budget is exhausted before any content, retry bigger.
    // A provider that gave an empty answer is not used again for this request.
    const emptyFrom = new Set<string>();
    let lastFinish = "unknown";
    // After an answer that used the budget for reasoning, the next attempt gives the reasoning a hard limit:
    // a share of the budget. The rest stays for the answer (a model at "low" can still think to the end).
    let reasoningCap: number | undefined;
    // Some providers do not keep the limit (a model thinks past it). The last attempt turns the reasoning off.
    let reasoningOff = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const body: Record<string, unknown> = {
        model,
        messages: req.messages,
        max_tokens: maxTokens,
        reasoning: reasoningOff ? { enabled: false } : reasoningCap ? { max_tokens: reasoningCap, exclude: true } : { effort: reasoning, exclude: true },
        usage: { include: true },
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (req.tools?.length) {
        body.tools = req.tools;
        body.tool_choice = req.toolChoice ?? "auto";
      }
      if (req.json) {
        const j = req.json === true ? {} : req.json;
        body.response_format = j.schema && j.strict ? { type: "json_schema", json_schema: { name: j.name ?? "output", strict: true, schema: j.schema } } : { type: "json_object" };
      }
      const provider: Record<string, unknown> = {};
      if (req.tools?.length || req.json) provider.require_parameters = true;
      if (this.cfg.providerSort !== "none") provider.sort = this.cfg.providerSort;
      const avoid = [...new Set([...this.health.avoided(), ...emptyFrom])];
      if (avoid.length) provider.ignore = avoid;
      if (Object.keys(provider).length) body.provider = provider;

      const callStarted = Date.now();
      const data = await this.post("/v1/chat/completions", body, req.signal);
      this.health.record(data.provider, data.usage?.completion_tokens ?? 0, Date.now() - callStarted);
      const choice = data.choices?.[0];
      usage.inputTokens += data.usage?.prompt_tokens ?? 0;
      usage.outputTokens += data.usage?.completion_tokens ?? 0;
      usage.costUsd += data.usage?.cost ?? 0;
      usage.cachedTokens = (usage.cachedTokens ?? 0) + (data.usage?.prompt_tokens_details?.cached_tokens ?? 0);
      const content: string = choice?.message?.content ?? "";
      const toolCalls: ToolCall[] = choice?.message?.tool_calls ?? [];
      const finishReason: string = choice?.finish_reason ?? "unknown";
      if ((content.trim() || toolCalls.length) && !(finishReason === "length" && req.json)) {
        return { content, toolCalls, finishReason, model: data.model ?? model, provider: data.provider, usage, latencyMs: Date.now() - started };
      }
      lastFinish = finishReason;
      if (data.provider) emptyFrom.add(String(data.provider));
      maxTokens = Math.min(maxTokens * 2, this.cfg.maxRetryTokens ?? 32_000);
      if (reasoning === "high") reasoning = "medium";
      else if (reasoning === "medium") reasoning = "low";
      if (finishReason === "length") {
        if (reasoningCap) reasoningOff = true;
        else reasoningCap = Math.max(256, Math.floor(maxTokens * this.cfg.retryReasoningShare));
      }
    }
    throw new ApiError(
      `Model ${model} returned no content after 3 attempts (finish reason "${lastFinish}"${lastFinish === "length" ? ": the token budget is used" : ""}${emptyFrom.size ? `, providers ${[...emptyFrom].join(", ")}` : ""})`,
      502,
      false,
    );
  }

  /**
   * Web search through OpenRouter's server-side search tool (Exa by default).
   * The model is only a thin driver; we return the raw cited results.
   */
  async webSearch(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ results: { title: string; url: string; snippet: string }[]; usage: CallUsage; latencyMs: number }> {
    const started = Date.now();
    const data = await this.post(
      "/v1/chat/completions",
      {
        model: this.cfg.llmModel,
        messages: [{ role: "user", content: `Run exactly one web search for the query below, then reply with the single word DONE.\n\nQUERY: ${query}` }],
        tools: [{ type: "openrouter:web_search", parameters: { engine: "exa", max_results: Math.min(10, Math.max(1, limit)) } }],
        reasoning: { effort: "low", exclude: true },
        max_tokens: 400,
        usage: { include: true },
        ...(this.cfg.providerSort !== "none" ? { provider: { sort: this.cfg.providerSort } } : {}),
      },
      signal,
    );
    const annotations = (data.choices?.[0]?.message?.annotations ?? []) as { type: string; url_citation?: { url: string; title?: string; content?: string } }[];
    const seen = new Set<string>();
    const results = annotations
      .filter((a) => a.type === "url_citation" && a.url_citation?.url)
      .map((a) => ({
        title: a.url_citation!.title ?? a.url_citation!.url,
        url: a.url_citation!.url,
        snippet: (a.url_citation!.content ?? "").replace(/\s+/g, " ").trim().slice(0, 1200),
      }))
      .filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)))
      .slice(0, limit);
    return {
      results,
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0, costUsd: data.usage?.cost ?? 0 },
      latencyMs: Date.now() - started,
    };
  }

  async decide(req: DecideRequest): Promise<DecideResult> {
    const started = Date.now();
    validateQuestions(req.questions);
    const data = await this.post("/alpha/decisions", { model: req.model ?? this.cfg.decisionModel, state: req.state, questions: req.questions }, req.signal);
    return {
      answers: data.answers ?? {},
      model: data.model ?? this.cfg.decisionModel,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
        costUsd: data.usage?.cost ?? 0,
      },
      latencyMs: Date.now() - started,
    };
  }
}

export function validateQuestions(questions: Record<string, Question>) {
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new ApiError("Decision requires at least one question", 400, false);
  for (const [id, q] of Object.entries(questions)) {
    if (!q || typeof q !== "object") throw new ApiError(`Question ${id} is not an object`, 400, false);
    if (q.type === "choice") {
      const n = Object.keys(q.criteria ?? {}).length;
      if (n < 2 || n > 255) throw new ApiError(`Choice question "${id}" needs 2-255 options (got ${n})`, 400, false);
    } else if (q.type === "score") {
      const n = q.criteria?.length ?? 0;
      if (n < 2 || n > 10) throw new ApiError(`Score question "${id}" needs 2-10 levels (got ${n})`, 400, false);
    } else if (q.type !== "noul") {
      throw new ApiError(`Question "${id}" has unknown type "${(q as { type: string }).type}"`, 400, false);
    }
  }
}
