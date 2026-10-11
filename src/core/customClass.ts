import { Ajv } from "ajv";
import { z } from "zod";
import { runCheck } from "../builder/evaluate.js";
import { Brain, schemaErrors } from "../llm/brain.js";
import type { NodeCategory, NodeClass, NodeContext, Registry } from "./registry.js";
import { extractRefs, resolveDeep, stringify } from "./template.js";
import { asyncCodeProblem, runSandboxed } from "./tools/text.js";
import { runEffect } from "./effects.js";
import { liveCacheKind, liveFetch } from "./liveFetch.js";
import { toolAdapter } from "./toolAdapters.js";
import { CheckZ, type CheckResult, type Diagnostic, type JSONSchema } from "./types.js";

/**
 * Custom classes: node classes defined as JSON at runtime — by the builder
 * when a task needs a capability the library lacks, or by a person. Three
 * implementation kinds cover the space without arbitrary server code:
 *
 *   http  a parameterized API call (integrations), with optional JS shaping
 *   code  deterministic JavaScript in the sandbox (transforms, formulas)
 *   llm   a reusable, schema-typed prompt "skill"
 *
 * Templates inside a class use {{config.<field>}} and {{secrets.<NAME>}}.
 * Secret values come from the environment, are never shown to models and are
 * redacted from errors.
 */

export const CUSTOM_PREFIX = "x_";
const TYPE_RE = /^x_[a-z][a-z0-9_]{1,46}$/;
const SECRET_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

const HttpImplZ = z.object({
  kind: z.literal("http"),
  request: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    url: z.string().min(8),
    headers: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.unknown()).optional(),
    body: z.unknown().optional(),
  }),
  /** JS body that receives `response` (parsed body), `status` and `config`, and returns the output. */
  transform: z.string().optional(),
  timeoutMs: z.number().int().min(500).max(60_000).default(20_000),
});

const CodeImplZ = z.object({
  kind: z.literal("code"),
  /** JS function body; variable `config` holds the resolved config. Must return the output. */
  code: z.string().min(1),
  timeoutMs: z.number().int().min(10).max(10_000).default(2000),
});

const LlmImplZ = z.object({
  kind: z.literal("llm"),
  system: z.string().optional(),
  /** Prompt template over {{config.*}}. The output must match the class outputSchema. */
  prompt: z.string().min(1),
  model: z.enum(["fast", "balanced", "deep"]).default("fast"),
});

const BrowserImplZ = z.object({
  kind: z.literal("browser"),
  /** URL template over {{config.*}}. */
  url: z.string().min(8),
  waitFor: z.string().optional(),
  /** JS body with `page` (text, tables, links, network, title) and `config`. It returns the output. */
  transform: z.string().optional(),
});

const McpImplZ = z.object({
  kind: z.literal("mcp"),
  /** Name of a connected MCP server (see the MCP hub). */
  server: z.string().min(1),
  /** Tool name on that server. */
  tool: z.string().min(1),
  /** True when the tool declares an outputSchema — the structured content is the output. */
  structured: z.boolean().default(false),
});

/** A given tool (docs/TOOLS.md): a call adapter does the call, not a URL of the class. */
const ToolImplZ = z.object({
  kind: z.literal("tool"),
  /** The name of the tool, as its definition gives it. */
  name: z.string().min(1),
  /** The call adapter: "http", "mock", or an adapter that a platform registers. Empty: ANVIL_TOOL_ADAPTER. */
  adapter: z.string().optional(),
  /** For the http adapter: the URL of the tool. Empty: ANVIL_TOOL_ENDPOINT + "/" + name. */
  endpoint: z.string().optional(),
  /** For the mock adapter: a JS body with `args` and `state` (kept for the run). It returns the result. */
  mock: z.string().optional(),
  /** The class output is {result: <the answer>}: for a tool whose answer is not an object with fields. */
  wrapResult: z.boolean().default(false),
  timeoutMs: z.number().int().min(500).max(120_000).default(30_000),
});

