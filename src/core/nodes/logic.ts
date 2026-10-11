import { z } from "zod";
import type { NodeClass, StaticContext } from "../registry.js";
import type { JSONSchema } from "../types.js";
import { runSandboxed } from "../tools/text.js";
import { schemaErrors } from "../../llm/brain.js";
import { JsonSchemaField, ModelField, pickModel, toText } from "./common.js";

/* -------------------------------- router -------------------------------- */

const OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "in", "exists", "not_exists", "truthy", "falsy", "matches"] as const;

const RouterConfig = z.object({
  rules: z
    .array(
      z.object({
        port: z.string().regex(/^[a-z][a-z0-9_]*$/),
        when: z.object({
          left: z.unknown().describe("Template, e.g. {{nodes.score.output.total}}"),
          op: z.enum(OPS),
          right: z.unknown().optional(),
        }),
      }),
    )
    .min(1),
  default: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .default("default"),
  mode: z.enum(["first", "all"]).default("first").describe("first: only the first matching rule fires; all: every matching rule fires"),
});
type RouterConfig = z.infer<typeof RouterConfig>;

export function compare(left: unknown, op: (typeof OPS)[number], right: unknown): boolean {
  const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
  switch (op) {
    case "eq":
      return typeof left === "object" ? JSON.stringify(left) === JSON.stringify(right) : String(left) === String(right);
    case "neq":
      return !compare(left, "eq", right);
    case "gt":
      return num(left) > num(right);
    case "gte":
      return num(left) >= num(right);
    case "lt":
      return num(left) < num(right);
    case "lte":
      return num(left) <= num(right);
    case "contains":
      if (Array.isArray(left)) return left.some((x) => String(x) === String(right));
      return String(left ?? "")
        .toLowerCase()
        .includes(String(right ?? "").toLowerCase());
    case "not_contains":
      return !compare(left, "contains", right);
    case "in":
      return Array.isArray(right) ? right.map(String).includes(String(left)) : String(right ?? "").includes(String(left));
    case "exists":
      return left !== undefined && left !== null && left !== "";
    case "not_exists":
      return !compare(left, "exists", right);
    case "truthy":
      return Array.isArray(left) ? left.length > 0 : !!left && left !== "false" && left !== "0";
    case "falsy":
      return !compare(left, "truthy", right);
    case "matches":
      try {
        return new RegExp(String(right), "i").test(String(left ?? ""));
      } catch {
        return false;
      }
  }
}

export const RouterNode: NodeClass<RouterConfig> = {
  type: "router",
  title: "Router",
  category: "logic",
  description:
    "Deterministic branching on data: evaluates rules in order and fires the matching rule's port (or `default`). Ports: each rule's `port` plus the default port. Output: {matched: [ports]}.",
  whenToUse:
    "Branching on numbers, flags, or exact values that are already computed (e.g. score > 0.8, list is empty). For fuzzy/semantic branching use a decision node with `route` instead.",
  configSchema: RouterConfig,
  example: { rules: [{ port: "high", when: { left: "{{nodes.rate.output.urgency}}", op: "gte", right: 1.5 } }], default: "normal" },
  ports: (c) => [...new Set([...(c.rules ?? []).map((r) => r.port), c.default ?? "default"])],
  outputSchema: () => ({ type: "object", properties: { matched: { type: "array", items: { type: "string" } } }, required: ["matched"] }),
  async execute(ctx) {
    const c = ctx.config;
    const matched: string[] = [];
    for (const r of c.rules) {
      if (compare(r.when.left, r.when.op, r.when.right)) {
        if (!matched.includes(r.port)) matched.push(r.port);
        if (c.mode === "first") break;
      }
    }
    const ports = matched.length ? matched : [c.default];
    return { output: { matched: ports }, ports };
  },
};

/* --------------------------------- merge --------------------------------- */

const MergeConfig = z.object({
  strategy: z
    .enum(["first", "object", "array"])
    .default("first")
    .describe("first: output of the first upstream node that ran; object: {nodeId: output} of all that ran; array: list of outputs"),
});

export const MergeNode: NodeClass<z.infer<typeof MergeConfig>> = {
  type: "merge",
  title: "Merge",
  category: "logic",
  description: "Join point after branches. Runs once all incoming branches are resolved (taken or skipped) and combines the outputs of the upstream nodes that actually ran.",
  whenToUse: "After a router/decision fan-out, to continue with whichever branch executed (strategy 'first') or to combine parallel branches ('object').",
  configSchema: MergeConfig,
  example: { strategy: "first" },
  async execute(ctx) {
    const ran = ctx.upstream().filter((u) => u.status === "done");
    const s = ctx.config.strategy;
    if (s === "object") return { output: Object.fromEntries(ran.map((u) => [u.nodeId, u.output])) };
    if (s === "array") return { output: ran.map((u) => u.output) };
    return { output: ran[0]?.output ?? null };
  },
};

