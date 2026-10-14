import { z } from "zod";
import type { Brain } from "../llm/brain.js";
import type { Scope } from "./template.js";
import type { AgentSpec, EvaluationReport, HumanRequest, JSONSchema, NodeInstance, NodeStatus, RunEventInput, StoredAgent, Usage } from "./types.js";

export type NodeCategory = "io" | "ai" | "decision" | "logic" | "tool" | "data" | "human" | "anvil" | "custom";

export interface StaticContext {
  spec: AgentSpec;
  /** The registry (for classes that delegate to other classes, e.g. map mode=node). */
  registry?: Registry;
  /** Look up a saved agent (for subagent validation). */
  getAgent?: (id: string) => StoredAgent | undefined;
}

export interface NodeResult {
  output: unknown;
  /** Output ports that fire. Defaults to all of the node's ports. */
  ports?: string[];
}

export interface RunAgentOptions {
  version?: number;
  parentRunId?: string;
  kind?: import("./types.js").RunRecord["kind"];
  /** Persist as a standalone run record (visible in the UI). */
  record?: boolean;
  signal?: AbortSignal;
  /** Abort nested runs beyond this recursion depth. */
  depth?: number;
  /** How human nodes behave: ask a person, or auto-approve (used by evaluations). */
  humanMode?: "interactive" | "auto";
  /** Read live data again: no cached answer of a source (a health check, docs/HEALTH.md). */
  freshData?: boolean;
  /** The model of the LLM calls of this run that do not name a model (a best-of-N candidate, docs/SELECTION.md). Nested runs do not get it. */
  builderModel?: string;
  /** Proxy for human requests of nested runs (surfaced on the parent run). */
  waitForHuman?: (nodeId: string, req: HumanRequest, signal: AbortSignal) => Promise<unknown>;
  /** The top run of the run tree (docs/EFFECTS.md). */
  rootRunId?: string;
  /** Actions with a side effect give a preview and do not go out (docs/WORKFLOW_EDITOR.md). Nested runs get it from the parent. */
  dryRun?: boolean;
}

export interface RunAgentResult {
  output: unknown;
  harness?: import("./types.js").HarnessSummary;
  usage: Usage;
  runId: string;
  status: "completed" | "failed";
  error?: string;
  nodeOutputs: Record<string, unknown>;
  /** The resolved config of each node that started (a recorded run only): the arguments of a tool step. */
  nodeConfigs?: Record<string, unknown>;
  nodeStates: Record<string, NodeStatus>;
}

export interface KVStore {
  get(namespace: string, key: string): Promise<unknown>;
  set(namespace: string, key: string, value: unknown): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  list(namespace: string): Promise<Record<string, unknown>>;
}

export interface AgentStoreLike {
  getAgent(id: string): StoredAgent | undefined;
  listAgents(): StoredAgent[];
  saveVersion(spec: AgentSpec, opts: { note: string; score?: number; evaluation?: unknown; buildRunId?: string; system?: boolean; keepCurrent?: boolean }): Promise<StoredAgent>;
  attachEvaluation(id: string, version: number, evaluation: EvaluationReport): Promise<void>;
  uniqueId(base: string): string;
  /** Merges fields into spec.meta of one version, without a new version (for example the class of the agent). */
  setMeta?(id: string, version: number, meta: Record<string, unknown>): Promise<void>;
}

export interface Services {
  registry: Registry;
  store: AgentStoreLike;
  /** A shared headless browser for JavaScript pages (optional). */
  browser?: import("../runtime/browser.js").BrowserService;
  /** Build cost estimates from past builds (optional). */
  costModel?: { estimate(f: import("../runtime/costModel.js").BuildFeatures): Promise<import("../runtime/costModel.js").CostEstimate> };
  /** The Python sandbox for programs of agents (optional; docs/SANDBOX.md). */
  sandbox?: import("../runtime/sandbox.js").SandboxManager;
  /** The kind of the current run. Evaluation runs never send data out of the sandbox. */
  runKind?: import("./types.js").RunRecord["kind"];
  /** The top run of a run tree (docs/EFFECTS.md): the key of the effect record. A nested run has the id of its parent tree. */
  rootRunId?: string;
  /** The run reads live data again: the live fetch cache is off (docs/HEALTH.md). */
  freshData?: boolean;
  /** A dry run of the workflow editor: an action with a side effect gives a preview and does not go out (docs/WORKFLOW_EDITOR.md). */
  dryRun?: boolean;
  /** Connected MCP servers (optional). */
  mcp?: { call: import("./customClass.js").McpCaller };
  /** Runtime-defined node classes (optional so pure engine tests don't need it). */
  classes?: import("../runtime/classes.js").ClassService;
  /** Attached files (docs/FILES.md). */
  files?: import("../runtime/files.js").FileServiceLike;
  kv: KVStore;
  runAgent(ref: { agentId?: string; spec?: AgentSpec }, input: unknown, opts?: RunAgentOptions): Promise<RunAgentResult>;
}

export interface NodeContext<C = Record<string, unknown>> {
  runId: string;
  /** Set when the harness runs this attempt (strategy, extra tools, shared tool cache). */
  harness?: import("./harness.js").HarnessContext;
  node: NodeInstance;
  spec: AgentSpec;
  /** Config with templates resolved (except the class's lazyFields). */
  config: C;
  rawConfig: Record<string, unknown>;
  input: unknown;
  scope: Scope;
  brain: Brain;
  services: Services;
  signal: AbortSignal;
  depth: number;
  resolve(value: unknown, extra?: Scope): unknown;
  emit(e: RunEventInput): void;
  log(message: string, data?: unknown, level?: "info" | "warn" | "error"): void;
  addUsage(u: Partial<Usage>): void;
  waitForHuman(req: HumanRequest): Promise<unknown>;
  /** Direct predecessors and what happened to them. */
  upstream(): { nodeId: string; status: NodeStatus; output: unknown }[];
  /** The actions with a side effect that this attempt of the step did (docs/EFFECTS.md). The engine does not retry a step that did one. */
  effects?: { ran: number; seq?: Map<string, number> };
}

