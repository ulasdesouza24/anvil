import type { ChatMessage, ToolDef } from "../llm/openrouter.js";

/**
 * Context management for the tool loop of an agent (docs/HARNESS.md, section 3).
 *
 * - Below the threshold, the history only grows at the end, so the prompt
 *   cache can read the repeated prefix. No summary happens.
 * - One part above the part limit does not go into the context as raw text.
 *   The context gets a detailed summary and a pointer. The agent reads the
 *   raw part page by page with the recall tool.
 * - Above the threshold, the recent turns stay as they are when they fit in the
 *   recent-turn share. Else they get a detailed summary. Older turns get a
 *   short summary. The system message, the task, and the last message never
 *   get a summary.
 * - The call ledger keeps one line for each tool call. It never goes away.
 */

export interface ContextOptions {
  /** The context stays below this many tokens (the answer reserve is already subtracted). */
  limitTokens: number;
  recentTokens: number;
  partCapTokens: number;
}

export function contextOptions(cfg: { contextCompactAt: number; modelContextTokens: number; recentTurnShare: number; partCapShare: number }, outputReserve: number): ContextOptions {
  const threshold = Math.min(cfg.contextCompactAt, Math.floor(cfg.modelContextTokens * 0.6));
  const limitTokens = Math.max(2000, threshold - outputReserve);
  return { limitTokens, recentTokens: Math.floor(limitTokens * cfg.recentTurnShare), partCapTokens: Math.max(500, Math.floor(limitTokens * cfg.partCapShare)) };
}

export interface LedgerEntry {
  step: number;
  tool: string;
  args: unknown;
  key: string;
  status: "ok" | "error";
  digest: string;
  /** The full raw result. It stays outside the prompt. */
  raw: string;
  pages: number;
}

export type Summarize = (text: string, level: "short" | "detailed") => Promise<string>;
export type HarnessEmit = (event: string, data?: Record<string, unknown>) => void;

export function canonicalArgs(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalArgs).join(",")}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalArgs((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export const RECALL_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "recall",
    description:
      "Read a large tool result again, page by page, from the call ledger. Use it instead of calling a tool again. Give the step number from the ledger and a page number (1 is the first page). This costs nothing.",
    parameters: { type: "object", properties: { step: { type: "integer", minimum: 1 }, page: { type: "integer", minimum: 1 } }, required: ["step"], additionalProperties: false },
  },
};

const msgText = (m: ChatMessage) => `${m.content ?? ""}${m.tool_calls ? JSON.stringify(m.tool_calls) : ""}`;

export class ContextManager {
  /** Characters for one token. It starts with an estimate and calibrates from real usage. */
  charsPerToken = 3.6;
  readonly ledger: LedgerEntry[] = [];

  constructor(
    private opts: ContextOptions,
    private deps: { summarize: Summarize; emit?: HarnessEmit; toolCache?: Map<string, string> },
  ) {}

  tokensOf(text: string) {
    return Math.ceil(text.length / this.charsPerToken);
  }

  estimate(messages: ChatMessage[]) {
    return messages.reduce((a, m) => a + this.tokensOf(msgText(m)) + 4, 0);
  }

  /** Calibrates the estimate from the input tokens that the provider counted. */
  calibrate(messages: ChatMessage[], inputTokens: number) {
    if (!inputTokens) return;
    const chars = messages.reduce((a, m) => a + msgText(m).length, 0);
    const observed = chars / inputTokens;
    if (observed > 0.5 && observed < 12) this.charsPerToken = this.charsPerToken * 0.7 + observed * 0.3;
  }

  keyOf(tool: string, args: unknown) {
    return `${tool}|${canonicalArgs(args ?? null)}`;
  }

  /** The earlier result of the same call, from this run or an earlier attempt. */
  repeated(tool: string, args: unknown): { step?: number; text: string } | null {
    const key = this.keyOf(tool, args);
    const e = [...this.ledger].reverse().find((x) => x.key === key && x.status === "ok");
    if (e) return { step: e.step, text: e.raw };
    const cached = this.deps.toolCache?.get(key);
    return cached !== undefined ? { text: cached } : null;
  }

  private pageChars() {
    return Math.max(2000, Math.floor(this.opts.partCapTokens * this.charsPerToken * 0.8));
  }

  /** Records a tool result. It returns the content for the tool message. */
  async addResult(step: number, tool: string, args: unknown, raw: string, status: "ok" | "error"): Promise<string> {
    const key = this.keyOf(tool, args);
    const pages = Math.max(1, Math.ceil(raw.length / this.pageChars()));
    const entry: LedgerEntry = { step, tool, args, key, status, digest: raw.replace(/\s+/g, " ").slice(0, 160), raw, pages };
    this.ledger.push(entry);
    if (status === "ok") this.deps.toolCache?.set(key, raw);
    if (this.tokensOf(raw) <= this.opts.partCapTokens) return raw;
    // One part is too large for the context: a detailed summary and a pointer go in.
    const summary = await this.deps.summarize(raw.slice(0, this.pageChars() * 6), "detailed").catch(() => raw.slice(0, this.pageChars()));
    entry.digest = summary.replace(/\s+/g, " ").slice(0, 160);
    this.deps.emit?.("oversized_part", { step, tool, tokens: this.tokensOf(raw), pages });
    this.deps.emit?.("detailed_summary", { step, scope: "part" });
    return `[Large result: about ${this.tokensOf(raw)} tokens in ${pages} pages. This is a detailed summary. Use recall(step=${step}, page=N) to read the raw text.]\n${summary}`;
  }