/* ------------------------------- transform ------------------------------- */

const TransformConfig = z.object({
  value: z.unknown().describe("Template object/array/string that reshapes upstream data"),
  schema: JsonSchemaField.optional().describe("Optional JSON schema describing the output (enables typed references downstream)"),
});

export const TransformNode: NodeClass<z.infer<typeof TransformConfig>> = {
  type: "transform",
  title: "Transform",
  category: "data",
  description:
    "Pure data mapping with templates (no LLM): build a new object/array/string from upstream outputs. Supports filters: json, length, join, upper, lower, first, last, trim, keys, string, number, and fallbacks with ??.",
  whenToUse: "Reshaping or combining data between steps, picking fields, building a payload.",
  configSchema: TransformConfig,
  example: { value: { title: "{{nodes.extract.output.title | trim}}", tagCount: "{{nodes.extract.output.tags | length}}" } },
  outputSchema: (c) => c.schema as JSONSchema | undefined,
  async execute(ctx) {
    return { output: ctx.config.value };
  },
};

/* ---------------------------------- code --------------------------------- */

/**
 * The `nodes` object seen by JavaScript: every node of the agent is present,
 * with `output: null` when it hasn't produced one (e.g. its branch was skipped)
 * — the same semantics as templates, so `nodes.x.output?.field ?? fallback` works.
 */
function nodesForCode(ctx: { spec: { nodes: { id: string }[] }; scope: { nodes?: unknown } }) {
  const done = (ctx.scope.nodes ?? {}) as Record<string, { output: unknown }>;
  return Object.fromEntries(ctx.spec.nodes.map((n) => [n.id, { output: done[n.id]?.output ?? null }]));
}

const CodeConfig = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      "JavaScript function BODY. Variables: input (agent input), nodes (same shape as templates: nodes.<id>.output.<field>). Must `return` a JSON-serializable value. No I/O, no templates inside code.",
    ),
  timeoutMs: z.number().int().min(10).max(10_000).default(2000),
  schema: JsonSchemaField.optional(),
});

export const CodeNode: NodeClass<z.infer<typeof CodeConfig>> = {
  type: "code",
  title: "Code (JS)",
  category: "data",
  description:
    "Deterministic JavaScript in a sandbox (no network, no filesystem, time-limited). Read upstream data as nodes.<id>.output.<field> and input.<field> (same paths as templates). Output: the returned value — declare `schema` so downstream nodes can reference its fields.",
  whenToUse: "Math, sorting, filtering, dedup, date handling, scoring formulas — exact computation that an LLM might get wrong.",
  configSchema: CodeConfig,
  example: { code: "const items = nodes.extract.output.items || [];\nreturn { count: items.length, top: items.slice(0, 3) };" },
  lazyFields: ["code"],
  outputSchema: (c) => c.schema as JSONSchema | undefined,
  validate: (c) => {
    try {
      new Function(c.code);
      return [];
    } catch (e) {
      return [{ message: `JavaScript syntax error: ${(e as Error).message}`, path: "/code" }];
    }
  },
  async execute(ctx) {
    const out = runSandboxed(ctx.rawConfig.code as string, { input: ctx.input, nodes: nodesForCode(ctx) }, ctx.config.timeoutMs);
    return { output: out };
  },
};

/* ----------------------------------- map --------------------------------- */

function safeOutputSchema(cls: NodeClass | undefined, config: unknown, sctx: StaticContext): JSONSchema | undefined {
  try {
    return cls?.outputSchema?.((config ?? {}) as never, sctx);
  } catch {
    return undefined;
  }
}

const MapConfig = z.object({
  items: z.unknown().describe("Template resolving to an array, e.g. {{nodes.extract.output.items}}"),
  mode: z.enum(["llm", "llm_structured", "agent", "code", "node"]).default("llm"),
  prompt: z.string().optional().describe("Per-item prompt for llm/llm_structured; use {{item}}, {{item.field}}, {{index}}"),
  system: z.string().optional(),
  schema: JsonSchemaField.optional().describe("Per-item JSON schema for mode=llm_structured"),
  agentId: z.string().optional().describe("Saved agent id to run per item for mode=agent"),
  agentInput: z.unknown().optional().describe("Per-item input object for the sub-agent (templates with {{item}})"),
  code: z.string().optional().describe("Per-item JS body for mode=code; variables: item, index, input, nodes (nodes.<id>.output…)"),
  nodeType: z.string().optional().describe("For mode=node: any library class to run per item (e.g. web_fetch, http, or a custom x_ class)"),
  nodeConfig: z.unknown().optional().describe("For mode=node: that class's config, with {{item}}/{{index}} templates"),
  model: ModelField,
  concurrency: z.number().int().min(1).max(16).default(4),
  maxItems: z.number().int().min(1).max(500).default(50),
  continueOnError: z.boolean().default(true),
});
type MapConfig = z.infer<typeof MapConfig>;

