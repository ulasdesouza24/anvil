import { Ajv } from "ajv";
import type { z } from "zod";
import type { Brain } from "../llm/brain.js";
import type { HarnessContext } from "./harness.js";
import { buildGraph, topoSort } from "./graph.js";
import type { NodeContext, Registry, RunAgentOptions, RunAgentResult, Services } from "./registry.js";
import { resolveDeep, type Scope } from "./template.js";
import { addUsage, emptyUsage, type AgentSpec, type Edge, type HumanRequest, type JSONSchema, type NodeStatus, type RunEvent, type RunEventInput, type Usage } from "./types.js";

export interface EngineDeps {
  registry: Registry;
  brain: Brain;
  services: Services;
  maxParallel: number;
  /** Default per-node timeout when neither the node nor its class sets one. */
  nodeTimeoutMs?: number;
  /** Paid web searches for one run, when the policy does not set a value. */
  maxPaidSearches?: number;
}

export interface ExecuteOptions {
  /** Set by the harness for each attempt. */
  harness?: HarnessContext;
  runId: string;
  emit: (e: RunEvent) => void;
  signal?: AbortSignal;
  depth?: number;
  waitForHuman: (nodeId: string, req: HumanRequest, signal: AbortSignal) => Promise<unknown>;
  /**
   * The steps that finished before a restart (docs/RECOVERY.md): the engine does not run them again.
   * It uses their recorded output and ports.
   */
  replay?: Record<string, { output: unknown; ports: string[] }>;
  /** Called with the full output of each step that finished (the checkpoint of a waiting run). */
  onNodeDone?: (nodeId: string, output: unknown, ports: string[]) => void;
  /**
   * Pinned data of the workflow editor (docs/WORKFLOW_EDITOR.md): the engine does not run these steps.
   * It uses the given output and ports. Ports default to the success ports of the step.
   */
  pinned?: Record<string, { output: unknown; ports?: string[] }>;
  /** A partial run of the editor: only this step and the steps before it run. The output of the run is the output of this step. */
  targetNodeId?: string;
}

export interface ExecuteResult {
  status: "completed" | "failed" | "cancelled";
  output: unknown;
  error?: string;
  usage: Usage;
  nodeOutputs: Record<string, unknown>;
  nodeStates: Record<string, NodeStatus>;
  durationMs: number;
}

export const MAX_DEPTH = 5;

const inputAjv = new Ajv({ allErrors: true, strict: false, useDefaults: true, coerceTypes: true, allowUnionTypes: true });
// An input field for an attached file (docs/FILES.md). The run gets the content of the file in it.
inputAjv.addFormat("anvil-file", true);

/**
 * An input can name attached files: {"fileId": "f_…"}. The run gets the content of each file
 * in its place (name, kind, text, sheets, …), so an agent reads a file like other input data.
 */
export function expandFileRefs(input: unknown, files: Services["files"]): { value: unknown; errors: string[] } {
  const errors: string[] = [];
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      // Only a reference: an object with fileId and without content. A value with content stays as it is.
      if (typeof o.fileId === "string" && o.text === undefined && o.sheets === undefined) {
        const f = files?.value(o.fileId);
        if (!f) {
          errors.push(`file "${o.fileId}" does not exist`);
          return v;
        }
        return f;
      }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return { value: walk(input), errors };
}

export function prepareInput(schema: JSONSchema | undefined, input: unknown): { value: unknown; errors: string[] } {
  const value = input === undefined || input === null ? {} : structuredClone(input);
  if (!schema || !Object.keys(schema).length) return { value, errors: [] };
  // An optional field that a form leaves empty is not given: "" or null must not fail its own rules (for example minLength).
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const required = new Set(schema.required ?? []);
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      if (!required.has(k) && (v === "" || v === null) && schema.properties?.[k]) delete (value as Record<string, unknown>)[k];
  }
  const validate = inputAjv.compile(schema);
  if (validate(value)) return { value, errors: [] };
  return { value, errors: (validate.errors ?? []).map((e) => `${e.instancePath || "input"} ${e.message}`) };
}