export const ClassTestZ = z.object({
  name: z.string(),
  config: z.record(z.string(), z.unknown()),
  checks: z.array(CheckZ).default([]),
});

export const CustomClassDefZ = z.object({
  type: z.string().regex(TYPE_RE, 'custom class types look like "x_snake_case"'),
  title: z.string().min(2),
  category: z.enum(["tool", "data", "ai"]).default("tool"),
  description: z.string().min(10),
  whenToUse: z.string().min(5),
  configSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  example: z.record(z.string(), z.unknown()).default({}),
  sideEffects: z.boolean().default(false),
  secrets: z.array(z.string().regex(SECRET_RE, "secret names are UPPER_SNAKE_CASE env vars")).default([]),
  impl: z.discriminatedUnion("kind", [HttpImplZ, CodeImplZ, LlmImplZ, McpImplZ, BrowserImplZ, ToolImplZ]),
  tests: z.array(ClassTestZ).default([]),
  // lifecycle
  version: z.number().int().min(1).default(1),
  createdBy: z.string().default("user"),
  createdAt: z.number().default(() => Date.now()),
  approved: z.boolean().default(true),
  status: z.enum(["passed", "failed", "untested"]).default("untested"),
  testReport: z
    .array(z.object({ name: z.string(), passed: z.boolean(), error: z.string().optional(), output: z.unknown().optional(), checks: z.array(z.unknown()).default([]) }))
    .default([]),
});
export type CustomClassDef = z.infer<typeof CustomClassDefZ>;

/* ------------------------------ static checks ----------------------------- */