export const MapNode: NodeClass<MapConfig> = {
  type: "map",
  title: "Map (parallel)",
  category: "logic",
  description:
    "Fan-out over an array: runs an LLM prompt, structured extraction, a saved sub-agent, JS code, or ANY library node class (mode=node, e.g. a custom x_ class) for every item in parallel (bounded concurrency). Output: {results: [...], count, errors: [...]}, results aligned with items.",
  whenToUse: "Processing lists: summarize each document, score each lead, translate each string, enrich each row.",
  configSchema: MapConfig,
  example: {
    items: "{{nodes.search.output.results}}",
    mode: "llm_structured",
    prompt: "Rate relevance of this result to '{{input.topic}}':\n{{item | json}}",
    schema: { type: "object", properties: { relevance: { type: "number" }, reason: { type: "string" } }, required: ["relevance"] },
    concurrency: 4,
  },
  lazyFields: ["prompt", "system", "agentInput", "code", "nodeConfig"],
  defaultTimeoutMs: 900_000,
  outputSchema: (c, sctx) => ({
    type: "object",
    properties: {
      results: {
        type: "array",
        items:
          (c.mode === "llm_structured"
            ? (c.schema as JSONSchema)
            : c.mode === "node" && c.nodeType
              ? safeOutputSchema(sctx.registry?.get(c.nodeType), c.nodeConfig, sctx)
              : undefined) ?? {},
      },
      count: { type: "number" },
      errors: { type: "array" },
    },
    required: ["results", "count", "errors"],
  }),
  validate: (c, sctx) => {
    const issues: { message: string; path?: string }[] = [];
    if ((c.mode === "llm" || c.mode === "llm_structured") && !c.prompt) issues.push({ message: `mode=${c.mode} requires prompt`, path: "/prompt" });
    if (c.mode === "llm_structured" && !c.schema) issues.push({ message: "mode=llm_structured requires schema", path: "/schema" });
    if (c.mode === "agent" && !c.agentId) issues.push({ message: "mode=agent requires agentId", path: "/agentId" });
    if (c.mode === "code" && !c.code) issues.push({ message: "mode=code requires code", path: "/code" });
    if (c.mode === "node") {
      const cls = c.nodeType ? sctx.registry?.get(c.nodeType) : undefined;
      if (!c.nodeType) issues.push({ message: "mode=node requires nodeType", path: "/nodeType" });
      else if (sctx.registry && (!cls || cls.internal)) issues.push({ message: `nodeType "${c.nodeType}" is not a library class`, path: "/nodeType" });
      else if (cls && (["input", "output", "map", "merge", "router"].includes(cls.type) || cls.category === "human"))
        issues.push({ message: `nodeType "${c.nodeType}" cannot run per item`, path: "/nodeType" });
      else if (cls) {
        const r = (cls.configSchema as z.ZodType).safeParse(c.nodeConfig ?? {});
        if (!r.success) {
          for (const i of r.error.issues) {
            let v: unknown = c.nodeConfig;
            for (const seg of i.path) v = v && typeof v === "object" ? (v as Record<string, unknown>)[String(seg)] : undefined;
            if (typeof v === "string" && v.includes("{{")) continue;
            issues.push({ message: `nodeConfig.${i.path.join(".") || "(root)"}: ${i.message}`, path: `/nodeConfig/${i.path.join("/")}` });
          }
        }
      }
    }
    return issues;
  },
  async execute(ctx) {
    const c = ctx.config;
    const raw = c.items;
    const arr = Array.isArray(raw) ? raw : raw === null || raw === undefined || raw === "" ? [] : [raw];
    const items = arr.slice(0, c.maxItems);
    if (arr.length > c.maxItems) ctx.log(`map truncated ${arr.length} → ${c.maxItems} items`, undefined, "warn");
    const results: unknown[] = new Array(items.length).fill(null);
    const errors: { index: number; error: string }[] = [];
    const raws = ctx.rawConfig;
    let tierLabel: { tier?: "fast" | "balanced" | "deep"; model?: string } | undefined;

    const one = async (item: unknown, index: number) => {
      const scope = { item, index };
      switch (c.mode) {
        case "node": {
          const cls = ctx.services.registry.get(String(c.nodeType));
          if (!cls || cls.internal) throw new Error(`unknown nodeType ${c.nodeType}`);
          const resolved = ctx.resolve(raws.nodeConfig ?? {}, scope);
          const parsed = (cls.configSchema as z.ZodType).safeParse(resolved);
          if (!parsed.success)
            throw new Error(`item ${index}: invalid ${cls.type} config — ${parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ")}`);
          const r = await cls.execute({
            ...ctx,
            node: { ...ctx.node, id: `${ctx.node.id}_${index}`, type: cls.type },
            config: parsed.data as never,
            rawConfig: (raws.nodeConfig ?? {}) as Record<string, unknown>,
          });
          return r.output;
        }
        case "code":
          return runSandboxed(String(raws.code), { item, index, input: ctx.input, nodes: nodesForCode(ctx) }, 2000);
        case "agent": {
          const input = ctx.resolve(raws.agentInput ?? { item: "{{item}}" }, scope);
          const r = await ctx.services.runAgent({ agentId: c.agentId }, input, { parentRunId: ctx.runId, depth: ctx.depth + 1, signal: ctx.signal });
          if (r.status !== "completed") throw new Error(r.error ?? "sub-agent failed");
          return r.output;
        }
        case "llm_structured":
        case "llm": {
          const prompt = toText(ctx.resolve(raws.prompt, scope));
          const system = raws.system ? toText(ctx.resolve(raws.system, scope)) : undefined;
          if (!tierLabel) tierLabel = await pickModel(ctx, c.model, prompt);
          if (c.mode === "llm_structured") {
            return ctx.brain.json({
              purpose: `${ctx.node.name ?? ctx.node.id} [${index}]`,
              system: system ?? "You produce precise structured data.",
              user: prompt,
              schema: c.schema as JSONSchema,
              tier: tierLabel.tier,
              model: tierLabel.model,
            });
          }
          const res = await ctx.brain.chat({
            purpose: `${ctx.node.name ?? ctx.node.id} [${index}]`,
            messages: [...(system ? [{ role: "system" as const, content: system }] : []), { role: "user", content: prompt }],
            tier: tierLabel.tier,
            model: tierLabel.model,
            temperature: 0.4,
          });
          return res.content.trim();
        }
      }
    };

    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        if (ctx.signal.aborted) return;
        try {
          results[i] = await one(items[i], i);
        } catch (e) {
          errors.push({ index: i, error: (e as Error).message });
          if (!c.continueOnError) throw e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(c.concurrency, items.length) }, worker));
    if (c.mode === "llm_structured" && c.schema) {
      results.forEach((r, i) => {
        if (r !== null && schemaErrors(c.schema as JSONSchema, r).length) errors.push({ index: i, error: "result does not match schema" });
      });
    }
    return { output: { results, count: items.length, errors } };
  },
};

