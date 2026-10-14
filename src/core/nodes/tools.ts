import { dryRunOutput } from "../effects.js";
import { liveCacheKind, liveFetch } from "../liveFetch.js";
import { z } from "zod";
import type { NodeClass } from "../registry.js";
import { bm25, chunkDocs, normalizeDocs } from "../tools/text.js";
import { fetchUrl } from "../tools/web.js";

/* ---------------------------------- http --------------------------------- */

const HttpConfig = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.unknown()).optional(),
  body: z.unknown().optional(),
  timeoutMs: z.number().int().min(100).max(120_000).default(20_000),
  failOnHttpError: z.boolean().default(true),
});
type HttpConfig = z.infer<typeof HttpConfig>;

export const HttpNode: NodeClass<HttpConfig> = {
  type: "http",
  title: "HTTP Request",
  category: "tool",
  description: "Call a REST/JSON API. Output: {status, ok, headers, body} (body parsed as JSON when possible). Non-GET requests are flagged as side effects.",
  whenToUse: "Fetching data from a known API endpoint, posting results to a webhook (Slack, Zapier, your backend).",
  configSchema: HttpConfig,
  example: { method: "GET", url: "https://api.github.com/repos/{{input.repo}}", headers: { Accept: "application/json" } },
  sideEffects: (c) => (c.method ?? "GET") !== "GET",
  defaultRetry: { maxAttempts: 2, backoffMs: 1000 },
  outputSchema: () => ({
    type: "object",
    properties: { status: { type: "number" }, ok: { type: "boolean" }, headers: { type: "object" }, body: {} },
    required: ["status", "ok", "body"],
  }),
  async execute(ctx) {
    const c = ctx.config;
    const url = new URL(String(c.url));
    if (ctx.services.dryRun && c.method !== "GET") {
      // A dry run of the editor (docs/WORKFLOW_EDITOR.md): a request that changes something does not go out.
      ctx.log(`${c.method} ${url.host}: dry run, the request did not go out`, undefined, "warn");
      return { output: { status: 0, ok: true, headers: {}, body: dryRunOutput("http", { method: c.method, url: url.toString(), body: c.body }) } };
    }
    for (const [k, v] of Object.entries(c.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const hasBody = c.body !== undefined && c.method !== "GET";
    const res = await liveFetch(
      url,
      {
        method: c.method,
        headers: { ...(hasBody && typeof c.body !== "string" ? { "Content-Type": "application/json" } : {}), "User-Agent": "AnvilAgent/1.0", ...(c.headers ?? {}) },
        body: hasBody ? (typeof c.body === "string" ? c.body : JSON.stringify(c.body)) : undefined,
        timeoutMs: c.timeoutMs,
        signal: ctx.signal,
        runKind: liveCacheKind(ctx.services),
      },
      ctx.brain.config.live,
    );
    let body: unknown = res.text;
    try {
      body = JSON.parse(res.text);
    } catch {
      body = res.text.length > 50_000 ? `${res.text.slice(0, 50_000)}…` : res.text;
    }
    if (!res.ok && c.failOnHttpError) throw new Error(`HTTP ${res.status} from ${url.host}: ${String(typeof body === "string" ? body : JSON.stringify(body)).slice(0, 300)}`);
    return { output: { status: res.status, ok: res.ok, headers: res.headers, body } };
  },
};

/* -------------------------------- web_fetch ------------------------------- */

const WebFetchConfig = z.object({
  url: z.string().min(1),
  maxChars: z.number().int().min(500).max(100_000).default(15_000),
});

export const WebFetchNode: NodeClass<z.infer<typeof WebFetchConfig>> = {
  type: "web_fetch",
  title: "Web Page → Text",
  category: "tool",
  description:
    "Download a web page and extract readable text. Output: {url, status, title, text, links, truncated, tables}. In text, each table row is one line with the cells between \"|\". tables is a list of {columns, rows, totalRows}: each row is a record with the column names. Read table data from tables, not from text.",
  whenToUse: "Reading a specific URL (article, docs page, product page) before summarizing or extracting from it.",
  configSchema: WebFetchConfig,
  example: { url: "{{input.url}}", maxChars: 15000 },
  defaultRetry: { maxAttempts: 2, backoffMs: 1000 },
  outputSchema: () => ({
    type: "object",
    properties: {
      tables: { type: "array", items: { type: "object", properties: { columns: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "object" } }, totalRows: { type: "number" } } } },
      url: { type: "string" },
      status: { type: "number" },
      title: { type: "string" },
      text: { type: "string" },
      links: { type: "array" },
      truncated: { type: "boolean" },
    },
    required: ["url", "status", "title", "text", "links", "truncated"],
  }),
  async execute(ctx) {
    return { output: await fetchUrl(String(ctx.config.url), { maxChars: ctx.config.maxChars, signal: ctx.signal, live: ctx.brain.config.live, runKind: liveCacheKind(ctx.services) }) };
  },
};

/* ------------------------------- web_search ------------------------------- */

const WebSearchConfig = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).default(5),
});

