import { Ajv, type ValidateFunction } from "ajv";
import type { AnvilConfig, Tier } from "../core/config.js";
import type { Answer, JSONSchema, Question, RunEventInput, Usage } from "../core/types.js";
import { extractJson } from "./json.js";
import type { SearchCache } from "./searchCache.js";
import { type SearchHit, webSearch as ddgSearch, wikipediaSearch } from "../core/tools/web.js";
import type { ChatMessage, ChatRequest, ChatResult, DecideRequest, DecideResult } from "./openrouter.js";

/** The minimal surface Anvil needs from a model provider (real or fake). */
export interface ModelClient {
  readonly config: AnvilConfig;
  chat(req: ChatRequest): Promise<ChatResult>;
  decide(req: DecideRequest): Promise<DecideResult>;
  webSearch?(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ results: SearchHit[]; usage: { inputTokens: number; outputTokens: number; costUsd: number }; latencyMs: number }>;
}

export interface BrainHooks {
  nodeId?: string;
  emit?: (e: RunEventInput) => void;
  addUsage?: (u: Partial<Usage>) => void;
  signal?: AbortSignal;
  /** Limits for one run. The engine creates one object for each run and shares it with all nodes. */
  budget?: RunBudget;
  /** A harness note that goes into the system message of each chat call. */
  note?: string;
  /** The harness asks for the deep model tier in this attempt. */
  deep?: boolean;
  /**
   * The model of each chat call that does not name its own model (docs/SELECTION.md): a best-of-N candidate
   * builds with its builder model. Jev decisions do not change.
   */
  model?: string;
}

/** Counters and limits that apply to one run. */
export interface RunBudget {
  /** Paid web searches (cache hits and free providers do not count). */
  paidSearches: { used: number; max: number };
}

/** Objects that all Brain instances share, for example the search cache. */
export interface BrainShared {
  searchCache?: SearchCache;
}

export type EscalatedAnswer = Answer & { escalated?: boolean; rationale?: string };

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
const validatorCache = new WeakMap<object, ValidateFunction>();

export function compileSchema(schema: JSONSchema): ValidateFunction {
  let v = validatorCache.get(schema);
  if (!v) {
    v = ajv.compile(schema);
    validatorCache.set(schema, v);
  }
  return v;
}

export function schemaErrors(schema: JSONSchema, value: unknown): string[] {
  const validate = compileSchema(schema);
  if (validate(value)) return [];
  return (validate.errors ?? [])
    .slice(0, 12)
    .map((e) => `${e.instancePath || "(root)"} ${e.message}${e.params && "allowedValues" in e.params ? ` ${JSON.stringify(e.params.allowedValues)}` : ""}`);
}

const TIERS: Tier[] = ["fast", "balanced", "deep"];

/**
 * Brain = System 1 (Jev decisions) + System 2 (LLM reasoning), bound to a run
 * context so every call is traced, costed and cancellable.
 */
export class Brain {
  constructor(
    private client: ModelClient,
    private hooks: BrainHooks = {},
    private shared: BrainShared = {},
  ) {}

  get config() {
    return this.client.config;
  }

  /** Adds usage that is not a model call (for example the time of a sandbox program) to the run. */
  recordUsage(u: Partial<Usage>) {
    this.hooks.addUsage?.(u);
  }

  with(hooks: BrainHooks): Brain {
    return new Brain(this.client, { ...this.hooks, ...hooks }, this.shared);
  }

  async chat(req: ChatRequest & { purpose: string }): Promise<ChatResult> {
    if (this.hooks.note) {
      const i = req.messages.findIndex((m) => m.role === "system");
      const messages = [...req.messages];
      if (i >= 0) messages[i] = { ...messages[i], content: `${messages[i].content ?? ""}\n\n${this.hooks.note}` };
      else messages.unshift({ role: "system", content: this.hooks.note });
      req = { ...req, messages };
    }
    if (this.hooks.deep && req.tier && req.tier !== "deep") req = { ...req, tier: "deep" };
    if (this.hooks.model && !req.model) req = { ...req, model: this.hooks.model };
    const res = await this.client.chat({ ...req, signal: req.signal ?? this.hooks.signal });
    this.hooks.addUsage?.({ llmCalls: 1, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: res.usage.costUsd });
    this.hooks.emit?.({
      type: "llm",
      nodeId: this.hooks.nodeId,
      purpose: req.purpose,
      model: res.model,
      tier: req.tier,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd: res.usage.costUsd,
      latencyMs: res.latencyMs,
      cachedTokens: res.usage.cachedTokens ?? 0,
    });
    return res;
  }