export function validateClassDef(raw: unknown, registry: Registry): { def?: CustomClassDef; diagnostics: Diagnostic[] } {
  const diags: Diagnostic[] = [];
  const add = (message: string, path?: string, hint?: string, severity: Diagnostic["severity"] = "error") => diags.push({ severity, code: "CLASS_DEF", message, path, hint });
  const parsed = CustomClassDefZ.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) add(i.message, `/${i.path.join("/")}`);
    return { diagnostics: diags };
  }
  const def = parsed.data;
  const existing = registry.get(def.type);
  if (existing && !existing.custom) add(`"${def.type}" collides with a built-in class`, "/type");

  for (const [name, schema] of [
    ["configSchema", def.configSchema],
    ["outputSchema", def.outputSchema],
  ] as const) {
    const s = schema as JSONSchema;
    if (s.type !== "object") add(`${name}.type must be "object"`, `/${name}/type`);
    if (name === "outputSchema" && (!s.properties || !Object.keys(s.properties).length))
      add("outputSchema must declare properties so agents can reference fields", `/${name}/properties`);
    try {
      new Ajv({ strict: false, allowUnionTypes: true }).compile(s);
    } catch (e) {
      add(`${name} is not a valid JSON Schema: ${(e as Error).message}`, `/${name}`);
    }
  }
  const configProps = Object.keys((def.configSchema as JSONSchema).properties ?? {});

  // Templates may only reference declared config fields and declared secrets.
  const implTemplates =
    def.impl.kind === "http"
      ? def.impl.request
      : def.impl.kind === "llm"
        ? { system: def.impl.system, prompt: def.impl.prompt }
        : def.impl.kind === "browser"
          ? { url: def.impl.url }
          : {};
  if (def.impl.kind === "mcp" && !def.createdBy.startsWith("mcp:")) add("mcp classes are created by connecting an MCP server", "/impl");
  // Code and transforms run synchronously without the network. Async code would fail later, outside the class.
  const js = def.impl.kind === "code" ? def.impl.code : (def.impl as { transform?: unknown }).transform;
  const jsProblem = typeof js === "string" ? asyncCodeProblem(js) : null;
  if (jsProblem) add(jsProblem, def.impl.kind === "code" ? "/impl/code" : "/impl/transform", 'For a web API, use kind "http" with a transform.');
  const { refs, issues } = extractRefs(implTemplates, "/impl");
  for (const t of issues) add(t.message, t.pointer);
  for (const r of refs) {
    const first = String(r.segments[0] ?? "");
    if (r.root === "config") {
      if (!configProps.includes(first))
        add(`template {{${r.source}}} uses undeclared config field "${first}"`, r.pointer, `configSchema fields: ${configProps.join(", ") || "(none)"}`);
    } else if (r.root === "secrets") {
      if (!def.secrets.includes(first)) add(`template {{${r.source}}} uses undeclared secret "${first}"`, r.pointer, 'Add it to "secrets"');
    } else add(`template {{${r.source}}}: only config.* and secrets.* are available inside a class`, r.pointer);
  }
  if (def.impl.kind !== "http" && def.secrets.length) add("only http classes can use secrets", "/secrets");
  if (def.impl.kind === "http") {
    if (def.impl.request.method !== "GET" && !def.sideEffects) add(`${def.impl.request.method} requests change external state: set "sideEffects": true`, "/sideEffects");
    if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(def.impl.request.url.replace(/\{\{[^}]+\}\}/g, "x"))) add("url must be https (or localhost)", "/impl/request/url");
    for (const [k, v] of Object.entries(def.impl.request.headers ?? {})) {
      if (/authorization|api[-_]?key|token/i.test(k) && !/\{\{\s*secrets\./.test(v))
        add(`header "${k}" looks like a credential — use {{secrets.NAME}} instead of a literal`, `/impl/request/headers/${k}`);
    }
    if (def.impl.transform) checkJs(def.impl.transform, "/impl/transform", add);
  }
  if (def.impl.kind === "code") checkJs(def.impl.code, "/impl/code", add);
  if (def.impl.kind === "browser") {
    if (!/^https?:\/\//.test(def.impl.url.replace(/\{\{[^}]+\}\}/g, "x"))) add("url must start with http:// or https://", "/impl/url");
    if (def.impl.transform) checkJs(def.impl.transform, "/impl/transform", add);
  }
  if (!def.tests.length && !(def.impl.kind === "http" && def.sideEffects) && def.impl.kind !== "mcp") add("add at least one test", "/tests", undefined, "warning");
  for (const [i, t] of def.tests.entries()) {
    for (const e of schemaErrors(def.configSchema as JSONSchema, t.config)) add(`tests[${i}].config ${e}`, `/tests/${i}/config`);
  }
  for (const e of schemaErrors(def.configSchema as JSONSchema, def.example)) add(`example ${e}`, "/example", undefined, "warning");
  return { def, diagnostics: diags };
}

function checkJs(code: string, path: string, add: (m: string, p?: string) => void) {
  try {
    new Function(code);
  } catch (e) {
    add(`JavaScript syntax error: ${(e as Error).message}`, path);
  }
}

/* --------------------------------- runtime -------------------------------- */

const cfgAjv = new Ajv({ allErrors: true, strict: false, useDefaults: true, coerceTypes: true, allowUnionTypes: true });

function isTemplateAt(obj: unknown, instancePath: string): boolean {
  let cur: unknown = obj;
  for (const seg of instancePath.split("/").slice(1)) {
    if (cur === null || typeof cur !== "object") return false;
    cur = (cur as Record<string, unknown>)[seg.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return typeof cur === "string" && cur.includes("{{");
}

/** A Zod schema that enforces a JSON Schema via Ajv (templates tolerated statically, defaults applied). */
function zodFromJsonSchema(schema: JSONSchema) {
  const validate = cfgAjv.compile(schema);
  return z
    .record(z.string(), z.unknown())
    .transform((v) => structuredClone(v))
    .superRefine((value, ctx) => {
      if (validate(value)) return;
      for (const e of validate.errors ?? []) {
        if (isTemplateAt(value, e.instancePath)) continue;
        const path = e.instancePath.split("/").slice(1);
        ctx.addIssue({
          code: "custom",
          message: `${e.instancePath || "config"} ${e.message}`,
          path: e.keyword === "required" ? [...path, String(e.params.missingProperty)] : path,
        });
      }
    });
}

function secretsFor(def: CustomClassDef, env: Record<string, string | undefined>) {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of def.secrets) {
    const v = env[name];
    if (v) out[name] = v;
    else missing.push(name);
  }
  return { secrets: out, missing };
}

function redact(text: string, secrets: Record<string, string>) {
  let t = text;
  for (const v of Object.values(secrets)) if (v.length >= 4) t = t.split(v).join("***");
  return t;
}

/** Calls a tool on a connected MCP server (provided by the runtime's MCP hub). */
export type McpCaller = (
  server: string,
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ content?: unknown[]; structuredContent?: unknown; isError?: boolean }>;

export interface ClassRuntimeEnv {
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  mcp?: McpCaller;
  browser?: import("../runtime/browser.js").BrowserService;
  /** The kind of the run (the cache of live answers applies to evaluation runs). */
  runKind?: string;
  /** The run: mock tools keep their state for each run. */
  runId?: string;
}

/** Normalizes an MCP tool result into a node output. */
export function mcpOutput(res: { content?: unknown[]; structuredContent?: unknown; isError?: boolean }, structured: boolean): unknown {
  const content = (res.content ?? []) as { type: string; text?: string }[];
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  if (res.isError) throw new Error(`MCP tool error: ${text.slice(0, 500) || "unknown error"}`);
  if (structured && res.structuredContent && typeof res.structuredContent === "object") return res.structuredContent;
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { text, json: parsed ?? null, structured: res.structuredContent ?? null, content };
}

/** Executes a class implementation with an already-resolved config. */
export async function executeImpl(def: CustomClassDef, config: Record<string, unknown>, brain: Brain, rt: ClassRuntimeEnv = {}): Promise<unknown> {
  const impl = def.impl;
  if (impl.kind === "code") return runSandboxed(impl.code, { config }, impl.timeoutMs);
  if (impl.kind === "tool") {
    const t = brain.config.tools;
    const base = t.endpoint.replace(/\/+$/, "");
    const answer = await toolAdapter(impl.adapter || t.adapter)({
      name: impl.name,
      args: config,
      endpoint: impl.endpoint || (base ? `${base}/${encodeURIComponent(impl.name)}` : undefined),
      mock: impl.mock,
      runId: rt.runId,
      signal: rt.signal,
      timeoutMs: impl.timeoutMs,
      live: brain.config.live,
    });
    return impl.wrapResult ? { result: answer } : answer;
  }
  if (impl.kind === "browser") {
    if (!rt.browser) throw new Error("The browser is not available in this runtime");
    const url = stringify(resolveDeep(impl.url, { config }));
    const page = await rt.browser.browse({ url, waitFor: impl.waitFor, captureNetwork: true }, rt.signal);
    if (page.blocked) throw new Error(`The page is blocked: ${page.blocked.reason}`);
    return impl.transform ? runSandboxed(impl.transform, { page, config }, 2000) : page;
  }
  if (impl.kind === "mcp") {
    if (!rt.mcp) throw new Error("MCP is not available in this runtime");
    return mcpOutput(await rt.mcp(impl.server, impl.tool, config, rt.signal), impl.structured);
  }
  if (impl.kind === "llm") {
    const scope = { config };
    return brain.json({
      purpose: def.title,
      tier: impl.model,
      system: stringify(resolveDeep(impl.system ?? "You are a precise specialist. Follow the instructions exactly.", scope)),
      user: stringify(resolveDeep(impl.prompt, scope)),
      schema: def.outputSchema as JSONSchema,
    });
  }
  const { secrets, missing } = secretsFor(def, rt.env ?? process.env);
  if (missing.length) throw new Error(`Missing secret${missing.length > 1 ? "s" : ""} ${missing.join(", ")} — add ${missing.length > 1 ? "them" : "it"} to .env and restart`);
  const scope = { config, secrets };
  const req = resolveDeep(impl.request, scope) as { method: string; url: string; headers?: Record<string, string>; query?: Record<string, unknown>; body?: unknown };
  try {
    const url = new URL(req.url);
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const hasBody = req.body !== undefined && req.method !== "GET";
    // Retries, host headers, and the evaluation cache: docs/LIVE_DATA.md. A timeout says "timed out", so the harness selects the timeout strategies.
    const res = await liveFetch(
      url,
      {
        method: req.method,
        headers: {
          "User-Agent": "AnvilAgent/1.0",
          Accept: "application/json",
          ...(hasBody && typeof req.body !== "string" ? { "Content-Type": "application/json" } : {}),
          ...(req.headers ?? {}),
        },
        body: hasBody ? (typeof req.body === "string" ? req.body : JSON.stringify(req.body)) : undefined,
        timeoutMs: impl.timeoutMs,
        signal: rt.signal,
        runKind: rt.runKind,
      },
      brain.config.live,
    );
    const text = res.text;
    let response: unknown = text;
    try {
      response = JSON.parse(text);
    } catch {
      /* keep text */
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.host}: ${text.slice(0, 300)}`);
    if (impl.transform) return runSandboxed(impl.transform, { response, status: res.status, config }, 2000);
    return response;
  } catch (e) {
    throw new Error(redact((e as Error).message, secrets));
  }
}

/** The session of a conversation input ({session_id}), or undefined. */
function sessionOf(input: unknown): string | undefined {
  const s = (input as { session_id?: unknown } | null | undefined)?.session_id;
  return typeof s === "string" && s ? `session:${s}` : undefined;
}

/** Compiles a stored definition into a live node class. */
export function buildCustomClass(def: CustomClassDef): NodeClass<Record<string, unknown>> {
  return {
    type: def.type,
    title: def.title,
    category: def.category as NodeCategory,
    description: `${def.description} Output: ${JSON.stringify(Object.keys((def.outputSchema as JSONSchema).properties ?? {}))}.`,
    whenToUse: def.whenToUse,
    configSchema: zodFromJsonSchema(def.configSchema as JSONSchema) as unknown as z.ZodType<Record<string, unknown>>,
    jsonConfigSchema: def.configSchema as JSONSchema,
    example: def.example,
    sideEffects: () => def.sideEffects,
    outputSchema: () => def.outputSchema as JSONSchema,
    defaultRetry: def.impl.kind === "code" ? { maxAttempts: 1, backoffMs: 0 } : { maxAttempts: 2, backoffMs: 800 },
    custom: { kind: def.impl.kind, status: def.status, secrets: def.secrets, approved: def.approved, createdBy: def.createdBy, version: def.version },
    async execute(ctx: NodeContext<Record<string, unknown>>) {
      if (def.sideEffects && !def.approved) {
        throw new Error(`Custom class "${def.type}" has side effects and has not been approved yet — approve it in the Node Library`);
      }
      const call = () =>
        executeImpl(def, ctx.config, ctx.brain, {
          signal: ctx.signal,
          mcp: ctx.services.mcp?.call,
          browser: ctx.services.browser,
          runKind: liveCacheKind(ctx.services),
          // A conversation keeps the state of its mock tools for all its turns (each turn is a run).
          runId: sessionOf(ctx.input) ?? ctx.runId,
        });
      // A class that changes the outside world runs one time for each run (docs/EFFECTS.md).
      const output = def.sideEffects ? await runEffect(ctx, def.type, ctx.config, call) : await call();
      const errs = schemaErrors(def.outputSchema as JSONSchema, output);
      if (errs.length) ctx.log(`output does not fully match the class outputSchema: ${errs.slice(0, 3).join("; ")}`, undefined, "warn");
      return { output };
    },
  };
}

/* ---------------------------------- tests --------------------------------- */

export interface ClassTestOutcome {
  status: CustomClassDef["status"];
  report: CustomClassDef["testReport"];
  skippedReason?: string;
}

/** Runs a definition's tests for real (http classes with side effects are never auto-run). */
export async function testClassDef(def: CustomClassDef, brain: Brain, rt: ClassRuntimeEnv = {}): Promise<ClassTestOutcome> {
  if (def.impl.kind === "http" && def.sideEffects) return { status: "untested", report: [], skippedReason: "side-effecting http classes are not executed automatically" };
  if (def.impl.kind === "mcp" && (def.sideEffects || !rt.mcp)) return { status: "untested", report: [], skippedReason: "MCP tools are only tested when read-only" };
  const { missing } = secretsFor(def, rt.env ?? process.env);
  if (missing.length) return { status: "untested", report: [], skippedReason: `missing secrets: ${missing.join(", ")}` };
  if (!def.tests.length) return { status: "untested", report: [], skippedReason: "no tests" };
  const validate = cfgAjv.compile(def.configSchema as JSONSchema);
  const report: CustomClassDef["testReport"] = [];
  for (const t of def.tests) {
    const config = structuredClone(t.config);
    validate(config); // applies defaults
    try {
      const output = await executeImpl(def, config, brain, rt);
      const schemaIssues = schemaErrors(def.outputSchema as JSONSchema, output);
      const checks: CheckResult[] = t.checks.map((c) => runCheck(output, c));
      const passed = !schemaIssues.length && checks.every((c) => c.passed);
      report.push({
        name: t.name,
        passed,
        output: truncate(output),
        checks,
        error: schemaIssues.length ? `output does not match outputSchema: ${schemaIssues.join("; ")}` : undefined,
      });
    } catch (e) {
      report.push({ name: t.name, passed: false, error: (e as Error).message, checks: [] });
    }
  }
  return { status: report.every((r) => r.passed) ? "passed" : "failed", report };
}

function truncate(v: unknown): unknown {
  const s = JSON.stringify(v);
  return s && s.length > 3000 ? `${s.slice(0, 3000)}…` : v;
}

/** The authoring guide given to the model that writes custom classes. */
export const CLASS_GUIDE = `ANVIL CUSTOM CLASS FORMAT
A custom class is a reusable node type in JSON. Its fields are:
- type: "x_" and a snake_case name (for example "x_weather_forecast"). Also title, and category (tool, data, or ai).
- description (what it does) and whenToUse (when an architect must select it).
- configSchema: a JSON Schema \`{type:"object", properties:{…}, required:[…]}\`. It holds the settings that an agent sets for each node. Agents can fill them with templates.
- outputSchema: a JSON Schema \`{type:"object", properties:{…}}\`. Keep it flat and practical. Agents refer to these fields.
- example: a valid config.
- sideEffects: true when the class changes the outside world (POST, PUT, PATCH, DELETE, sending, writing).
- secrets: the names of the env vars that the class needs (for example \`["NOTION_TOKEN"]\`). Refer to them as \`{{secrets.NOTION_TOKEN}}\`. Do not put literal keys in the class.
- impl: one of these kinds:
  - \`{kind:"http", request:{method, url, headers?, query?, body?}, transform?: "JS body with response, status, config. Return the output object."}\`
    Use \`{{config.field}}\` templates in url, headers, query, and body. Put GET parameters in query. A transform changes the raw API response into the shape of outputSchema.
  - \`{kind:"code", code:"JS body with config. Return the output object."}\`. It is deterministic and has no network access.
  - \`{kind:"llm", system?, prompt:"template over {{config.*}}", model: fast|balanced|deep}\`. Anvil validates the output against outputSchema. Write the prompt in STE.
- tests: \`[{name, config, checks:[{path, op, value?}]}]\`. Write 1 to 3 realistic tests. The ops are \`exists|equals|contains|matches|type|minLength|maxLength\`.
  Each check must be true for each correct live response. Do not check values that change over time.

Use well-known, stable public APIs. Use APIs without keys when they exist. Examples: open-meteo.com, frankfurter.app, restcountries.com, the public endpoints of api.github.com, and the Wikipedia REST API.`;