export interface NodeClass<C = any> {
  type: string;
  title: string;
  category: NodeCategory;
  /** One-paragraph description used in the builder manifest. */
  description: string;
  /** Guidance for the architect: when to pick this class. */
  whenToUse: string;
  configSchema: z.ZodType<C>;
  /** Authoritative JSON Schema for the config when the class is defined from JSON (custom classes). */
  jsonConfigSchema?: JSONSchema;
  /** Metadata for runtime-generated classes (shown in the UI and API). */
  custom?: { kind: string; status: string; secrets: string[]; approved: boolean; createdBy: string; version: number };
  /** A minimal, valid example config (shown to the builder). */
  example: Record<string, unknown>;
  /** Config fields left unresolved so the node can resolve them itself (e.g. per item). */
  lazyFields?: readonly string[];
  /** Hidden from the builder manifest (system/meta nodes). */
  internal?: boolean;
  sideEffects?: (config: C) => boolean;
  ports?: (config: C) => string[];
  outputSchema?: (config: C, ctx: StaticContext) => JSONSchema | undefined;
  /** Extra static checks beyond the config schema. */
  validate?: (config: C, ctx: StaticContext) => { message: string; path?: string; severity?: "error" | "warning"; hint?: string }[];
  defaultRetry?: { maxAttempts: number; backoffMs: number };
  /** Per-node timeout for this class (0 = none; bounded by the run's policy timeout). Falls back to the global default. */
  defaultTimeoutMs?: number;
  execute(ctx: NodeContext<C>): Promise<NodeResult>;
}

export interface NodeClassManifest {
  type: string;
  title: string;
  category: NodeCategory;
  description: string;
  whenToUse: string;
  configSchema: JSONSchema;
  example: Record<string, unknown>;
  ports: string;
  output: string;
  internal: boolean;
  outputSchema?: JSONSchema;
  custom?: NodeClass["custom"];
}

export function toJsonSchema(schema: z.ZodType): JSONSchema {
  const js = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JSONSchema;
  delete js.$schema;
  return js;
}

/** The config JSON Schema of a class (authoritative JSON for custom classes, derived from Zod otherwise). */
export function configJsonSchema(cls: NodeClass): JSONSchema {
  return cls.jsonConfigSchema ?? toJsonSchema(cls.configSchema);
}

/** Top-level config keys a class accepts (undefined when open-ended). */
export function configKeysOf(cls: NodeClass | undefined): string[] | undefined {
  if (!cls) return undefined;
  if (cls.jsonConfigSchema?.properties) return Object.keys(cls.jsonConfigSchema.properties);
  const shape = (cls.configSchema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : undefined;
}

export class Registry {
  private classes = new Map<string, NodeClass>();

  register(...classes: NodeClass[]): this {
    for (const c of classes) {
      if (this.classes.has(c.type)) throw new Error(`Node class ${c.type} already registered`);
      this.classes.set(c.type, c);
    }
    return this;
  }

  /** Add or replace a class at runtime (custom classes). Built-ins cannot be replaced. */
  upsert(c: NodeClass): this {
    const existing = this.classes.get(c.type);
    if (existing && !existing.custom) throw new Error(`Cannot replace built-in node class ${c.type}`);
    this.classes.set(c.type, c);
    return this;
  }

  remove(type: string): boolean {
    const existing = this.classes.get(type);
    if (!existing?.custom) return false;
    return this.classes.delete(type);
  }

  get(type: string): NodeClass | undefined {
    return this.classes.get(type);
  }

  list(opts: { includeInternal?: boolean } = {}): NodeClass[] {
    return [...this.classes.values()].filter((c) => opts.includeInternal || !c.internal);
  }

  types(opts: { includeInternal?: boolean } = {}): string[] {
    return this.list(opts).map((c) => c.type);
  }

  /** Success ports of a node, plus the implicit "error" port every node has. */
  portsOf(node: NodeInstance): string[] {
    const cls = this.get(node.type);
    let ports = ["out"];
    if (cls?.ports) {
      try {
        ports = cls.ports(node.config as never);
      } catch {
        /* invalid config — validator reports it */
      }
    }
    return [...ports, "error"];
  }

  manifest(opts: { includeInternal?: boolean } = {}): NodeClassManifest[] {
    return this.list(opts).map((c) => ({
      type: c.type,
      title: c.title,
      category: c.category,
      description: c.description,
      whenToUse: c.whenToUse,
      configSchema: configJsonSchema(c),
      example: c.example,
      ports: c.ports ? "dynamic (see description)" : "out",
      output: c.outputSchema ? "typed (see description)" : "any",
      internal: !!c.internal,
      outputSchema: c.custom && c.outputSchema ? c.outputSchema(c.example as never, { spec: undefined as never }) : undefined,
      custom: c.custom,
    }));
  }

  /** Compact text catalog for the architect prompt (cheap in tokens). */
  catalog(): string {
    return this.list()
      .map((c) => `- ${c.type} [${c.custom ? `custom ${c.custom.kind}` : c.category}] — ${c.description}\n  when: ${c.whenToUse}`)
      .join("\n");
  }
}
