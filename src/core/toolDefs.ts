import crypto from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { CustomClassDef } from "./customClass.js";
import type { JSONSchema } from "./types.js";

/**
 * Given tools (docs/TOOLS.md). A task can come with the tools that its agent must use.
 * This module reads the common formats and makes a class draft for each tool:
 * - OpenAPI 3 (JSON or YAML): each operation becomes an http class.
 * - Function definitions: OpenAI ({type: "function", function: {...}}), Anthropic
 *   ({name, description, input_schema}), or plain ({name, description, parameters}).
 *   They become "tool" classes: a call adapter does the call.
 */

export interface GivenTool {
  /** The name that the definition gives. */
  name: string;
  description: string;
  /** JSON Schema of the arguments (an object). */
  parameters: JSONSchema;
  /** The output, when the definition gives it. */
  returns?: JSONSchema;
  sideEffects: boolean;
  /** For OpenAPI: how to call it over HTTP. */
  http?: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; path: string[]; query: string[]; headers: string[]; body: boolean };
  /** For a function: the call adapter and its endpoint or mock. */
  adapter?: string;
  endpoint?: string;
  mock?: string;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30) || "tool";

/** The class type of a tool. A short hash of its definition keeps two different tools with one name apart. */
export function toolClassType(t: GivenTool): string {
  const h = crypto.createHash("sha256").update(JSON.stringify([t.name, t.parameters, t.http ?? null, t.adapter ?? null, t.endpoint ?? null, t.mock ?? null])).digest("hex").slice(0, 6);
  return `x_tool_${slug(t.name)}_${h}`;
}

const asObject = (s: unknown): JSONSchema => (s && typeof s === "object" && !Array.isArray(s) ? (s as JSONSchema) : { type: "object", properties: {} });

/** A function definition in one of the common formats, or null. */
function fromFunction(raw: unknown): GivenTool | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const f = (o.type === "function" && o.function && typeof o.function === "object" ? o.function : o) as Record<string, unknown>;
  if (typeof f.name !== "string" || !f.name) return null;
  const parameters = asObject(f.parameters ?? f.input_schema ?? f.inputSchema);
  return {
    name: f.name,
    description: String(f.description ?? f.name),
    parameters: { type: "object", properties: {}, ...parameters },
    ...(f.returns || f.output_schema || f.outputSchema ? { returns: asObject(f.returns ?? f.output_schema ?? f.outputSchema) } : {}),
    // A function can say if it changes something. Without it, the name decides (create, update, delete, book, cancel, send…).
    sideEffects:
      typeof f.sideEffects === "boolean"
        ? f.sideEffects
        : typeof f.side_effects === "boolean"
          ? (f.side_effects as boolean)
          : /^(create|update|delete|remove|cancel|book|send|post|set|add|modify|change|transfer|pay|refund|submit|reserve|exchange|return)/i.test(f.name),
    ...(typeof f.adapter === "string" ? { adapter: f.adapter } : {}),
    ...(typeof f.endpoint === "string" ? { endpoint: f.endpoint } : {}),
    ...(typeof f.mock === "string" ? { mock: f.mock } : {}),
  };
}

/** Resolves a local $ref ("#/components/schemas/X") of an OpenAPI document, one level at a time. */
function deref(doc: Record<string, unknown>, s: unknown, depth = 0): unknown {
  if (depth > 8 || !s || typeof s !== "object") return s;
  if (Array.isArray(s)) return s.map((x) => deref(doc, x, depth + 1));
  const o = s as Record<string, unknown>;
  if (typeof o.$ref === "string" && o.$ref.startsWith("#/")) {
    const target = o.$ref
      .slice(2)
      .split("/")
      .reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), doc);
    return deref(doc, target, depth + 1);
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deref(doc, v, depth + 1)]));
}

/** The operations of an OpenAPI 3 document. */
function fromOpenApi(doc: Record<string, unknown>, baseUrl?: string): GivenTool[] {
  const servers = (doc.servers as { url?: string }[] | undefined) ?? [];
  const base = (baseUrl ?? servers[0]?.url ?? "").replace(/\/+$/, "");
  const out: GivenTool[] = [];
  for (const [p, item] of Object.entries((doc.paths as Record<string, Record<string, unknown>>) ?? {})) {
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const op = deref(doc, item?.[method]) as Record<string, unknown> | undefined;
      if (!op) continue;
      const params = [...((deref(doc, item.parameters) as unknown[]) ?? []), ...((op.parameters as unknown[]) ?? [])] as { name: string; in: string; required?: boolean; description?: string; schema?: JSONSchema }[];
      const properties: Record<string, JSONSchema> = {};
      const required: string[] = [];
      const http: NonNullable<GivenTool["http"]> = { method: method.toUpperCase() as NonNullable<GivenTool["http"]>["method"], url: `${base}${p}`, path: [], query: [], headers: [], body: false };
      for (const prm of params) {
        if (!prm?.name || !["path", "query", "header"].includes(prm.in)) continue;
        properties[prm.name] = { ...(prm.schema ?? { type: "string" }), ...(prm.description ? { description: prm.description } : {}) };
        if (prm.required || prm.in === "path") required.push(prm.name);
        (prm.in === "path" ? http.path : prm.in === "query" ? http.query : http.headers).push(prm.name);
      }
      const body = (op.requestBody as { content?: Record<string, { schema?: JSONSchema }>; required?: boolean } | undefined)?.content?.["application/json"]?.schema;
      if (body) {
        properties.body = body;
        if ((op.requestBody as { required?: boolean }).required) required.push("body");
        http.body = true;
      }
      const ok = Object.entries((op.responses as Record<string, { content?: Record<string, { schema?: JSONSchema }> }>) ?? {}).find(([code]) => /^2/.test(code))?.[1];
      const name = String(op.operationId ?? `${method}_${p}`);
      out.push({
        name,
        description: String(op.summary ?? op.description ?? `${method.toUpperCase()} ${p}`),
        parameters: { type: "object", properties, ...(required.length ? { required } : {}) },
        ...(ok?.content?.["application/json"]?.schema ? { returns: ok.content["application/json"].schema } : {}),
        sideEffects: method !== "get",
        http,
      });
    }
  }
  return out;
}

