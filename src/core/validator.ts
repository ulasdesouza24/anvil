import type { z } from "zod";
import { schemaErrors } from "../llm/brain.js";
import { ancestors, buildGraph, canReach, reachableFrom, topoSort } from "./graph.js";
import { configKeysOf, type Registry, type StaticContext } from "./registry.js";
import { isValidTimezone, parseCron, parseEvery } from "./schedule.js";
import { steFails, steLint, steSummary } from "./ste.js";
import { asyncCodeProblem } from "./tools/text.js";

/** Node types and agent tools that reach the web: a closed build cannot use them (docs/TOOLS.md). */
export const CLOSED_NETWORK_NODES = ["web_search", "web_fetch", "browser", "http", "send_slack", "send_email", "send_webhook"];
export const CLOSED_NETWORK_TOOLS = ["web_search", "fetch_url", "browse", "http_request"];
import { specRules } from "./actionGate.js";
import { missingNamedUrls, missingPlannedSources, type PlannedSources } from "./urls.js";
import { extractRefs, getPath, parseDotPath } from "./template.js";
import { AgentSpecZ, type AgentSpec, type Diagnostic, type JSONSchema, type StoredAgent } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  errors: number;
  warnings: number;
  diagnostics: Diagnostic[];
  spec?: AgentSpec;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export function closest(word: string, options: string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const o of options) {
    const d = levenshtein(word.toLowerCase(), o.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

function zodPath(path: PropertyKey[]): string {
  return path.length ? `/${path.map(String).join("/")}` : "";
}

function pointerGet(obj: unknown, pointer: string): unknown {
  if (!pointer) return obj;
  return getPath(
    obj,
    pointer
      .slice(1)
      .split("/")
      .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~")),
  );
}

/**
 * The known shape of the agent output: the fields of the output node value,
 * with their types from spec.outputSchema. Returns undefined when the shape is not known.
 */
export function agentOutputSchema(spec: AgentSpec): JSONSchema | undefined {
  const declared = (spec.outputSchema as JSONSchema | undefined)?.properties ?? {};
  const keys = new Set<string>();
  let objectValue = false;
  for (const n of Array.isArray(spec.nodes) ? spec.nodes : []) {
    if (n?.type !== "output") continue;
    const v = (n.config as { value?: unknown } | undefined)?.value;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      objectValue = true;
      Object.keys(v).forEach((k) => keys.add(k));
    } else return Object.keys(declared).length ? (spec.outputSchema as JSONSchema) : undefined;
  }
  if (!objectValue) return undefined;
  return { type: "object", properties: Object.fromEntries([...keys].map((k) => [k, (declared[k] as JSONSchema | undefined) ?? {}])) };
}

/** The problem of a check path against the known output shape, or null when the path can exist. */
export function checkPathProblem(shape: JSONSchema | undefined, path: string): string | null {
  if (!shape || !path) return null;
  let segs: (string | number)[];
  try {
    segs = parseDotPath(path);
  } catch {
    return `"${path}" is not a valid path`;
  }
  const r = schemaAt(shape, segs);
  return r.ok ? null : `"${path}" is not in the agent output${r.available?.length ? ` (fields there: ${r.available.join(", ")})` : ""}`;
}

/** Walk a JSON schema along a field path. Returns undefined when the path is unknown. */
export function schemaAt(schema: JSONSchema | undefined, path: (string | number)[]): { ok: boolean; available?: string[] } {
  let cur: JSONSchema | undefined = schema;
  for (const seg of path) {
    if (!cur || typeof cur !== "object") return { ok: true };
    if (cur.anyOf || cur.oneOf || cur.allOf) return { ok: true };
    const t = cur.type;
    if (typeof seg === "number" || (t === "array" && /^\d+$/.test(String(seg)))) {
      if (t && t !== "array" && !(Array.isArray(t) && t.includes("array"))) return { ok: false, available: [] };
      cur = cur.items as JSONSchema | undefined;
      continue;
    }
    if (seg === "length" && (t === "array" || t === "string")) return { ok: true };
    const props = cur.properties;
    if (!props || !Object.keys(props).length) return { ok: true };
    if (!(String(seg) in props)) {
      if (cur.additionalProperties) return { ok: true };
      return { ok: false, available: Object.keys(props) };
    }
    cur = props[String(seg)];
  }
  return { ok: true };
}

export interface ValidateOptions {
  getAgent?: (id: string) => StoredAgent | undefined;
  allowInternal?: boolean;
  /** The severity of STE_PROMPT diagnostics. The builder uses "error" in its repair loop. */
  ste?: "error" | "warning" | "off";
  /** The STE limit for prompt fields: violations for each 100 words. */
  steMaxPer100w?: number;
  /** The request of the person. When not set, spec.meta.request applies. */
  request?: string;
  /** The severity of NAMED_SOURCE diagnostics: a URL that the request names and that no node uses. */
  namedSources?: "error" | "warning" | "off";
  /** The tested source plan. When not set, spec.meta.plan.sourcePlan applies. */
  sourcePlan?: PlannedSources;
  /** The severity of PLANNED_SOURCE diagnostics: a data need whose tested source no node uses. */
  plannedSources?: "error" | "warning" | "off";
  /** The given tools of a closed build (docs/TOOLS.md). When not set, spec.meta.givenTools applies. */
  givenTools?: string[];
  /** No person approves or answers: human steps are errors. */
  unattended?: boolean;
  /** The attached files of the task and their roles (docs/FILES.md). When not set, spec.meta.taskSpec.files applies. */
  files?: { id: string; name: string; role: string }[];
}

/** Config keys that hold text for a model: prompts, tasks, criteria, and Jev questions. */
const PROMPT_KEYS = new Set(["system", "prompt", "task", "instructions", "criteria", "criterion", "question", "goal"]);
/** Config keys that never hold prompt text. */
const NON_PROMPT_KEYS = new Set(["code", "value", "schema", "outputSchema", "headers", "body", "url", "query", "items", "documents", "input", "args", "transform"]);

/** The prompt text of a config, with its JSON pointer. Templates become one word, so they do not count as text. */
export function promptFields(config: unknown, base: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const clean = (t: string) => t.replace(/\{\{[\s\S]*?\}\}/g, "DATA");
  const walk = (v: unknown, path: string, key: string | null, inPrompt: boolean) => {
    if (typeof v === "string") {
      if (inPrompt) out.push({ path, text: clean(v) });
      return;
    }
    if (Array.isArray(v)) {
      if (inPrompt && v.every((x) => typeof x === "string")) out.push({ path, text: v.map((x) => clean(x as string)).join("\n\n") });
      else v.forEach((x, i) => walk(x, `${path}/${i}`, key, inPrompt));
      return;
    }
    if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        if (NON_PROMPT_KEYS.has(k)) continue;
        // The criteria of a Jev question are a map from an option to its description.
        walk(x, `${path}/${k}`, k, inPrompt || PROMPT_KEYS.has(k));
      }
  };
  walk(config, base, null, false);
  return out;
}