  recall(step: number, page = 1): string {
    const e = this.ledger.find((x) => x.step === step);
    if (!e) return JSON.stringify({ error: `No ledger entry for step ${step}. Steps: ${this.ledger.map((x) => x.step).join(", ")}` });
    const size = this.pageChars();
    const p = Math.min(Math.max(1, page), e.pages);
    this.deps.emit?.("recall", { step, page: p });
    return `[step ${step} · ${e.tool} · page ${p} of ${e.pages}]\n${e.raw.slice((p - 1) * size, p * size)}`;
  }

  ledgerText(): string {
    return `CALL LEDGER (every tool call so far; use recall(step) instead of calling a tool again):\n${this.ledger
      .map((e) => `#${e.step} ${e.tool}(${canonicalArgs(e.args).slice(0, 160)}) → ${e.status}${e.pages > 1 ? `, ${e.pages} pages` : ""}: ${e.digest}`)
      .join("\n")}`;
  }

  /**
   * Returns messages that fit the limit. Below the limit, it returns the same
   * array (append-only). messages[0] is the system message, messages[1] the task.
   */
  async fit(messages: ChatMessage[]): Promise<ChatMessage[]> {
    if (this.estimate(messages) <= this.opts.limitTokens || messages.length <= 3) return messages;
    const head = messages.slice(0, 2);
    const last = messages[messages.length - 1];
    const body = messages.slice(2, -1);

    // Divide the body into turns. A turn starts at an assistant message and holds its tool results.
    const turns: ChatMessage[][] = [];
    for (const m of body) {
      if (m.role === "assistant" || !turns.length) turns.push([m]);
      else turns[turns.length - 1].push(m);
    }
    // The recent turns that fit in the recent-turn share stay as they are.
    const size = (t: ChatMessage[]) => t.reduce((x, m) => x + this.tokensOf(msgText(m)), 0);
    let used = this.tokensOf(msgText(last));
    let cut = turns.length;
    while (cut > 0 && used + size(turns[cut - 1]) <= this.opts.recentTokens) {
      used += size(turns[cut - 1]);
      cut--;
    }
    const join = (ms: ChatMessage[]) => ms.map((m) => `${m.role}: ${msgText(m)}`).join("\n").slice(0, 400_000);
    const out: ChatMessage[] = [...head, { role: "user", content: this.ledgerText() }];
    let recent: ChatMessage[];
    let olderTurns: ChatMessage[][];
    let newest: ChatMessage[] | null = null;
    if (cut === turns.length && turns.length) {
      // Not even the newest turn fits in the share: it gets a detailed summary.
      newest = turns[turns.length - 1];
      olderTurns = turns.slice(0, -1);
      recent = [];
    } else {
      olderTurns = turns.slice(0, cut);
      recent = turns.slice(cut).flat();
    }
    if (olderTurns.length) {
      out.push({ role: "user", content: `SUMMARY OF EARLIER STEPS (numbers, URLs and identifiers are exact):\n${await this.deps.summarize(join(olderTurns.flat()), "short")}` });
      this.deps.emit?.("compaction", { turns: olderTurns.length });
    }
    if (newest) {
      out.push({ role: "user", content: `DETAILED SUMMARY OF THE LATEST STEPS:\n${await this.deps.summarize(join(newest), "detailed")}` });
      this.deps.emit?.("detailed_summary", { scope: "recent" });
    }
    out.push(...recent);
    let lastMsg = last;
    // A tool message must follow its assistant call. When that call went into a summary, the result becomes plain text.
    if (lastMsg.role === "tool" && !recent.some((m) => m.tool_calls?.some((c) => c.id === lastMsg.tool_call_id))) {
      lastMsg = { role: "user", content: `Latest tool result (${lastMsg.name ?? "tool"}):\n${lastMsg.content ?? ""}` };
    }
    out.push(lastMsg);
    return out;
  }
}

/** A summarizer prompt that keeps the facts. */
export function summaryPrompt(level: "short" | "detailed"): string {
  return level === "short"
    ? "Summarize these agent steps in a short list. Keep every number, URL, identifier, and name exactly as written. Keep which tool calls failed and why. Do not add facts."
    : "Write a detailed summary of this content. Keep the structure, every number, URL, identifier, quote, decision, and open question exactly as written. Remove only repetition and markup. Do not add facts.";
}