/**
 * Reads tool definitions. The input is an object or a list, or JSON or YAML text:
 * an OpenAPI document, a list of function definitions, or {"tools": [...]}.
 * An OpenAPI document can give its base URL with {"openapi": ..., "x-base-url": "..."}.
 */
export function parseToolDefinitions(input: unknown): GivenTool[] {
  let v = input;
  if (typeof v === "string") {
    const text = v.trim();
    try {
      v = JSON.parse(text);
    } catch {
      v = parseYaml(text);
    }
  }
  if (Array.isArray(v)) return v.flatMap((x) => parseToolDefinitions(x));
  if (!v || typeof v !== "object") throw new Error("Tool definitions must be an OpenAPI document, a list of function definitions, or {tools: [...]}");
  const o = v as Record<string, unknown>;
  if (typeof o.openapi === "string" || typeof o.swagger === "string") {
    if (typeof o.swagger === "string") throw new Error("Swagger 2 is not supported. Use OpenAPI 3.");
    return fromOpenApi(o, typeof o["x-base-url"] === "string" ? (o["x-base-url"] as string) : undefined);
  }
  if (Array.isArray(o.tools)) return o.tools.flatMap((x) => parseToolDefinitions(x));
  const f = fromFunction(o);
  if (f) return [f];
  throw new Error("Unknown tool definition. Give an OpenAPI 3 document or function definitions with name, description, and parameters.");
}

/** The class draft of a tool. The class library saves and checks it like other classes. */
export function toolClassDraft(t: GivenTool): Omit<CustomClassDef, "version" | "createdAt" | "approved" | "status" | "testReport" | "createdBy" | "tests"> & { tests: [] } {
  const type = toolClassType(t);
  // A required text argument cannot be empty: a call with an empty id gives an error that a step can read as a fact.
  const params = structuredClone(t.parameters) as JSONSchema & { properties?: Record<string, JSONSchema>; required?: string[] };
  for (const k of params.required ?? []) {
    const p = params.properties?.[k];
    if (p && p.type === "string" && p.minLength === undefined) p.minLength = 1;
  }
  const configSchema = { type: "object", ...params };
  const outputSchema = t.returns && t.returns.type === "object" && t.returns.properties ? t.returns : { type: "object", properties: { result: t.returns ?? {} } };
  // A tool that returns a value that is not an object gets it in "result", so later steps have a field.
  const wrap = !(t.returns && t.returns.type === "object" && t.returns.properties);
  const base = {
    type,
    title: t.name.slice(0, 60),
    category: "tool" as const,
    description: `${t.description.slice(0, 400)} (given tool "${t.name}")`.padEnd(10, "."),
    whenToUse: `Use it when the task needs the given tool "${t.name}".`,
    configSchema,
    outputSchema,
    example: {},
    sideEffects: t.sideEffects,
    secrets: [],
    tests: [] as [],
  };
  if (t.http) {
    const tpl = (k: string) => `{{config.${k}}}`;
    let url = t.http.url;
    for (const k of t.http.path) url = url.replace(`{${k}}`, tpl(k));
    return {
      ...base,
      impl: {
        kind: "http",
        request: {
          method: t.http.method,
          url,
          ...(t.http.headers.length ? { headers: Object.fromEntries(t.http.headers.map((h) => [h, tpl(h)])) } : {}),
          ...(t.http.query.length ? { query: Object.fromEntries(t.http.query.map((q) => [q, tpl(q)])) } : {}),
          ...(t.http.body ? { body: "{{config.body}}" } : {}),
        },
        ...(wrap ? { transform: "return { result: response }" } : {}),
        timeoutMs: 30_000,
      },
    };
  }
  return {
    ...base,
    impl: {
      kind: "tool",
      name: t.name,
      ...(t.adapter ? { adapter: t.adapter } : {}),
      ...(t.endpoint ? { endpoint: t.endpoint } : {}),
      ...(t.mock ? { mock: t.mock } : {}),
      wrapResult: wrap,
      timeoutMs: 30_000,
    },
  };
}