export function validateSpec(raw: unknown, registry: Registry, opts: ValidateOptions = {}): ValidationResult {
  const diags: Diagnostic[] = [];
  const add = (d: Diagnostic) => diags.push(d);
  const finish = (spec?: AgentSpec): ValidationResult => {
    const errors = diags.filter((d) => d.severity === "error").length;
    return { valid: errors === 0, errors, warnings: diags.filter((d) => d.severity === "warning").length, diagnostics: diags, spec };
  };

  const parsed = AgentSpecZ.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) add({ severity: "error", code: "SCHEMA", message: issue.message, path: zodPath(issue.path) });
    // Without a structurally valid node list nothing else can be checked.
    const r = raw as { nodes?: unknown };
    if (!raw || typeof raw !== "object" || !Array.isArray(r.nodes)) return finish();
  }
  const spec = (parsed.success ? parsed.data : raw) as AgentSpec;
  const nodes = Array.isArray(spec.nodes) ? spec.nodes.filter((n) => n && typeof n === "object" && typeof n.id === "string") : [];
  const edges = Array.isArray(spec.edges) ? spec.edges.filter((e) => e && typeof e === "object") : [];
  const nodeIndex = new Map<string, number>();
  const staticCtx: StaticContext = { spec, getAgent: opts.getAgent, registry };

  /* ---- nodes ---- */
  nodes.forEach((n, i) => {
    if (nodeIndex.has(n.id)) add({ severity: "error", code: "DUPLICATE_NODE_ID", message: `Duplicate node id "${n.id}"`, path: `/nodes/${i}/id`, nodeId: n.id });
    else nodeIndex.set(n.id, i);
  });
  const knownTypes = registry.types({ includeInternal: opts.allowInternal });
  const parsedConfigs = new Map<string, Record<string, unknown>>();

  nodes.forEach((n, i) => {
    const cls = registry.get(n.type);
    if (!cls || (cls.internal && !opts.allowInternal)) {
      const guess = closest(n.type, knownTypes);
      add({
        severity: "error",
        code: "UNKNOWN_NODE_TYPE",
        message: `Unknown node type "${n.type}"`,
        path: `/nodes/${i}/type`,
        nodeId: n.id,
        hint: guess ? `Did you mean "${guess}"?` : `Available: ${knownTypes.join(", ")}`,
      });
      return;
    }
    const config = (n.config ?? {}) as Record<string, unknown>;
    const allowed = n.type === "input" ? undefined : configKeysOf(cls);
    if (allowed) {
      for (const key of Object.keys(config)) {
        if (!allowed.includes(key)) {
          const guess = closest(key, allowed);
          add({
            severity: "warning",
            code: "UNKNOWN_CONFIG_KEY",
            message: `${n.id}: config key "${key}" is not used by "${n.type}" and will be ignored`,
            path: `/nodes/${i}/config/${key}`,
            nodeId: n.id,
            hint: guess ? `Did you mean "${guess}"?` : `Known keys: ${allowed.join(", ")}`,
          });
        }
      }
    }
    const r = (cls.configSchema as z.ZodType).safeParse(config);
    if (r.success) parsedConfigs.set(n.id, r.data as Record<string, unknown>);
    else {
      let real = 0;
      for (const issue of r.error.issues) {
        const ptr = zodPath(issue.path);
        const val = pointerGet(config, ptr);
        // Templates are typed at runtime; a template where a number/array is expected is fine.
        if (typeof val === "string" && val.includes("{{") && issue.code === "invalid_type") continue;
        real++;
        add({
          severity: "error",
          code: "INVALID_CONFIG",
          message: `${n.id}: ${ptr || "config"} — ${issue.message}`,
          path: `/nodes/${i}/config${ptr}`,
          nodeId: n.id,
          hint: `See the "${n.type}" config schema.`,
        });
      }
      if (!real) parsedConfigs.set(n.id, config);
    }
    const cfg = parsedConfigs.get(n.id);
    if (cfg && cls.validate) {
      try {
        for (const issue of cls.validate(cfg as never, staticCtx)) {
          add({
            severity: issue.severity ?? "error",
            code: "INVALID_CONFIG",
            message: `${n.id}: ${issue.message}`,
            path: `/nodes/${i}/config${issue.path ?? ""}`,
            nodeId: n.id,
            hint: issue.hint,
          });
        }
      } catch (e) {
        add({ severity: "error", code: "INVALID_CONFIG", message: `${n.id}: ${(e as Error).message}`, path: `/nodes/${i}/config`, nodeId: n.id });
      }
    }
  });

  /* ---- entry / exit ---- */
  const inputs = nodes.filter((n) => n.type === "input");
  const outputs = nodes.filter((n) => n.type === "output");
  if (inputs.length !== 1)
    add({ severity: "error", code: inputs.length ? "MULTIPLE_INPUT_NODES" : "NO_INPUT_NODE", message: `An agent needs exactly one "input" node (found ${inputs.length})` });
  if (!outputs.length) add({ severity: "error", code: "NO_OUTPUT_NODE", message: 'An agent needs at least one "output" node' });
  for (const n of [...inputs, ...outputs])
    if (n.disabled)
      add({
        severity: "error",
        code: "DISABLED_IO",
        message: `The ${n.type} node "${n.id}" cannot be disabled`,
        path: `/nodes/${nodeIndex.get(n.id)}/disabled`,
        nodeId: n.id,
      });
  if (spec.inputSchema && (spec.inputSchema as JSONSchema).type !== "object")
    add({ severity: "error", code: "INPUT_SCHEMA", message: 'inputSchema.type must be "object"', path: "/inputSchema/type" });

  /* ---- edges ---- */
  const seenEdges = new Set<string>();
  edges.forEach((e, i) => {
    const port = e.port ?? "out";
    const key = `${e.from}:${port}->${e.to}`;
    if (seenEdges.has(key)) add({ severity: "warning", code: "DUPLICATE_EDGE", message: `Duplicate edge ${key}`, path: `/edges/${i}` });
    seenEdges.add(key);
    if (!nodeIndex.has(e.from))
      add({
        severity: "error",
        code: "EDGE_UNKNOWN_NODE",
        message: `Edge from unknown node "${e.from}"`,
        path: `/edges/${i}/from`,
        hint: closest(e.from, [...nodeIndex.keys()]) ? `Did you mean "${closest(e.from, [...nodeIndex.keys()])}"?` : undefined,
      });
    if (!nodeIndex.has(e.to))
      add({
        severity: "error",
        code: "EDGE_UNKNOWN_NODE",
        message: `Edge to unknown node "${e.to}"`,
        path: `/edges/${i}/to`,
        hint: closest(e.to, [...nodeIndex.keys()]) ? `Did you mean "${closest(e.to, [...nodeIndex.keys()])}"?` : undefined,
      });
    if (e.from === e.to) add({ severity: "error", code: "SELF_LOOP", message: `Node "${e.from}" has an edge to itself`, path: `/edges/${i}` });
    const fromNode = nodes[nodeIndex.get(e.from) ?? -1];
    if (fromNode) {
      const ports = registry.portsOf({ ...fromNode, config: parsedConfigs.get(fromNode.id) ?? fromNode.config });
      if (!ports.includes(port))
        add({
          severity: "error",
          code: "EDGE_UNKNOWN_PORT",
          message: `Node "${e.from}" (${fromNode.type}) has no port "${port}"`,
          path: `/edges/${i}/port`,
          hint: `Valid ports: ${ports.join(", ")}`,
        });
    }
    const toNode = nodes[nodeIndex.get(e.to) ?? -1];
    if (toNode?.type === "input") add({ severity: "error", code: "EDGE_INTO_INPUT", message: `The input node cannot have incoming edges`, path: `/edges/${i}/to` });
  });

  /* ---- topology ---- */
  const validEdges = edges.filter((e) => nodeIndex.has(e.from) && nodeIndex.has(e.to) && e.from !== e.to);
  const g = buildGraph({ nodes, edges: validEdges });
  const { cyclic } = topoSort(g);
  if (cyclic.length) add({ severity: "error", code: "CYCLE", message: `Cycle detected among: ${cyclic.join(", ")}. Agents are DAGs — use a refine/map/agent node for iteration.` });
  const anc = ancestors(g);
  if (inputs.length === 1) {
    const reach = reachableFrom(g, [inputs[0].id]);
    for (const n of nodes)
      if (!reach.has(n.id))
        add({
          severity: "error",
          code: "UNREACHABLE_NODE",
          message: `Node "${n.id}" is not reachable from the input node`,
          nodeId: n.id,
          path: `/nodes/${nodeIndex.get(n.id)}`,
          hint: "Add an edge into it from an upstream node.",
        });
  }
  if (outputs.length) {
    const toOut = canReach(
      g,
      outputs.map((o) => o.id),
    );
    for (const n of nodes) {
      if (!toOut.has(n.id) && n.type !== "output" && n.type !== "memory" && n.type !== "http") {
        add({
          severity: "warning",
          code: "DEAD_END",
          message: `Node "${n.id}" never leads to an output node; its result is unused`,
          nodeId: n.id,
          path: `/nodes/${nodeIndex.get(n.id)}`,
        });
      }
    }
  }

  /* ---- branches ---- */
  for (const n of nodes) {
    const cls = registry.get(n.type);
    if (!cls?.ports) continue;
    const cfg = parsedConfigs.get(n.id);
    if (!cfg) continue;
    const ports = registry.portsOf({ ...n, config: cfg }).filter((p) => p !== "error");
    if (ports.length <= 1) continue;
    const used = new Set(g.outgoing.get(n.id)?.map((e) => e.port ?? "out"));
    if (used.has("out"))
      add({ severity: "error", code: "EDGE_UNKNOWN_PORT", message: `"${n.id}" is a branching node; edges must name a port (${ports.join(", ")})`, nodeId: n.id });
    const unused = ports.filter((p) => !used.has(p));
    if (unused.length)
      add({
        severity: "warning",
        code: "UNCONNECTED_PORT",
        message: `"${n.id}" branch${unused.length > 1 ? "es" : ""} ${unused.map((p) => `"${p}"`).join(", ")} lead nowhere; runs taking ${unused.length > 1 ? "them" : "it"} end without output`,
        nodeId: n.id,
        path: `/nodes/${nodeIndex.get(n.id)}`,
      });
  }

  /* ---- data references ---- */
  const inputProps = (spec.inputSchema as JSONSchema | undefined)?.properties;
  nodes.forEach((n, i) => {
    const cls = registry.get(n.type);
    const { refs, issues } = extractRefs(n.config ?? {}, `/nodes/${i}/config`);
    for (const t of issues) add({ severity: "error", code: "TEMPLATE_SYNTAX", message: `${n.id}: ${t.message}`, path: t.pointer, nodeId: n.id });
    const lazy = new Set(cls?.lazyFields ?? []);
    for (const ref of refs) {
      const field = ref.pointer.split("/")[4];
      const where = `${n.id} → {{${ref.source}}}`;
      if (ref.root === "input") {
        const first = ref.segments[0];
        if (inputProps && Object.keys(inputProps).length && typeof first === "string" && !(first in inputProps)) {
          add({
            severity: "error",
            code: "TEMPLATE_UNKNOWN_INPUT",
            message: `${where}: input has no field "${first}"`,
            path: ref.pointer,
            nodeId: n.id,
            hint: `inputSchema fields: ${Object.keys(inputProps).join(", ")} (or add "${first}" to inputSchema)`,
          });
        }
      } else if (ref.root === "nodes") {
        if (!ref.nodeId) {
          add({ severity: "error", code: "TEMPLATE_SYNTAX", message: `${where}: expected nodes.<id>.output…`, path: ref.pointer, nodeId: n.id });
          continue;
        }
        if (!nodeIndex.has(ref.nodeId)) {
          const guess = closest(ref.nodeId, [...nodeIndex.keys()]);
          add({
            severity: "error",
            code: "TEMPLATE_UNKNOWN_NODE",
            message: `${where}: node "${ref.nodeId}" does not exist`,
            path: ref.pointer,
            nodeId: n.id,
            hint: guess ? `Did you mean "${guess}"?` : undefined,
          });
          continue;
        }
        if (ref.segments[1] !== "output") {
          add({
            severity: "error",
            code: "TEMPLATE_SYNTAX",
            message: `${where}: node references must go through ".output" (nodes.${ref.nodeId}.output…)`,
            path: ref.pointer,
            nodeId: n.id,
          });
          continue;
        }
        if (!anc.get(n.id)?.has(ref.nodeId)) {
          add({
            severity: "error",
            code: "TEMPLATE_NOT_UPSTREAM",
            message: `${where}: "${ref.nodeId}" is not upstream of "${n.id}", so its output is not available yet`,
            path: ref.pointer,
            nodeId: n.id,
            hint: `Add a path of edges from "${ref.nodeId}" to "${n.id}".`,
          });
          continue;
        }
        const target = nodes[nodeIndex.get(ref.nodeId)!];
        if (target.disabled && !n.disabled && !ref.source.includes("??"))
          add({
            severity: "warning",
            code: "DISABLED_NODE_REFERENCED",
            message: `${where}: "${ref.nodeId}" is disabled, so its output is empty`,
            path: ref.pointer,
            nodeId: n.id,
            hint: `Enable "${ref.nodeId}", or give a fallback: {{${ref.source} ?? "…"}}.`,
          });
        const tcls = registry.get(target.type);
        // Custom classes have config-independent output schemas, so check fields even if the config is invalid.
        const tcfg = parsedConfigs.get(target.id) ?? (tcls?.custom ? (target.config ?? {}) : undefined);
        if (tcls?.outputSchema && tcfg && ref.fieldPath?.length) {
          let schema: JSONSchema | undefined;
          try {
            schema = tcls.outputSchema(tcfg as never, staticCtx);
          } catch {
            schema = undefined;
          }
          const r = schemaAt(schema, ref.fieldPath);
          if (!r.ok) {
            add({
              severity: "error",
              code: "TEMPLATE_UNKNOWN_FIELD",
              message: `${where}: "${ref.nodeId}" (${target.type}) output has no field "${ref.fieldPath.join(".")}"`,
              path: ref.pointer,
              nodeId: n.id,
              hint: r.available?.length ? `Available fields: ${r.available.join(", ")}` : undefined,
            });
          }
        }
      } else if (ref.root === "item" || ref.root === "index") {
        if (!lazy.has(field))
          add({
            severity: "error",
            code: "TEMPLATE_BAD_SCOPE",
            message: `${where}: {{${ref.root}}} is only available in per-item fields of a map node (${[...(registry.get("map")?.lazyFields ?? [])].join(", ")})`,
            path: ref.pointer,
            nodeId: n.id,
          });
      } else {
        add({
          severity: "error",
          code: "TEMPLATE_UNKNOWN_ROOT",
          message: `${where}: unknown root "${ref.root}". Use input.…, nodes.<id>.output.…, or item/index inside map`,
          path: ref.pointer,
          nodeId: n.id,
        });
      }
    }
  });

  /* ---- references inside JavaScript (code nodes / map mode=code) ---- */
  // A node may be skipped for `target` if target is still reachable from input without passing through it.
  const skipCache = new Map<string, boolean>();
  const mayBeSkipped = (nodeId: string, target: string): boolean => {
    // A disabled step never gives an output.
    if (nodes[nodeIndex.get(nodeId) ?? -1]?.disabled) return true;
    const key = `${nodeId}>${target}`;
    if (skipCache.has(key)) return skipCache.get(key)!;
    const start = inputs[0]?.id;
    let result = false;
    if (start && start !== nodeId) {
      const seen = new Set([start]);
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur === target) {
          result = true;
          break;
        }
        for (const e of g.outgoing.get(cur) ?? []) {
          if (e.to === nodeId || seen.has(e.to)) continue;
          seen.add(e.to);
          stack.push(e.to);
        }
      }
    }
    skipCache.set(key, result);
    return result;
  };
  nodes.forEach((n, i) => {
    const code = (n.config as { code?: unknown } | undefined)?.code;
    if (typeof code !== "string") return;
    const asyncProblem = asyncCodeProblem(code);
    if (asyncProblem) add({ severity: "error", code: "CODE_ASYNC", message: `${n.id}: ${asyncProblem}`, path: `/nodes/${i}/config/code`, nodeId: n.id });
    for (const m of code.matchAll(/\bnodes\.([A-Za-z_][\w]*)(\.[A-Za-z_]\w*)?/g)) {
      const [, id, next] = m;
      const where = `${n.id} (code) → nodes.${id}`;
      if (!nodeIndex.has(id)) {
        const guess = closest(id, [...nodeIndex.keys()]);
        add({
          severity: "error",
          code: "CODE_UNKNOWN_NODE",
          message: `${where}: node "${id}" does not exist`,
          path: `/nodes/${i}/config/code`,
          nodeId: n.id,
          hint: guess ? `Did you mean "${guess}"?` : undefined,
        });
      } else if (!anc.get(n.id)?.has(id)) {
        add({
          severity: "error",
          code: "CODE_NOT_UPSTREAM",
          message: `${where}: "${id}" is not upstream, so nodes.${id} is undefined here`,
          path: `/nodes/${i}/config/code`,
          nodeId: n.id,
        });
      } else if (next && next !== ".output") {
        add({ severity: "error", code: "CODE_BAD_PATH", message: `${where}${next}: read node data as nodes.${id}.output${next}`, path: `/nodes/${i}/config/code`, nodeId: n.id });
      } else if (next === ".output" && /^\.[A-Za-z_[]/.test(code.slice((m.index ?? 0) + m[0].length)) && mayBeSkipped(id, n.id)) {
        add({
          severity: "error",
          code: "CODE_UNSAFE_OPTIONAL",
          message: `${where}.output… : "${id}" can be skipped on some paths, so its output may be null here`,
          path: `/nodes/${i}/config/code`,
          nodeId: n.id,
          hint: `Use nodes.${id}.output?.field ?? fallback`,
        });
      }
    }
  });

  /* ---- side effects & policy ---- */
  for (const n of nodes) {
    const cls = registry.get(n.type);
    const cfg = parsedConfigs.get(n.id);
    // A disabled step does not run, so it changes nothing.
    if (!cls?.sideEffects || !cfg || n.disabled) continue;
    let fx = false;
    try {
      fx = cls.sideEffects(cfg as never);
    } catch {
      fx = false;
    }
    if (!fx) continue;
    // A disabled approval step does not stop anything (docs/WORKFLOW_EDITOR.md).
    const gated = [...(anc.get(n.id) ?? [])].some((a) => nodes[nodeIndex.get(a)!]?.type === "human_approval" && !nodes[nodeIndex.get(a)!]?.disabled);
    if (!gated) {
      add({
        severity: spec.policy?.requireApprovalForSideEffects ? "error" : "warning",
        code: "UNGATED_SIDE_EFFECT",
        message: `"${n.id}" can change external state and is not behind a human_approval node`,
        nodeId: n.id,
        path: `/nodes/${nodeIndex.get(n.id)}`,
      });
    }
  }

  /* ---- the action gate (docs/GATE.md) ---- */
  // In a conversation agent or an agent with rules, each step that changes something comes after an action gate on
  // each path from the input, and never after the "block" port of a gate.
  const conversational = spec.meta?.interaction === "conversation" || !!(spec.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties?.messages;
  if (conversational || specRules(spec).length) {
    const next = new Map<string, { to: string; port?: string }[]>();
    for (const e of spec.edges ?? []) next.set(e.from, [...(next.get(e.from) ?? []), { to: e.to, port: e.port }]);
    const isGate = (id: string) => nodes[nodeIndex.get(id) ?? -1]?.type === "action_gate" && !nodes[nodeIndex.get(id) ?? -1]?.disabled;
    const walk = (starts: string[]) => {
      const seen = new Set<string>();
      const queue = [...starts];
      while (queue.length) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        if (isGate(id)) continue;
        for (const e of next.get(id) ?? []) queue.push(e.to);
      }
      return seen;
    };
    const free = walk(nodes.filter((n) => n.type === "input").map((n) => n.id));
    const blocked = walk(nodes.filter((n) => n.type === "action_gate").flatMap((g) => (next.get(g.id) ?? []).filter((e) => e.port === "block").map((e) => e.to)));
    for (const n of nodes) {
      const cls = registry.get(n.type);
      const cfg = parsedConfigs.get(n.id);
      if (!cls?.sideEffects || !cfg || n.type === "action_gate" || n.disabled) continue;
      let fx = false;
      try {
        fx = cls.sideEffects(cfg as never);
      } catch {
        fx = false;
      }
      if (!fx) continue;
      if (free.has(n.id))
        add({
          severity: "error",
          code: "UNGATED_ACTION",
          message: `"${n.id}" changes something, and a path from the input reaches it without an action_gate step`,
          nodeId: n.id,
          path: `/nodes/${nodeIndex.get(n.id)}`,
          hint: `Put an "action_gate" step before "${n.id}" with the action and its values, and connect its "pass" port to "${n.id}". Connect its "block" port to a reply step that gives the reason.`,
        });
      else if (blocked.has(n.id))
        add({
          severity: "error",
          code: "UNGATED_ACTION",
          message: `the "block" port of an action gate leads to "${n.id}", which changes something`,
          nodeId: n.id,
          path: `/nodes/${nodeIndex.get(n.id)}`,
          hint: `Connect the "block" port to a reply step only, and the "pass" port to "${n.id}".`,
        });
    }
  }

  /* ---- tests ---- */
  const shape = agentOutputSchema(spec);
  if (spec.inputSchema && Array.isArray(spec.tests)) {
    spec.tests.forEach((t, i) => {
      const errs = schemaErrors(spec.inputSchema as JSONSchema, t.input);
      if (errs.length)
        add({ severity: "warning", code: "TEST_INPUT_INVALID", message: `Test "${t.name}" input does not match inputSchema: ${errs.join("; ")}`, path: `/tests/${i}/input` });
      (Array.isArray(t.checks) ? t.checks : []).forEach((c, j) => {
        const problem = checkPathProblem(shape, c?.path);
        if (problem) add({ severity: "warning", code: "TEST_CHECK_PATH", message: `Test "${t.name}": ${problem}`, path: `/tests/${i}/checks/${j}/path` });
      });
    });
  }

  /* ---- sources that the request names ---- */
  const namedLevel = opts.namedSources ?? "warning";
  const request = opts.request ?? (spec.meta as { request?: unknown } | undefined)?.request;
  if (namedLevel !== "off" && typeof request === "string")
    for (const url of missingNamedUrls(request, nodes.map((n) => n.config)))
      add({
        severity: namedLevel,
        code: "NAMED_SOURCE",
        message: `The request names the source ${url}, but no node uses it`,
        hint: "Use this URL (with templates for its variable parts) in the node that gets the data. Use another source only when this one does not work.",
      });

  /* ---- sources that the source plan tested ---- */
  const plannedLevel = opts.plannedSources ?? "warning";
  const plan = opts.sourcePlan ?? ((spec.meta as { plan?: { sourcePlan?: PlannedSources } } | undefined)?.plan?.sourcePlan);
  if (plannedLevel !== "off")
    for (const id of missingPlannedSources(plan, nodes))
      add({
        severity: plannedLevel,
        code: "PLANNED_SOURCE",
        message: `No node uses the tested source of the data need "${id}"`,
        hint: "Use the node type or the URL that the DATA SOURCE PLAN gives for this need, or one of its fallbacks. An untested source can give other data.",
      });

  /* ---- a closed build (docs/TOOLS.md) ---- */
  const given = opts.givenTools ?? ((spec.meta as { givenTools?: string[] } | undefined)?.givenTools ?? []);
  if (given.length)
    nodes.forEach((n, i) => {
      const c = (n.config ?? {}) as { tools?: unknown; classes?: unknown };
      const bad = (message: string, hint: string) => add({ severity: "error", code: "CLOSED_TOOLS", message: `${n.id}: ${message}`, path: `/nodes/${i}`, nodeId: n.id, hint });
      if (CLOSED_NETWORK_NODES.includes(n.type)) bad(`"${n.type}" reaches the web, but the agent may use only its given tools`, `Use the given tools: ${given.join(", ")}`);
      else if (n.type.startsWith("x_") && !given.includes(n.type)) bad(`the class "${n.type}" is not a given tool`, `Use the given tools: ${given.join(", ")}`);
      for (const t of Array.isArray(c.tools) ? c.tools : []) if (CLOSED_NETWORK_TOOLS.includes(String(t))) bad(`the tool "${t}" reaches the web`, 'Give the tools to the step in "classes" instead');
      for (const k of Array.isArray(c.classes) ? c.classes : []) if (!given.includes(String(k))) bad(`the class "${k}" is not a given tool`, `Use the given tools: ${given.join(", ")}`);
    });

  /* ---- unattended mode ---- */
  if (opts.unattended)
    nodes.forEach((n, i) => {
      if (n.type === "human_approval" || n.type === "human_input")
        add({
          severity: "error",
          code: "HUMAN_STEP_UNATTENDED",
          message: `${n.id} waits for a person, but the agent runs without one`,
          path: `/nodes/${i}`,
          nodeId: n.id,
          hint: "Remove this step. Do the safe action, or return the reason when the task needs a person.",
        });
    });

  /* ---- attached files (docs/FILES.md) ---- */
  const taskFiles = opts.files ?? ((spec.meta as { taskSpec?: { files?: { id: string; name: string; role: string }[] } } | undefined)?.taskSpec?.files ?? []);
  const fileSteps = nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.type === "file");
  for (const f of taskFiles) {
    const steps = fileSteps.filter(({ n }) => (n.config as { fileId?: unknown })?.fileId === f.id);
    // A sample input changes in each run: the agent gets it from its input field, not from a fixed file.
    if (f.role === "sample_input")
      for (const { n, i } of steps)
        add({
          severity: "error",
          code: "FILE_SAMPLE_AS_STEP",
          message: `${n.id} reads the sample input "${f.name}" as a fixed file`,
          path: `/nodes/${i}/config/fileId`,
          nodeId: n.id,
          hint: "A sample input is only an example. Read the file input field of the agent ({{input.<field>.text}}), and remove this step.",
        });
    // A reference file is data that the agent reads in each run.
    if (f.role === "reference" && !steps.length)
      add({
        severity: "error",
        code: "FILE_REFERENCE_MISSING",
        message: `No "file" step reads the reference file "${f.name}" (${f.id})`,
        hint: `Add a step {"type": "file", "config": {"fileId": "${f.id}"}} and use its output.`,
      });
  }

  /* ---- STE: prompt text that the builder writes ---- */
  const steLevel = opts.ste ?? "warning";
  if (steLevel !== "off") {
    const max = opts.steMaxPer100w ?? 4;
    const fields: { path: string; text: string; nodeId?: string }[] = [];
    nodes.forEach((n, i) => {
      if (registry.get(n.type)?.internal) return;
      for (const f of promptFields(n.config, `/nodes/${i}/config`)) fields.push({ ...f, nodeId: n.id });
    });
    (Array.isArray(spec.tests) ? spec.tests : []).forEach((t, i) => t && fields.push(...promptFields({ criteria: t.criteria }, `/tests/${i}`)));
    (Array.isArray(spec.acceptance) ? spec.acceptance : []).forEach((r, i) => r?.kind === "judge" && fields.push({ path: `/acceptance/${i}/criterion`, text: r.criterion }));
    for (const f of fields) {
      const r = steLint(f.text);
      if (r.words < 8 || !steFails(r, max)) continue;
      add({
        severity: steLevel,
        code: "STE_PROMPT",
        message: `${f.nodeId ? `${f.nodeId}: ` : ""}${f.path.split("/").slice(f.nodeId ? 4 : 1).join(".")} is not in STE: ${steSummary(r)}`,
        path: f.path,
        nodeId: f.nodeId,
        hint: "Rewrite this text in STE (the STE rules are in the instructions) and keep its meaning.",
      });
    }
  }

  /* ---- acceptance (the definition of done for the harness) ---- */
  const ruleIds = new Set<string>();
  (Array.isArray(spec.acceptance) ? spec.acceptance : []).forEach((r, i) => {
    const at = `/acceptance/${i}`;
    if (ruleIds.has(r.id)) add({ severity: "error", code: "ACCEPTANCE", message: `acceptance rule "${r.id}": duplicate id`, path: `${at}/id` });
    ruleIds.add(r.id);
    if (r.kind !== "check") return;
    const problem = checkPathProblem(shape, r.check.path);
    if (problem) add({ severity: "error", code: "ACCEPTANCE", message: `acceptance rule "${r.id}": ${problem}`, path: `${at}/check/path` });
    if (r.check.op === "matches") {
      try {
        new RegExp(String(r.check.value));
      } catch {
        add({ severity: "error", code: "ACCEPTANCE", message: `acceptance rule "${r.id}": the pattern is not a valid regular expression`, path: `${at}/check/value` });
      }
    }
    if (["equals", "contains", "matches", "type", "minLength", "maxLength"].includes(r.check.op) && r.check.value === undefined)
      add({ severity: "error", code: "ACCEPTANCE", message: `acceptance rule "${r.id}": the "${r.check.op}" check needs a value`, path: `${at}/check/value` });
  });

  /* ---- triggers ---- */
  const triggerIds = new Set<string>();
  (Array.isArray(spec.triggers) ? spec.triggers : []).forEach((t, i) => {
    const at = `/triggers/${i}`;
    const err = (message: string, path = at, hint?: string, severity: Diagnostic["severity"] = "error") =>
      add({ severity, code: "TRIGGER", message: `trigger "${t.id}": ${message}`, path, hint });
    if (triggerIds.has(t.id)) err("duplicate trigger id", `${at}/id`);
    triggerIds.add(t.id);
    const roots: Record<string, string[]> = {
      schedule: ["trigger"],
      webhook: ["trigger", "payload", "headers", "query"],
      poll: ["trigger", "item"],
      agent: ["trigger", "output", "run"],
    };
    const { refs, issues } = extractRefs(t.input ?? {}, `${at}/input`);
    for (const x of issues) err(x.message, x.pointer);
    for (const r of refs) if (!roots[t.type].includes(r.root)) err(`{{${r.source}}}: a ${t.type} trigger can use ${roots[t.type].map((x) => `{{${x}.…}}`).join(", ")}`, r.pointer);
    if (t.type === "schedule") {
      if (!!t.cron === !!t.every) err('set exactly one of "cron" or "every"');
      if (t.cron) {
        try {
          parseCron(t.cron);
        } catch (e) {
          err((e as Error).message, `${at}/cron`);
        }
      }
      if (t.every) {
        try {
          if (parseEvery(t.every) < 30_000) err("the minimum interval is 30s", `${at}/every`);
        } catch (e) {
          err((e as Error).message, `${at}/every`);
        }
      }
      if (t.timezone && !isValidTimezone(t.timezone)) err(`unknown timezone "${t.timezone}"`, `${at}/timezone`, 'Use an IANA name like "Europe/Istanbul"');
    }
    if (t.type === "poll") {
      try {
        if (parseEvery(t.every) < 60_000) err("the minimum poll interval is 1m", `${at}/every`);
      } catch (e) {
        err((e as Error).message, `${at}/every`);
      }
    }
    if (t.type === "agent") {
      if (t.agentId === spec.id) err("an agent cannot trigger itself", `${at}/agentId`);
      else if (opts.getAgent && !opts.getAgent(t.agentId)) err(`agent "${t.agentId}" does not exist`, `${at}/agentId`);
    }
    // Required inputs must be provided by the mapping (or have defaults).
    const req = ((spec.inputSchema as JSONSchema)?.required ?? []).filter((k) => (spec.inputSchema as JSONSchema).properties?.[k]?.default === undefined);
    if (t.input && typeof t.input === "object" && !Array.isArray(t.input)) {
      const missing = req.filter((k) => !(k in (t.input as object)));
      if (missing.length) err(`input mapping does not provide required field${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`, `${at}/input`);
    } else if (t.input === undefined && t.type === "schedule" && req.length) {
      err(`scheduled runs get an empty input, but the agent requires ${req.join(", ")}`, at, 'Add an "input" mapping with fixed values');
    }
  });

  return finish(parsed.success ? parsed.data : undefined);
}
