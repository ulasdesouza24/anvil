import { runEffect } from "../effects.js";
import { liveCacheKind, liveFetch } from "../liveFetch.js";
import type { JSONSchema } from "../types.js";
import type { NodeContext } from "../registry.js";
import { bm25, calculate, chunkDocs, type Doc, runSandboxed } from "./text.js";
import { fetchUrl } from "./web.js";

export interface AgentTool {
  name: string;
  description: string;
  parameters: JSONSchema;
  sideEffects: boolean;
  /** The shape of the return value, for programs in the sandbox (for example "{status, body}"). */
  returns: string;
  run(args: Record<string, any>, ctx: NodeContext<any>, env: { docs?: Doc[] }): Promise<unknown>;
}

const obj = (properties: Record<string, JSONSchema>, required: string[]): JSONSchema => ({ type: "object", properties, required, additionalProperties: false });

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "web_search",
    description: "Search the public web. Returns titles, URLs and snippets. Follow up with fetch_url to read a page.",
    parameters: obj({ query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 10 } }, ["query"]),
    sideEffects: false,
    returns: "a list of {title, url, snippet}",
    run: async (a, ctx) => (await ctx.brain.webSearch(String(a.query), a.limit ?? 5)).results,
  },
  {
    name: "fetch_url",
    description: "Fetch a web page or API URL and return its readable text (truncated).",
    parameters: obj({ url: { type: "string" }, maxChars: { type: "integer", minimum: 500, maximum: 40000 } }, ["url"]),
    sideEffects: false,
    returns: "{url, status, title, text, truncated}. In text, each table row is one line with the cells between |, after a header line",
    run: async (a, ctx) => {
      const r = await fetchUrl(String(a.url), { maxChars: a.maxChars ?? 8000, signal: ctx.signal, live: ctx.brain.config.live, runKind: liveCacheKind(ctx.services) });
      return { url: r.url, status: r.status, title: r.title, text: r.text, truncated: r.truncated };
    },
  },
  {
    name: "browse",
    description:
      "Open a page in a real browser that runs JavaScript. Use it when fetch_url returns little text, an empty table, or a bot block. It returns the text, the tables, and 'network': the JSON API responses that the page loaded. Use those API URLs with http_request.",
    parameters: obj({ url: { type: "string" }, waitFor: { type: "string", description: "CSS selector to wait for" } }, ["url"]),
    sideEffects: false,
    returns: "{finalUrl, status, title, blocked, text, tables (lists of rows), network (a list of {url, method, status, postData, sample})}",
    run: async (a, ctx) => {
      if (!ctx.services.browser) return { error: "The browser is not available" };
      const r = await ctx.services.browser.browse({ url: String(a.url), waitFor: a.waitFor ? String(a.waitFor) : undefined, captureNetwork: true, maxChars: 8000 }, ctx.signal);
      return {
        finalUrl: r.finalUrl,
        status: r.status,
        title: r.title,
        blocked: r.blocked,
        text: r.text,
        tables: r.tables.slice(0, 3).map((t) => t.slice(0, 40)),
        network: r.network
          .slice(0, 10)
          .map((n) => ({ url: n.url, method: n.method, status: n.status, postData: n.postData?.slice(0, 300), sample: JSON.stringify(n.sample).slice(0, 600) })),
      };
    },
  },
  {
    name: "http_request",
    description: "Make an HTTP request to a JSON/REST API. Non-GET methods may have side effects.",
    parameters: obj(
      {
        method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        url: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: {},
      },
      ["method", "url"],
    ),
    sideEffects: true,
    returns: "{status, body}. body is the parsed JSON, or the text when the answer is not JSON",
    run: async (a, ctx) => {
      const call = () =>
        liveFetch(
          String(a.url),
          {
            method: a.method,
            headers: { "Content-Type": "application/json", ...(a.headers ?? {}) },
            body: a.body === undefined || a.method === "GET" ? undefined : typeof a.body === "string" ? a.body : JSON.stringify(a.body),
            signal: ctx.signal,
            runKind: liveCacheKind(ctx.services),
          },
          ctx.brain.config.live,
        );
      // A request that is not GET can change the outside world: it runs one time for each run (docs/EFFECTS.md).
      const res = String(a.method ?? "GET").toUpperCase() === "GET" ? await call() : await runEffect(ctx, "http_request", a, call);
      const text = res.text;
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep text */
      }
      return { status: res.status, body: typeof body === "string" ? body.slice(0, 8000) : body };
    },
  },
  {
    name: "run_code",
    description:
      "Run one Python 3.12 program in a sandbox without internet. Use it for many tool calls, loops, and data processing (parse, join, count, compute). In the program: `from anvil import tools, classes, install, result`. tools.<name>(**args) calls your other tools (for example tools.fetch_url(url=...)) and returns the same value as a direct call (http_request returns {status, body}, fetch_url returns {url, status, title, text}). tools.parallel([(name, args), ...]) runs calls at the same time. classes.<x_name>(**config) calls a tested class of the library. install('pkg==1.2') installs a checked wheel. result(value) sets the only value that comes back to you. pandas, numpy, beautifulsoup4, lxml, openpyxl, python-dateutil, and pydantic are ready. Files in /work stay for the next run_code of this run.",
    parameters: obj({ code: { type: "string", description: "The Python program" } }, ["code"]),
    sideEffects: false,
    returns: "{ok, result, stdout, error, toolCalls, timedOut}",
    run: async (a, ctx, env) => {
      const { runProgram } = await import("./codeBridge.js");
      // The program can call the other tools of this agent, not run_code itself.
      const own = ((ctx.config as { tools?: string[] }).tools ?? []).concat(ctx.harness?.tools ?? []).filter((t) => t !== "run_code");
      try {
        const r = await runProgram(ctx, String(a.code), { tools: [...new Set(own)], docs: env.docs });
        return { ok: r.ok, result: r.result, stdout: r.stdout.slice(0, 4000), error: r.error, toolCalls: r.calls.length, timedOut: r.timedOut };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  },
  {
    name: "calculator",
    description: "Evaluate an arithmetic expression exactly, e.g. '(1200*0.18)+45' or 'round(sqrt(2),4)'. Always use this for math.",
    parameters: obj({ expression: { type: "string" } }, ["expression"]),
    sideEffects: false,
    returns: "{result}",
    run: async (a) => ({ result: calculate(String(a.expression)) }),
  },
  {
    name: "current_time",
    description: "Get the current date and time (ISO 8601, UTC and local).",
    parameters: obj({}, []),
    sideEffects: false,
    returns: "{iso, local}",
    run: async () => ({ iso: new Date().toISOString(), local: new Date().toString() }),
  },
  {
    name: "run_js",
    description: "Run a short JavaScript function body for data processing. Use `return` to return a JSON-serializable value. Variable `data` holds the optional data argument.",
    parameters: obj({ code: { type: "string" }, data: {} }, ["code"]),
    sideEffects: false,
    returns: "{result}",
    run: async (a) => ({ result: runSandboxed(String(a.code), { data: a.data ?? null }, 2000) }),
  },
  {
    name: "memory_get",
    description: "Read a value from the agent's persistent memory.",
    parameters: obj({ key: { type: "string" } }, ["key"]),
    sideEffects: false,
    returns: "{value}",
    run: async (a, ctx) => ({ value: (await ctx.services.kv.get(`agent:${ctx.spec.id}`, String(a.key))) ?? null }),
  },
  {
    name: "memory_set",
    description: "Store a value in the agent's persistent memory for future runs.",
    parameters: obj({ key: { type: "string" }, value: {} }, ["key", "value"]),
    sideEffects: false,
    returns: "{ok}",
    run: async (a, ctx) => {
      await ctx.services.kv.set(`agent:${ctx.spec.id}`, String(a.key), a.value);
      return { ok: true };
    },
  },
  {
    name: "call_agent",
    description: "Delegate a sub-task to another saved Anvil agent by id, passing its input object.",
    parameters: obj({ agentId: { type: "string" }, input: { type: "object" } }, ["agentId", "input"]),
    sideEffects: false,
    returns: "the output of the agent, or {error}",
    run: async (a, ctx) => {
      const r = await ctx.services.runAgent({ agentId: String(a.agentId) }, a.input ?? {}, {
        parentRunId: ctx.runId,
        depth: ctx.depth + 1,
        signal: ctx.signal,
      });
      return r.status === "completed" ? r.output : { error: r.error };
    },
  },
  {
    name: "search_documents",
    description: "Keyword-search the documents attached to this agent step. Returns the most relevant passages.",
    parameters: obj({ query: { type: "string" }, topK: { type: "integer", minimum: 1, maximum: 10 } }, ["query"]),
    sideEffects: false,
    returns: "{results: a list of {id, title, text, score}}",
    run: async (a, _ctx, env) => {
      if (!env.docs?.length) return { results: [], note: "No documents attached." };
      return { results: bm25(chunkDocs(env.docs, 900), String(a.query), a.topK ?? 4).map((d) => ({ id: d.id, title: d.title, text: d.text, score: d.score })) };
    },
  },
];

export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((t) => t.name);

export function getTool(name: string): AgentTool | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}