  /**
   * Structured generation: JSON mode + schema validation + self-repair.
   * `check` can add semantic validation on top of the JSON schema.
   */
  async json<T = unknown>(opts: {
    purpose: string;
    system: string;
    user: string;
    schema?: JSONSchema;
    tier?: Tier;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    maxRepairs?: number;
    history?: ChatMessage[];
    check?: (value: T) => string[] | Promise<string[]>;
  }): Promise<T> {
    const schemaText = opts.schema ? `\n\nReturn ONLY a JSON value that validates against this JSON Schema:\n${JSON.stringify(opts.schema)}` : "\n\nReturn ONLY valid JSON.";
    const messages: ChatMessage[] = [{ role: "system", content: opts.system + schemaText }, ...(opts.history ?? []), { role: "user", content: opts.user }];
    const maxRepairs = opts.maxRepairs ?? 2;
    let lastErrors: string[] = [];
    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      const res = await this.chat({
        purpose: attempt === 0 ? opts.purpose : `${opts.purpose} (repair ${attempt})`,
        messages,
        tier: opts.tier ?? "fast",
        model: opts.model,
        temperature: opts.temperature ?? 0.2,
        maxTokens: opts.maxTokens,
        json: true,
      });
      let value: unknown;
      try {
        value = extractJson(res.content);
      } catch (e) {
        lastErrors = [(e as Error).message];
        messages.push({ role: "assistant", content: res.content.slice(0, 4000) });
        messages.push({ role: "user", content: `That was not valid JSON (${lastErrors[0].slice(0, 200)}). Return only the corrected JSON.` });
        continue;
      }
      const errors = opts.schema ? schemaErrors(opts.schema, value) : [];
      if (!errors.length && opts.check) errors.push(...(await opts.check(value as T)));
      if (!errors.length) return value as T;
      lastErrors = errors;
      messages.push({ role: "assistant", content: JSON.stringify(value).slice(0, 12000) });
      messages.push({
        role: "user",
        content: `Your JSON has these problems:\n- ${errors.join("\n- ")}\nFix every problem and return the complete corrected JSON only.`,
      });
    }
    throw new Error(`${opts.purpose}: could not produce valid JSON after ${maxRepairs + 1} attempts: ${lastErrors.join("; ")}`);
  }

  /**
   * Typed decision via the System One model. With `escalate`, low-confidence
   * answers are re-decided by the reasoning model (confidence-gated routing).
   */
  async decide(opts: { purpose: string; state: unknown; questions: Record<string, Question>; escalate?: boolean; threshold?: number }): Promise<Record<string, EscalatedAnswer>> {
    const res = await this.client.decide({ state: opts.state, questions: opts.questions, signal: this.hooks.signal });
    this.hooks.addUsage?.({ decisionCalls: 1, inputTokens: res.usage.inputTokens, costUsd: res.usage.costUsd });
    const answers: Record<string, EscalatedAnswer> = { ...res.answers };
    let escalated = false;

    if (opts.escalate) {
      const threshold = opts.threshold ?? this.config.confidenceThreshold;
      for (const [id, q] of Object.entries(opts.questions)) {
        const a = answers[id];
        if (!a) continue;
        const uncertain = a.type === "noul" ? Math.abs(a.noul - 0.5) < (1 - threshold) / 2 + 0.05 : a.confidence < threshold;
        if (!uncertain) continue;
        try {
          answers[id] = await this.escalate(opts.purpose, opts.state, id, q, a);
          escalated = true;
        } catch (e) {
          this.hooks.emit?.({ type: "log", nodeId: this.hooks.nodeId, level: "warn", message: `Escalation failed for ${id}: ${(e as Error).message}` });
        }
      }
    }

    this.hooks.emit?.({
      type: "decision",
      nodeId: this.hooks.nodeId,
      purpose: opts.purpose,
      questions: opts.questions,
      answers,
      costUsd: res.usage.costUsd,
      latencyMs: res.latencyMs,
      escalated,
    });
    return answers;
  }

  private async escalate(purpose: string, state: unknown, id: string, q: Question, prior: Answer): Promise<EscalatedAnswer> {
    const stateText = typeof state === "string" ? state : JSON.stringify(state, null, 2);
    if (q.type === "choice") {
      const options = Object.keys(q.criteria);
      const out = await this.json<{ choice: string; rationale: string }>({
        purpose: `${purpose}: escalate "${id}"`,
        tier: "balanced",
        system: "You resolve an ambiguous decision carefully. Think about the state, then pick exactly one option.",
        user: `STATE:\n${stateText.slice(0, 12000)}\n\nQUESTION: ${q.instructions}\nOPTIONS:\n${options.map((o) => `- ${o}: ${q.criteria[o]}`).join("\n")}\n\nA fast classifier was unsure (${JSON.stringify((prior as { probabilities?: unknown }).probabilities)}).`,
        schema: { type: "object", properties: { choice: { type: "string", enum: options }, rationale: { type: "string" } }, required: ["choice", "rationale"] },
      });
      const probabilities = Object.fromEntries(options.map((o) => [o, o === out.choice ? 1 : 0]));
      return { type: "choice", choice: out.choice, confidence: 1, probabilities, escalated: true, rationale: out.rationale };
    }
    if (q.type === "score") {
      const out = await this.json<{ level: number; rationale: string }>({
        purpose: `${purpose}: escalate "${id}"`,
        tier: "balanced",
        system: "You resolve an ambiguous rating carefully. Pick the single best level index.",
        user: `STATE:\n${stateText.slice(0, 12000)}\n\nQUESTION: ${q.instructions}\nLEVELS:\n${q.criteria.map((c, i) => `${i}: ${c}`).join("\n")}`,
        schema: {
          type: "object",
          properties: { level: { type: "integer", minimum: 0, maximum: q.criteria.length - 1 }, rationale: { type: "string" } },
          required: ["level", "rationale"],
        },
      });
      const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === out.level ? 1 : 0]));
      return { type: "score", score: out.level, confidence: 1, probabilities, escalated: true, rationale: out.rationale };
    }
    const out = await this.json<{ answer: boolean; rationale: string }>({
      purpose: `${purpose}: escalate "${id}"`,
      tier: "balanced",
      system: "You resolve an ambiguous yes/no question carefully.",
      user: `STATE:\n${stateText.slice(0, 12000)}\n\nQUESTION: ${q.instructions}${q.criteria ? `\nYES means: ${q.criteria.true}\nNO means: ${q.criteria.false}` : ""}`,
      schema: { type: "object", properties: { answer: { type: "boolean" }, rationale: { type: "string" } }, required: ["answer", "rationale"] },
    });
    return { type: "noul", noul: out.answer ? 1 : 0, escalated: true, rationale: out.rationale };
  }

  /**
   * Web search across the configured providers (in order) until one returns
   * results. The search cache answers repeated and similar queries for free.
   * Paid searches count against the run budget. When the budget is used up,
   * only free providers run.
   */
  async webSearch(query: string, limit = 5): Promise<{ results: SearchHit[]; provider: string }> {
    const log = (message: string, level: "info" | "warn" = "info") => this.hooks.emit?.({ type: "log", nodeId: this.hooks.nodeId, level, message });
    const cache = this.shared.searchCache;
    const hit = await cache?.get(query, limit);
    if (hit) {
      log(`web search (cache hit): ${query.slice(0, 80)}`);
      return { results: hit.results, provider: `${hit.provider} (cached)` };
    }
    const budget = this.hooks.budget?.paidSearches;
    const errors: string[] = [];
    for (const provider of this.config.searchProviders) {
      try {
        let results: SearchHit[] = [];
        if (provider === "openrouter" && this.client.webSearch) {
          if (budget && budget.used >= budget.max) {
            errors.push(`openrouter: paid search budget used (${budget.max} for each run)`);
            continue;
          }
          if (budget) budget.used++;
          const r = await this.client.webSearch(query, limit, this.hooks.signal);
          this.hooks.addUsage?.({ llmCalls: 1, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costUsd: r.usage.costUsd });
          this.hooks.emit?.({
            type: "llm",
            nodeId: this.hooks.nodeId,
            purpose: `web search: ${query.slice(0, 80)}`,
            model: "openrouter:web_search",
            inputTokens: r.usage.inputTokens,
            outputTokens: r.usage.outputTokens,
            costUsd: r.usage.costUsd,
            latencyMs: r.latencyMs,
          });
          results = r.results;
        } else if (provider === "wikipedia") results = await wikipediaSearch(query, { limit, signal: this.hooks.signal });
        else if (provider === "duckduckgo") results = await ddgSearch(query, { limit, signal: this.hooks.signal });
        if (results.length) {
          await cache?.set(query, limit, results, provider);
          return { results, provider };
        }
        errors.push(`${provider}: no results`);
      } catch (e) {
        errors.push(`${provider}: ${(e as Error).message}`);
      }
    }
    log(`web search returned nothing (${errors.join("; ")})`, "warn");
    return { results: [], provider: "none" };
  }

  /**
   * Runtime model routing: Jev picks the tier for a prompt ("model": "auto").
   */
  async routeTier(purpose: string, prompt: string, hint?: string): Promise<Tier> {
    const answers = await this.decide({
      purpose: `route model: ${purpose}`,
      state: { task_purpose: hint ?? purpose, prompt_excerpt: prompt.slice(0, 3000), prompt_chars: prompt.length },
      questions: {
        tier: {
          type: "choice",
          instructions: "Which model tier should handle this prompt? Prefer the cheapest tier that will do the job well.",
          criteria: {
            fast: "Simple extraction, classification, formatting, short rewriting, or template filling.",
            balanced: "Moderate reasoning, summarizing long text, writing structured content, multi-part answers.",
            deep: "Hard multi-step reasoning, math, code generation, legal/medical nuance, or planning.",
          },
        },
      },
    });
    const a = answers.tier;
    return a?.type === "choice" && TIERS.includes(a.choice as Tier) ? (a.choice as Tier) : "balanced";
  }
}