export const WebSearchNode: NodeClass<z.infer<typeof WebSearchConfig>> = {
  type: "web_search",
  title: "Web Search",
  category: "tool",
  description:
    "Web search (OpenRouter/Exa, with Wikipedia and DuckDuckGo fallbacks). Output: {results: [{title, url, snippet}], count}. Snippets are often rich enough to answer from directly; use web_fetch to read a full page.",
  whenToUse: "Finding sources about a topic, company or person when you don't already have a URL.",
  configSchema: WebSearchConfig,
  example: { query: "{{input.company}} official site", limit: 5 },
  defaultRetry: { maxAttempts: 2, backoffMs: 1500 },
  outputSchema: () => ({
    type: "object",
    properties: {
      results: { type: "array", items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" }, snippet: { type: "string" } } } },
      count: { type: "number" },
      provider: { type: "string" },
    },
    required: ["results", "count"],
  }),
  async execute(ctx) {
    const { results, provider } = await ctx.brain.webSearch(String(ctx.config.query), ctx.config.limit);
    return { output: { results, count: results.length, provider } };
  },
};

/* ----------------------------- knowledge_search --------------------------- */

const KnowledgeConfig = z.object({
  query: z.string().min(1),
  documents: z.unknown().describe("string | string[] | {id,title,text}[] — usually a template to input or upstream data"),
  topK: z.number().int().min(1).max(20).default(5),
  chunkSize: z.number().int().min(200).max(4000).default(900),
});

export const KnowledgeSearchNode: NodeClass<z.infer<typeof KnowledgeConfig>> = {
  type: "knowledge_search",
  title: "Knowledge Search (BM25)",
  category: "data",
  description:
    "Retrieval over provided documents: chunks them and ranks passages with BM25. Output: {results: [{id,title,text,score}], context} where context is the top passages joined for a prompt.",
  whenToUse: "Question answering or drafting grounded in a policy, FAQ, contract or knowledge base passed in the input (RAG).",
  configSchema: KnowledgeConfig,
  example: { query: "{{input.question}}", documents: "{{input.knowledge_base}}", topK: 4 },
  outputSchema: () => ({ type: "object", properties: { results: { type: "array" }, context: { type: "string" } }, required: ["results", "context"] }),
  async execute(ctx) {
    const docs = chunkDocs(normalizeDocs(ctx.config.documents), ctx.config.chunkSize);
    const results = bm25(docs, String(ctx.config.query), ctx.config.topK);
    const picked = results.length ? results : docs.slice(0, ctx.config.topK).map((d) => ({ ...d, score: 0 }));
    const context = picked.map((r, i) => `[${i + 1}] ${r.title ? `${r.title}: ` : ""}${r.text}`).join("\n\n");
    return { output: { results: picked, context } };
  },
};

/* ---------------------------------- memory -------------------------------- */

const MemoryConfig = z.object({
  op: z.enum(["get", "set", "append", "delete", "list"]),
  key: z.string().optional(),
  value: z.unknown().optional(),
  namespace: z.string().optional().describe("Defaults to the agent id"),
  maxItems: z.number().int().min(1).max(1000).default(100).describe("For append: keep the last N items"),
});

export const MemoryNode: NodeClass<z.infer<typeof MemoryConfig>> = {
  type: "memory",
  title: "Memory (KV)",
  category: "data",
  description: "Persistent key-value memory that survives across runs. get → {value}; set/append → {value}; list → {entries}. append keeps a rolling list.",
  whenToUse: "Remembering user preferences, previous answers, seen items (dedup), or conversation history between runs.",
  configSchema: MemoryConfig,
  example: { op: "append", key: "history", value: { q: "{{input.question}}", a: "{{nodes.answer.output.text}}" }, maxItems: 20 },
  outputSchema: () => ({ type: "object", properties: { value: {}, entries: { type: "object" } } }),
  validate: (c) => (c.op !== "list" && !c.key ? [{ message: `op=${c.op} requires key`, path: "/key" }] : []),
  async execute(ctx) {
    const c = ctx.config;
    const ns = c.namespace || `agent:${ctx.spec.id}`;
    const kv = ctx.services.kv;
    switch (c.op) {
      case "get":
        return { output: { value: (await kv.get(ns, c.key!)) ?? null } };
      case "set":
        await kv.set(ns, c.key!, c.value);
        return { output: { value: c.value } };
      case "append": {
        const cur = await kv.get(ns, c.key!);
        const list = [...(Array.isArray(cur) ? cur : cur === undefined || cur === null ? [] : [cur]), c.value].slice(-c.maxItems);
        await kv.set(ns, c.key!, list);
        return { output: { value: list } };
      }
      case "delete":
        await kv.delete(ns, c.key!);
        return { output: { value: null } };
      case "list":
        return { output: { entries: await kv.list(ns) } };
    }
  },
};

/* --------------------------------- browser -------------------------------- */

const ActionZ = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), selector: z.string() }),
  z.object({ type: z.literal("fill"), selector: z.string(), value: z.string() }),
  z.object({ type: z.literal("press"), key: z.string(), selector: z.string().optional() }),
  z.object({ type: z.literal("wait"), ms: z.number().int().min(0).max(15_000).optional(), selector: z.string().optional() }),
  z.object({ type: z.literal("scroll"), times: z.number().int().min(1).max(20).optional() }),
]);