class NodeTimeout extends Error {}

/**
 * Executes an agent spec as a dataflow DAG.
 *
 * Semantics:
 *  - A node becomes ready when every incoming edge is resolved (active or dead).
 *  - It runs if at least one incoming edge is active, otherwise it is skipped and
 *    its outgoing edges become dead (dead-path elimination) — so joins after
 *    branches work without special casing.
 *  - A finished node activates the edges on the ports it fired (branching).
 *  - A failed node activates its "error" edges if it has any; otherwise the run fails.
 */
export async function executeAgent(spec: AgentSpec, rawInput: unknown, deps: EngineDeps, opts: ExecuteOptions): Promise<ExecuteResult> {
  const started = Date.now();
  const depth = opts.depth ?? 0;
  const usage = emptyUsage();
  const emit = (e: RunEventInput) => opts.emit({ ...e, t: Date.now() } as RunEvent);

  const runCtrl = new AbortController();
  const onParentAbort = () => runCtrl.abort();
  opts.signal?.addEventListener("abort", onParentAbort);
  const runTimer = setTimeout(() => runCtrl.abort(new Error(`Run exceeded policy timeout of ${spec.policy.timeoutMs}ms`)), spec.policy.timeoutMs);

  const g = buildGraph(spec);
  const { order } = topoSort(g);
  const nodes = new Map(spec.nodes.map((n) => [n.id, n]));
  // A partial run: the target and its ancestors. Other steps stay pending.
  let inScope: Set<string> | undefined;
  if (opts.targetNodeId) {
    inScope = new Set([opts.targetNodeId]);
    const queue = [opts.targetNodeId];
    while (queue.length) {
      for (const e of g.incoming.get(queue.shift()!) ?? []) {
        if (inScope.has(e.from)) continue;
        inScope.add(e.from);
        queue.push(e.from);
      }
    }
  }
  const status: Record<string, NodeStatus> = Object.fromEntries(spec.nodes.map((n) => [n.id, "pending" as NodeStatus]));
  const edgeState = new Map<Edge, "pending" | "active" | "dead">(spec.edges.map((e) => [e, "pending"]));
  const scope: Scope & { nodes: Record<string, { output: unknown }> } = { input: undefined, nodes: {} };
  const nodeOutputs: Record<string, unknown> = {};
  // One budget object for the whole run, shared by all nodes.
  const runBudget = { paidSearches: { used: 0, max: spec.policy.maxPaidSearches ?? deps.maxPaidSearches ?? Number.POSITIVE_INFINITY } };
  let fatal: string | undefined;
  let executions = 0;
  // The order of the actions with a side effect in this execution (docs/EFFECTS.md).
  const effectSeq = new Map<string, number>();

  const finish = (s: ExecuteResult["status"], output: unknown, error?: string): ExecuteResult => {
    clearTimeout(runTimer);
    opts.signal?.removeEventListener("abort", onParentAbort);
    const durationMs = Date.now() - started;
    if (s === "completed") emit({ type: "run.completed", output, usage, durationMs });
    else if (s === "cancelled") emit({ type: "run.cancelled" });
    else emit({ type: "run.failed", error: error ?? "failed", usage, durationMs });
    return { status: s, output, error, usage, nodeOutputs, nodeStates: status, durationMs };
  };

  if (depth > MAX_DEPTH) return finish("failed", null, `Maximum agent nesting depth (${MAX_DEPTH}) exceeded`);
  if (opts.targetNodeId && !nodes.has(opts.targetNodeId)) return finish("failed", null, `Unknown target step "${opts.targetNodeId}"`);

  const expanded = expandFileRefs(rawInput, deps.services.files);
  const prepared = prepareInput(spec.inputSchema, expanded.value);
  prepared.errors.push(...expanded.errors);
  scope.input = prepared.value;
  emit({ type: "run.started", runId: opts.runId, agentId: spec.id, version: spec.version, input: prepared.value });
  if (prepared.errors.length) return finish("failed", null, `Invalid input: ${prepared.errors.join("; ")}`);

  const addRunUsage = (u: Partial<Usage>) => {
    addUsage(usage, u);
    if (usage.costUsd > spec.policy.maxCostUsd && !fatal) {
      fatal = `Budget exceeded: $${usage.costUsd.toFixed(4)} > policy.maxCostUsd $${spec.policy.maxCostUsd}`;
      runCtrl.abort(new Error(fatal));
    }
  };

  const resolveOutgoing = (id: string, fired: Set<string>) => {
    for (const e of g.outgoing.get(id) ?? []) edgeState.set(e, fired.has(e.port ?? "out") ? "active" : "dead");
  };

  const runNode = async (id: string): Promise<void> => {
    const node = nodes.get(id)!;
    const cls = deps.registry.get(node.type);
    if (!cls) {
      fatal = `Unknown node type "${node.type}" on node "${id}"`;
      return;
    }
    if (node.disabled) {
      // A disabled step (docs/WORKFLOW_EDITOR.md): no execution, an empty output, and only the "out" edges stay active.
      status[id] = "skipped";
      resolveOutgoing(id, new Set(deps.registry.portsOf(node).includes("out") ? ["out"] : []));
      emit({ type: "node.skipped", nodeId: id, reason: "disabled" });
      return;
    }
    const pin = opts.pinned?.[id];
    if (pin) {
      const ports = pin.ports ?? deps.registry.portsOf(node).filter((p) => p !== "error");
      nodeOutputs[id] = pin.output;
      scope.nodes[id] = { output: pin.output };
      status[id] = "done";
      resolveOutgoing(id, new Set(ports));
      emit({ type: "node.completed", nodeId: id, output: truncate(pin.output), ports, usage: emptyUsage(), durationMs: 0 });
      emit({ type: "log", nodeId: id, level: "info", message: "pinned: the step did not run, and the run uses its pinned output" });
      return;
    }
    const replayed = opts.replay?.[id];
    if (replayed) {
      // A step that finished before a restart: its recorded result, and no second run of its actions.
      nodeOutputs[id] = replayed.output;
      scope.nodes[id] = { output: replayed.output };
      status[id] = "done";
      resolveOutgoing(id, new Set(replayed.ports));
      opts.onNodeDone?.(id, replayed.output, replayed.ports);
      emit({ type: "node.completed", nodeId: id, output: truncate(replayed.output), ports: replayed.ports, usage: emptyUsage(), durationMs: 0 });
      emit({ type: "log", nodeId: id, level: "info", message: "replayed: this step finished before the restart, so it does not run again" });
      return;
    }
    const retry = { maxAttempts: node.retry?.maxAttempts ?? cls.defaultRetry?.maxAttempts ?? 1, backoffMs: node.retry?.backoffMs ?? cls.defaultRetry?.backoffMs ?? 500 };
    const isHuman = cls.category === "human";
    const timeoutMs = node.timeoutMs ?? cls.defaultTimeoutMs ?? (isHuman ? 0 : (deps.nodeTimeoutMs ?? 180_000));
    const nodeUsage = emptyUsage();
    const t0 = Date.now();

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      if (runCtrl.signal.aborted) return;
      if (++executions > spec.policy.maxNodeExecutions) {
        fatal = `Exceeded policy.maxNodeExecutions (${spec.policy.maxNodeExecutions})`;
        runCtrl.abort();
        return;
      }
      const nodeCtrl = new AbortController();
      // The actions with a side effect of this attempt (docs/EFFECTS.md).
      const effects = { ran: 0, seq: effectSeq };
      const onRunAbort = () => nodeCtrl.abort();
      runCtrl.signal.addEventListener("abort", onRunAbort);
      let timer: NodeJS.Timeout | undefined;
      try {
        status[id] = "running";
        const lazy = cls.lazyFields ?? [];
        const resolved = resolveDeep(node.config ?? {}, scope, lazy) as Record<string, unknown>;
        const parsed = (cls.configSchema as z.ZodType).safeParse(resolved);
        if (!parsed.success) {
          throw new Error(`Config for "${id}" is invalid after resolving templates: ${parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ")}`);
        }
        emit({ type: "node.started", nodeId: id, attempt, config: truncate(parsed.data) });
        const addNodeUsage = (u: Partial<Usage>) => {
          addUsage(nodeUsage, u);
          addRunUsage(u);
        };
        const ctx: NodeContext = {
          runId: opts.runId,
          node,
          spec,
          config: parsed.data as Record<string, unknown>,
          rawConfig: node.config ?? {},
          input: scope.input,
          scope,
          brain: deps.brain.with({ nodeId: id, emit, addUsage: addNodeUsage, signal: nodeCtrl.signal, budget: runBudget, note: opts.harness?.note, deep: opts.harness?.deep }),
          harness: opts.harness,
          services: {
            ...deps.services,
            runAgent: async (ref, input, o: RunAgentOptions = {}): Promise<RunAgentResult> => {
              const r = await deps.services.runAgent(ref, input, {
                ...o,
                parentRunId: opts.runId,
                depth: depth + 1,
                // The signal of the caller (for example the time limit of a best-of candidate) also stops the nested run.
                signal: o.signal ? AbortSignal.any([o.signal, nodeCtrl.signal]) : nodeCtrl.signal,
                // Human steps inside sub-agents surface on this node of the parent run.
                waitForHuman: o.waitForHuman ?? ((_childNode, req) => ctx.waitForHuman({ ...req, title: `[${ref.agentId ?? ref.spec?.id}] ${req.title}` })),
              });
              addNodeUsage(r.usage);
              return r;
            },
          },
          signal: nodeCtrl.signal,
          depth,
          resolve: (v, extra) => resolveDeep(v, { ...scope, ...(extra ?? {}) }),
          emit: (e) => emit({ ...e, nodeId: (e as { nodeId?: string }).nodeId ?? id } as RunEventInput),
          log: (message, data, level = "info") => emit({ type: "log", nodeId: id, level, message, data: truncate(data) }),
          addUsage: addNodeUsage,
          waitForHuman: async (req) => {
            status[id] = "waiting";
            emit({ type: "node.waiting", nodeId: id, request: truncate(req) as HumanRequest });
            const value = await opts.waitForHuman(id, req, nodeCtrl.signal);
            status[id] = "running";
            emit({ type: "node.resumed", nodeId: id, value: truncate(value) });
            return value;
          },
          upstream: () => (g.incoming.get(id) ?? []).map((e) => ({ nodeId: e.from, status: status[e.from], output: nodeOutputs[e.from] })),
          effects,
        };

        const exec = cls.execute(ctx);
        const result = timeoutMs
          ? await Promise.race([
              exec,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  nodeCtrl.abort();
                  reject(new NodeTimeout(`Node "${id}" timed out after ${timeoutMs}ms`));
                }, timeoutMs);
              }),
            ])
          : await exec;

        const successPorts = deps.registry.portsOf(node).filter((p) => p !== "error");
        const fired = new Set(result.ports ?? successPorts);
        nodeOutputs[id] = result.output;
        scope.nodes[id] = { output: result.output };
        status[id] = "done";
        resolveOutgoing(id, fired);
        opts.onNodeDone?.(id, result.output, [...fired]);
        emit({ type: "node.completed", nodeId: id, output: truncate(result.output), ports: [...fired], usage: nodeUsage, durationMs: Date.now() - t0 });
        return;
      } catch (e) {
        const msg = runCtrl.signal.aborted && fatal ? fatal : ((e as Error).message ?? String(e));
        // A step that did an action with a side effect does not run again: a retry can send it two times (docs/EFFECTS.md).
        const willRetry = attempt < retry.maxAttempts && !runCtrl.signal.aborted && !(e instanceof NodeTimeout && isHuman) && effects.ran === 0;
        if (effects.ran > 0 && attempt < retry.maxAttempts) emit({ type: "log", nodeId: id, level: "warn", message: "no retry: this attempt did an action with a side effect" });
        emit({ type: "node.failed", nodeId: id, error: msg, attempt, willRetry });
        if (willRetry) {
          await new Promise((r) => setTimeout(r, retry.backoffMs * attempt));
          continue;
        }
        status[id] = "failed";
        const errorEdges = (g.outgoing.get(id) ?? []).filter((x) => x.port === "error");
        if (errorEdges.length && !runCtrl.signal.aborted) {
          const out = { error: msg, node: id };
          nodeOutputs[id] = out;
          scope.nodes[id] = { output: out };
          resolveOutgoing(id, new Set(["error"]));
          opts.onNodeDone?.(id, out, ["error"]);
          return;
        }
        if (!fatal) fatal = runCtrl.signal.aborted && !opts.signal?.aborted ? ((runCtrl.signal.reason as Error)?.message ?? msg) : `Node "${id}" failed: ${msg}`;
        runCtrl.abort();
        return;
      } finally {
        if (timer) clearTimeout(timer);
        runCtrl.signal.removeEventListener("abort", onRunAbort);
      }
    }
  };

  const running = new Map<string, Promise<void>>();
  const schedule = () => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of order) {
        if (status[id] !== "pending" || running.has(id) || (inScope && !inScope.has(id))) continue;
        const inc = g.incoming.get(id) ?? [];
        if (inc.some((e) => edgeState.get(e) === "pending")) continue;
        if (inc.length && !inc.some((e) => edgeState.get(e) === "active")) {
          status[id] = "skipped";
          resolveOutgoing(id, new Set());
          emit({ type: "node.skipped", nodeId: id, reason: "no active incoming branch" });
          changed = true;
          continue;
        }
        if (running.size >= deps.maxParallel) return;
        const p = runNode(id).finally(() => running.delete(id));
        running.set(id, p);
      }
    }
  };

  schedule();
  while (running.size) {
    await Promise.race(running.values());
    if (fatal || runCtrl.signal.aborted) {
      await Promise.allSettled(running.values());
      break;
    }
    schedule();
  }

  if (opts.signal?.aborted && !fatal) return finish("cancelled", null, "cancelled");
  if (fatal || runCtrl.signal.aborted) {
    const reason = fatal ?? ((runCtrl.signal.reason as Error)?.message || "aborted");
    return finish("failed", null, reason);
  }

  if (opts.targetNodeId) {
    const t = opts.targetNodeId;
    if (status[t] === "skipped") emit({ type: "log", nodeId: t, level: "warn", message: "the target step did not run: no active branch comes to it" });
    return finish("completed", nodeOutputs[t] ?? null);
  }
  const out = order.find((id) => nodes.get(id)!.type === "output" && status[id] === "done");
  if (!out) {
    emit({ type: "log", level: "warn", message: "No output node executed (every branch leading to an output was skipped)" });
    return finish("completed", null);
  }
  return finish("completed", nodeOutputs[out]);
}

/** Keep events small: truncate long strings and big arrays for the trace. */
export function truncate(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 4000 ? `${v.slice(0, 4000)}… [${v.length} chars]` : v;
  if (depth > 8) return "[…]";
  if (Array.isArray(v)) {
    const head = v.slice(0, 50).map((x) => truncate(x, depth + 1));
    return v.length > 50 ? [...head, `… ${v.length - 50} more`] : head;
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, truncate(x, depth + 1)]));
  return v;
}