/* -------------------------------- subagent ------------------------------- */

const SubagentConfig = z.object({
  agentId: z.string().min(1).describe("Id of a saved agent"),
  input: z.unknown().describe("Input object for the sub-agent (templates allowed)"),
  version: z.number().int().min(1).optional(),
});

export const SubagentNode: NodeClass<z.infer<typeof SubagentConfig>> = {
  type: "subagent",
  title: "Sub-agent",
  category: "logic",
  description: "Runs another saved Anvil agent as a single step (composition). Output: that agent's output.",
  whenToUse: "Reusing an existing agent (listed under AVAILABLE AGENTS) instead of rebuilding its logic.",
  configSchema: SubagentConfig,
  example: { agentId: "company-researcher", input: { company: "{{input.company}}" } },
  defaultTimeoutMs: 0, // the sub-agent's own policy timeout applies
  outputSchema: (c, ctx) => ctx.getAgent?.(c.agentId)?.versions.at(-1)?.spec.outputSchema,
  validate: (c, ctx) => {
    if (!ctx.getAgent) return [];
    if (c.agentId === ctx.spec.id) return [{ message: "an agent cannot call itself", path: "/agentId" }];
    return ctx.getAgent(c.agentId) ? [] : [{ message: `agent "${c.agentId}" does not exist`, path: "/agentId" }];
  },
  async execute(ctx) {
    const r = await ctx.services.runAgent({ agentId: ctx.config.agentId }, ctx.config.input ?? {}, {
      version: ctx.config.version,
      parentRunId: ctx.runId,
      depth: ctx.depth + 1,
      signal: ctx.signal,
    });
    if (r.status !== "completed") throw new Error(`sub-agent ${ctx.config.agentId} failed: ${r.error}`);
    return { output: r.output };
  },
};