const BrowserConfig = z.object({
  url: z.string().min(1),
  waitFor: z.string().optional().describe("CSS selector to wait for before reading the page"),
  waitMs: z.number().int().min(0).max(15_000).optional(),
  actions: z.array(ActionZ).max(20).optional().describe("Steps to do on the page before reading it (click, fill, press, wait, scroll)"),
  captureNetwork: z.boolean().default(true).describe("Record the JSON responses that the page loads (the API of the site)"),
  maxChars: z.number().int().min(500).max(100_000).default(20_000),
});

export const BrowserNode: NodeClass<z.infer<typeof BrowserConfig>> = {
  type: "browser",
  title: "Browser (JavaScript page)",
  category: "tool",
  description:
    "Opens a page in a headless browser, runs its JavaScript, and reads it. Output: {finalUrl, status, title, text, tables (rows of cells), links, network (JSON responses that the page loaded: url, method, status, sample), blocked (null, or the reason when a CAPTCHA, a bot check or robots.txt stops it)}.",
  whenToUse:
    "Pages that need JavaScript (single-page apps, dashboards, data tables that load with scripts) or sites that block simple HTTP requests. Use network to find the API that the site calls. Prefer web_fetch for static pages, because it is cheaper.",
  configSchema: BrowserConfig,
  example: { url: "{{input.url}}", waitFor: "table", captureNetwork: true },
  sideEffects: (c) => (c.actions ?? []).some((a) => a.type === "fill" || a.type === "press"),
  defaultRetry: { maxAttempts: 2, backoffMs: 1500 },
  defaultTimeoutMs: 120_000,
  outputSchema: () => ({
    type: "object",
    properties: {
      url: { type: "string" },
      finalUrl: { type: "string" },
      status: { type: "number" },
      title: { type: "string" },
      text: { type: "string" },
      truncated: { type: "boolean" },
      tables: { type: "array" },
      links: { type: "array" },
      network: { type: "array", items: { type: "object", properties: { url: { type: "string" }, method: { type: "string" }, status: { type: "number" }, sample: {} } } },
      blocked: {},
      durationMs: { type: "number" },
    },
    required: ["finalUrl", "status", "title", "text", "tables", "links", "network", "blocked"],
  }),
  async execute(ctx) {
    if (!ctx.services.browser) throw new Error("The browser is not available in this runtime");
    const c = ctx.config;
    let actions = c.actions;
    if (ctx.services.dryRun && actions?.some((a) => a.type === "fill" || a.type === "press")) {
      // A dry run of the editor (docs/WORKFLOW_EDITOR.md): the page opens, but no form gets data.
      actions = actions.filter((a) => a.type !== "fill" && a.type !== "press");
      ctx.log("dry run: the browser did not do the fill and press actions", undefined, "warn");
    }
    const r = await ctx.services.browser.browse(
      { url: String(c.url), waitFor: c.waitFor, waitMs: c.waitMs, actions, captureNetwork: c.captureNetwork, maxChars: c.maxChars },
      ctx.signal,
    );
    if (r.blocked) ctx.log(`page blocked: ${r.blocked.reason}`, { url: c.url }, "warn");
    return { output: r };
  },
};

/* ---------------------------------- file ---------------------------------- */

const FileConfig = z.object({
  fileId: z.string().regex(/^f_[a-z0-9]{8,24}$/).describe("The id of an attached file (from the build or from /api/files)"),
});

/**
 * A reference file of the agent (docs/FILES.md): for example a price list, a policy, or a
 * template that the agent reads in each run. The content comes from the attached file.
 */
export const FileNode: NodeClass<z.infer<typeof FileConfig>> = {
  type: "file",
  title: "Attached file",
  category: "data",
  description:
    "Reads an attached file. Output: {fileId, name, kind, text, sheets, data, pages, note}. For a table, sheets is a list of {name, columns, rows, totalRows}. For JSON, data is the parsed value.",
  whenToUse: "The agent needs the content of a file that the person attached as reference material (a price list, a policy, a template, a list of codes).",
  configSchema: FileConfig,
  example: { fileId: "f_0123456789abcdef" },
  outputSchema: () => ({
    type: "object",
    properties: {
      fileId: { type: "string" },
      name: { type: "string" },
      kind: { type: "string" },
      text: { type: "string" },
      sheets: { type: "array" },
      data: {},
      pages: { type: "number" },
      note: { type: "string" },
    },
    required: ["fileId", "name", "kind", "text"],
  }),
  async execute(ctx) {
    const f = ctx.services.files?.value(ctx.config.fileId);
    if (!f) throw new Error(`The attached file "${ctx.config.fileId}" does not exist. Attach it again and rebuild the agent.`);
    return { output: f };
  },
};
