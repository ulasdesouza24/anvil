import { nanoid } from "nanoid";
import type { AnvilConfig } from "../core/config.js";
import { type ExecuteResult } from "../core/engine.js";
import { executeWithHarness, type HarnessResult } from "../core/harness.js";
import { forgetRun } from "../core/tools/codeBridge.js";
import { redactSecrets } from "./secrets.js";
import type { Registry, RunAgentOptions, RunAgentResult, Services } from "../core/registry.js";
import { addUsage, emptyUsage, type AgentSpec, type HumanRequest, type RunEvent, type RunRecord } from "../core/types.js";
import { Brain, type ModelClient } from "../llm/brain.js";
import { SearchCache, type SearchCacheEntry } from "../llm/searchCache.js";
import { ownedByLiveProcess, type FileStore } from "../store/fileStore.js";
import type { ClassService } from "./classes.js";
import type { McpCaller } from "../core/customClass.js";

type Listener = (e: RunEvent, record: RunRecord) => void;

interface PendingWait {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  request: HumanRequest;
}

interface ActiveRun {
  record: RunRecord;
  ctrl: AbortController;
  listeners: Set<Listener>;
  waits: Map<string, PendingWait[]>;
  done: Promise<RunRecord>;
  persistTimer?: NodeJS.Timeout;
  /** The full output of each finished step of the current attempt (docs/RECOVERY.md). */
  checkpoint: NonNullable<RunRecord["checkpoint"]>;
}

export interface StartOptions {
  kind?: RunRecord["kind"];
  version?: number;
  parentRunId?: string;
  humanMode?: "interactive" | "auto";
  depth?: number;
  signal?: AbortSignal;
  waitForHuman?: RunAgentOptions["waitForHuman"];
  /** Called with the record right after creation (before execution). */
  onCreate?: (r: RunRecord) => void;
  /** Set when a trigger started the run. */
  trigger?: RunRecord["trigger"];
  /** Read live data again: no cached answer of a source (docs/HEALTH.md). */
  freshData?: boolean;
  /** The builder model of a best-of-N candidate (docs/SELECTION.md): the LLM calls of this run that name no model use it. */
  builderModel?: string;
  /** The top run of the run tree (docs/EFFECTS.md). Default: this run. */
  rootRunId?: string;
}

interface LaunchOptions extends StartOptions {
  /** A recovered run (docs/RECOVERY.md): the steps that finished before the restart, and the cost so far. */
  replay?: NonNullable<RunRecord["checkpoint"]>["nodes"];
  baseUsage?: RunRecord["usage"];
}

/** The cost that one event adds: an LLM call, a decision, or the cost of nested runs. */
function usageDelta(e: RunEvent): RunRecord["usage"] | undefined {
  if (e.type === "llm") return { ...emptyUsage(), llmCalls: 1, inputTokens: e.inputTokens, outputTokens: e.outputTokens, costUsd: e.costUsd };
  if (e.type === "decision") return { ...emptyUsage(), decisionCalls: 1, costUsd: e.costUsd };
  if (e.type === "usage") return e.usage;
  return undefined;
}

/** Auto-responses used when no human is in the loop (evaluations). */
function autoHuman(req: HumanRequest, why = "evaluation mode"): unknown {
  if (req.kind === "approval") return { approved: true, comment: `auto-approved (${why})` };
  return { answers: {}, skipped: true, comment: `skipped (${why})` };
}

/**
 * Owns the lifecycle of every run: creation, execution, event fan-out (SSE),
 * persistence, human-in-the-loop pauses, cancellation, and nested runs.
 */
export class RunManager {
  private active = new Map<string, ActiveRun>();
  /** The cost of nested runs that waits to go to each parent run (docs/RUNS.md). */
  private nestedUsage = new Map<string, { usage: RunRecord["usage"]; timer: NodeJS.Timeout }>();
  private finishedListeners = new Set<(r: RunRecord) => void>();
  readonly services: Services;
  readonly brain: Brain;

  constructor(
    private deps: {
      registry: Registry;
      client: ModelClient;
      store: FileStore;
      config: AnvilConfig;
      classes?: ClassService;
      mcp?: { call: McpCaller };
      costModel?: Services["costModel"];
      browser?: Services["browser"];
      sandbox?: Services["sandbox"];
      files?: Services["files"];
    },
  ) {
    this.brain = new Brain(
      deps.client,
      {},
      {
        searchCache: new SearchCache({
          ttlMs: deps.config.searchCacheTtlMs,
          max: 1000,
          persistence: {
            load: async () => (await deps.store.list("search_cache")) as Record<string, SearchCacheEntry>,
            save: (entries) => deps.store.replaceAll("search_cache", entries),
          },
        }),
      },
    );
    this.services = {
      registry: deps.registry,
      store: deps.store,
      kv: deps.store,
      classes: deps.classes,
      mcp: deps.mcp,
      costModel: deps.costModel,
      browser: deps.browser,
      sandbox: deps.sandbox,
      files: deps.files,
      runAgent: (ref, input, opts) => this.runNested(ref, input, opts),
    };
  }

  get store() {
    return this.deps.store;
  }

  private resolveSpec(ref: { agentId?: string; spec?: AgentSpec }, version?: number): AgentSpec {
    if (ref.spec) return ref.spec;
    if (!ref.agentId) throw new Error("runAgent requires agentId or spec");
    const spec = this.deps.store.getSpec(ref.agentId, version);
    if (!spec) throw new Error(`Agent "${ref.agentId}"${version ? ` v${version}` : ""} not found`);
    return spec;
  }

  /** Start a recorded run in the background. */
  start(ref: { agentId?: string; spec?: AgentSpec }, input: unknown, opts: StartOptions = {}): RunRecord {
    const spec = this.resolveSpec(ref, opts.version);
    const record: RunRecord = {
      id: `run_${nanoid(12)}`,
      pid: process.pid,
      agentId: spec.id,
      agentName: spec.name,
      version: spec.version,
      kind: opts.kind ?? "run",
      parentRunId: opts.parentRunId,
      trigger: opts.trigger,
      status: "running",
      input,
      startedAt: Date.now(),
      usage: emptyUsage(),
      nodeStates: Object.fromEntries(spec.nodes.map((n) => [n.id, "pending"])),
      events: [],
    };
    return this.launch(record, spec, opts);
  }

  /**
   * Starts the runs that waited for a person when the server stopped (docs/RECOVERY.md). The agent runs again:
   * the steps that finished before the restart replay from the checkpoint and do not run again, and the
   * waiting step asks the person again. Returns the ids of the recovered runs.
   */
  async recover(): Promise<string[]> {
    const out: string[] = [];
    for (const sum of this.deps.store.listRuns({ limit: Number.MAX_SAFE_INTEGER })) {
      if (sum.status !== "waiting" || this.active.has(sum.id)) continue;
      const record = await this.deps.store.getRun(sum.id);
      if (!record || record.status !== "waiting" || ownedByLiveProcess(record.pid)) continue;
      try {
        const spec = this.resolveSpec({ agentId: record.agentId }, record.version);
        const replay = record.checkpoint?.nodes ?? {};
        record.pid = process.pid;
        record.status = "running";
        record.events.push({
          type: "log",
          t: Date.now(),
          level: "warn",
          message: `recovered after a restart: ${Object.keys(replay).length} finished step(s) replay, and the waiting step asks again`,
        } as RunEvent);
        this.launch(record, spec, { kind: record.kind, trigger: record.trigger, replay, baseUsage: record.usage, humanMode: "interactive" });
        out.push(record.id);
      } catch (e) {
        record.status = "failed";
        record.error = `Interrupted: the server stopped while this run waited, and the run cannot start again: ${(e as Error).message}`;
        record.endedAt = Date.now();
        delete record.checkpoint;
        await this.deps.store.saveRun(record);
      }
    }
    return out;
  }

  private launch(record: RunRecord, spec: AgentSpec, opts: LaunchOptions): RunRecord {
    const ctrl = new AbortController();
    opts.signal?.addEventListener("abort", () => ctrl.abort());
    const run: ActiveRun = { record, ctrl, listeners: new Set(), waits: new Map(), done: undefined as never, checkpoint: { nodes: {} } };
    this.active.set(record.id, run);
    opts.onCreate?.(record);
    const rootRunId = opts.rootRunId ?? record.id;

    run.done = (async () => {
      // Unattended mode: no run waits for a person, unless the caller asks for it.
      const humanMode = opts.humanMode ?? (this.deps.config.unattended ? "auto" : "interactive");
      let result: ExecuteResult & { harness?: HarnessResult["harness"] };
      try {
        result = await executeWithHarness(
          spec,
          record.input,
          {
            registry: this.deps.registry,
            // A best-of-N candidate builds with its own model. Its nested runs (the tests) use the shared brain.
            brain: opts.builderModel ? this.brain.with({ model: opts.builderModel }) : this.brain,
            services: this.servicesFor(record.id, humanMode, record.kind, opts.freshData, rootRunId),
            maxParallel: this.deps.config.maxParallel,
            nodeTimeoutMs: this.deps.config.nodeTimeoutMs,
            maxPaidSearches: this.deps.config.maxPaidSearchesPerRun,
          },
          {
            runId: record.id,
            signal: ctrl.signal,
            depth: opts.depth ?? 0,
            emit: (e) => this.onEvent(run, e),
            replay: opts.replay,
            onNodeDone: (nodeId, output, ports) => {
              run.checkpoint.nodes[nodeId] = { output: redactSecrets(output), ports };
            },
            maxAttempts: record.kind === "eval" ? this.deps.config.harnessEvalAttempts : this.deps.config.harnessMaxAttempts,
            waitForHuman: (nodeId, req, signal) => {
              if (humanMode === "auto") {
                // The record: an unattended run shows each step that it approved or skipped without a person.
                const why = record.kind === "eval" ? "evaluation mode" : "unattended mode";
                this.onEvent(run, {
                  type: "log",
                  t: Date.now(),
                  nodeId,
                  level: "warn",
                  message: `${req.kind === "approval" ? "auto-approved" : "skipped"} without a person (${why}): ${req.title}`,
                } as RunEvent);
                return Promise.resolve(autoHuman(req, why));
              }
              if (opts.waitForHuman) return opts.waitForHuman(nodeId, req, signal);
              return this.waitFor(run, nodeId, req, signal);
            },
          },
        );
      } catch (e) {
        result = {
          status: "failed",
          output: null,
          error: (e as Error).message,
          usage: record.usage,
          nodeOutputs: {},
          nodeStates: record.nodeStates,
          durationMs: Date.now() - record.startedAt,
        };
      }
      // The sandbox container of the run goes away with the run.
      await this.services.sandbox?.release(record.id).catch(() => undefined);
      forgetRun(record.id);
      // The final usage counts each nested call: a live sum that still waits must not add it again (docs/RUNS.md).
      const pendingUsage = this.nestedUsage.get(record.id);
      if (pendingUsage) {
        clearTimeout(pendingUsage.timer);
        this.nestedUsage.delete(record.id);
      }
      record.endedAt = Date.now();
      record.status = result.status;
      record.output = redactSecrets(result.output);
      record.error = redactSecrets(result.error);
      record.usage = opts.baseUsage ? addUsage(structuredClone(opts.baseUsage), result.usage) : result.usage;
      delete record.checkpoint;
      if (result.harness && result.harness.status !== "off") record.harness = result.harness;
      if (run.persistTimer) clearTimeout(run.persistTimer);
      await this.deps.store.saveRun(record);
      for (const waits of run.waits.values()) for (const w of waits) w.reject(new Error("run ended"));
      this.active.delete(record.id);
      for (const l of this.finishedListeners) {
        try {
          l(record);
        } catch (e) {
          console.error("[runs] finished listener failed:", e);
        }
      }
      // Keep listeners informed that the record is final.
      for (const l of run.listeners) l({ type: "log", t: Date.now(), level: "info", message: "__final__" }, record);
      run.listeners.clear();
      return record;
    })();
    return record;
  }

  /** Start and wait for completion. */
  async run(ref: { agentId?: string; spec?: AgentSpec }, input: unknown, opts: StartOptions = {}): Promise<RunRecord> {
    const r = this.start(ref, input, opts);
    return this.active.get(r.id)!.done;
  }

  private servicesFor(runId: string, humanMode: "interactive" | "auto", runKind?: RunRecord["kind"], freshData?: boolean, rootRunId = runId): Services {
    return {
      ...this.services,
      runKind,
      rootRunId,
      ...(freshData ? { freshData } : {}),
      // A nested run reads fresh data when its parent does, and keeps the root of the run tree (docs/EFFECTS.md).
      runAgent: (ref, input, opts = {}) =>
        this.runNested(ref, input, {
          ...opts,
          parentRunId: opts.parentRunId ?? runId,
          humanMode: opts.humanMode ?? humanMode,
          freshData: opts.freshData ?? freshData,
          rootRunId: opts.rootRunId ?? rootRunId,
        }),
    };
  }

  private async runNested(ref: { agentId?: string; spec?: AgentSpec }, input: unknown, opts: RunAgentOptions = {}): Promise<RunAgentResult> {
    const spec = this.resolveSpec(ref, opts.version);
    if (opts.record) {
      const rec = await this.run({ spec }, input, {
        kind: opts.kind ?? "run",
        parentRunId: opts.parentRunId,
        humanMode: opts.humanMode,
        depth: opts.depth,
        signal: opts.signal,
        waitForHuman: opts.waitForHuman,
        freshData: opts.freshData,
        builderModel: opts.builderModel,
        rootRunId: opts.rootRunId,
      });
      const nodeOutputs: Record<string, unknown> = {};
      const nodeConfigs: Record<string, unknown> = {};
      for (const e of rec.events) {
        if (e.type === "node.completed") nodeOutputs[e.nodeId] = e.output;
        if (e.type === "node.started" && e.config !== undefined) nodeConfigs[e.nodeId] = e.config;
      }
      return {
        output: rec.output,
        nodeConfigs,
        usage: rec.usage,
        runId: rec.id,
        status: rec.status === "completed" ? "completed" : "failed",
        error: rec.error,
        nodeOutputs,
        nodeStates: rec.nodeStates,
        harness: rec.harness,
      };
    }
    const runId = `sub_${nanoid(10)}`;
    // An unrecorded sub-agent run gets one attempt: the harness of the parent run handles its failure.
    const result = await executeWithHarness(
      spec,
      input,
      {
        registry: this.deps.registry,
        brain: this.brain,
        services: this.servicesFor(runId, opts.humanMode ?? (this.deps.config.unattended ? "auto" : "interactive"), undefined, opts.freshData, opts.rootRunId ?? runId),
        maxParallel: this.deps.config.maxParallel,
        nodeTimeoutMs: this.deps.config.nodeTimeoutMs,
        maxPaidSearches: this.deps.config.maxPaidSearchesPerRun,
      },
      {
        runId,
        signal: opts.signal,
        depth: opts.depth ?? 1,
        // An unrecorded sub-agent run has no record: its cost goes to the parent run while it works.
        emit: (e) => {
          const d = usageDelta(e);
          if (d && opts.parentRunId) this.queueUsage(opts.parentRunId, d);
        },
        maxAttempts: 1,
        waitForHuman: (nodeId, req, signal) => {
          if ((opts.humanMode ?? (this.deps.config.unattended ? "auto" : "interactive")) === "auto")
            return Promise.resolve(autoHuman(req, opts.humanMode === "auto" ? "evaluation mode" : "unattended mode"));
          if (opts.waitForHuman) return opts.waitForHuman(nodeId, req, signal);
          return Promise.reject(new Error("Human input is not available in this nested run"));
        },
      },
    );
    await this.services.sandbox?.release(runId).catch(() => undefined);
    forgetRun(runId);
    return {
      output: result.output,
      usage: result.usage,
      runId,
      status: result.status === "completed" ? "completed" : "failed",
      error: result.error,
      nodeOutputs: result.nodeOutputs,
      nodeStates: result.nodeStates,
      harness: result.harness.status === "off" ? undefined : result.harness,
    };
  }

  private onEvent(run: ActiveRun, raw: RunEvent) {
    const r = run.record;
    // Logs and traces never show a secret value (docs/SECRETS.md).
    const e = redactSecrets(raw);
    r.events.push(e);
    switch (e.type) {
      case "node.started":
        r.nodeStates[e.nodeId] = "running";
        break;
      case "node.completed":
        r.nodeStates[e.nodeId] = "done";
        break;
      case "node.skipped":
        r.nodeStates[e.nodeId] = "skipped";
        break;
      case "node.failed":
        if (!e.willRetry) r.nodeStates[e.nodeId] = "failed";
        break;
      case "run.started":
        // A new attempt of the harness starts again from the input: its checkpoint starts empty.
        run.checkpoint.nodes = {};
        break;
      case "node.waiting":
        r.nodeStates[e.nodeId] = "waiting";
        r.status = "waiting";
        // The checkpoint goes to disk at once (docs/RECOVERY.md): a restart during the wait does not lose the run.
        r.checkpoint = run.checkpoint;
        void this.deps.store.saveRun(r);
        break;
      case "node.resumed":
        r.nodeStates[e.nodeId] = "running";
        r.status = "running";
        if (!Object.values(r.nodeStates).includes("waiting")) delete r.checkpoint;
        break;
      case "usage":
        addUsage(r.usage, e.usage);
        break;
      case "llm":
      case "decision":
        r.usage.costUsd += e.costUsd;
        if (e.type === "llm") {
          r.usage.llmCalls++;
          r.usage.inputTokens += e.inputTokens;
          r.usage.outputTokens += e.outputTokens;
        } else r.usage.decisionCalls++;
        break;
      case "artifact":
        if (e.kind === "published" && e.data && typeof e.data === "object" && "agentId" in e.data) r.resultAgentId = String((e.data as { agentId: string }).agentId);
        break;
    }
    // The cost of a nested run also goes to its parent while it works, so the parent shows the full cost live.
    const d = usageDelta(e);
    if (d && r.parentRunId) this.queueUsage(r.parentRunId, d);
    for (const l of run.listeners) {
      try {
        l(e, r);
      } catch {
        /* a broken listener must not break the run */
      }
    }
    if (!run.persistTimer) {
      run.persistTimer = setTimeout(() => {
        run.persistTimer = undefined;
        if (this.active.has(r.id)) void this.deps.store.saveRun(r);
      }, 400);
    }
  }

  /** Adds a cost to the parent run. The parent gets one "usage" event for each liveUsageMs, not one for each call. */
  private queueUsage(parentRunId: string, d: RunRecord["usage"]) {
    if (!this.active.has(parentRunId) || this.active.get(parentRunId)!.record.endedAt !== undefined) return;
    const q = this.nestedUsage.get(parentRunId);
    if (q) {
      addUsage(q.usage, d);
      return;
    }
    const timer = setTimeout(() => {
      const item = this.nestedUsage.get(parentRunId);
      this.nestedUsage.delete(parentRunId);
      const parent = this.active.get(parentRunId);
      if (item && parent && parent.record.endedAt === undefined) this.onEvent(parent, { type: "usage", t: Date.now(), usage: item.usage } as RunEvent);
    }, this.deps.config.liveUsageMs ?? 2000);
    timer.unref?.();
    this.nestedUsage.set(parentRunId, { usage: addUsage(emptyUsage(), d), timer });
  }

  private waitFor(run: ActiveRun, nodeId: string, request: HumanRequest, signal: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const list = run.waits.get(nodeId) ?? [];
      const entry: PendingWait = { resolve, reject, request };
      list.push(entry);
      run.waits.set(nodeId, list);
      signal.addEventListener("abort", () => {
        const l = run.waits.get(nodeId);
        if (l)
          run.waits.set(
            nodeId,
            l.filter((w) => w !== entry),
          );
        reject(new Error("cancelled while waiting for human input"));
      });
    });
  }

  /** Subscribe to every recorded run finishing (used by agent-chain triggers). */
  onFinished(listener: (r: RunRecord) => void): () => void {
    this.finishedListeners.add(listener);
    return () => this.finishedListeners.delete(listener);
  }

  /** Recorded runs of an agent that are still active. */
  activeRunsOf(agentId: string, filter?: (r: RunRecord) => boolean): RunRecord[] {
    return [...this.active.values()].map((a) => a.record).filter((r) => r.agentId === agentId && (!filter || filter(r)));
  }

  resume(runId: string, nodeId: string, value: unknown): boolean {
    const run = this.active.get(runId);
    const list = run?.waits.get(nodeId);
    if (!run || !list?.length) return false;
    const w = list.shift()!;
    if (!list.length) run.waits.delete(nodeId);
    w.resolve(value);
    return true;
  }

  pendingRequests(runId: string): { nodeId: string; request: HumanRequest }[] {
    const run = this.active.get(runId);
    if (!run) return [];
    return [...run.waits.entries()].flatMap(([nodeId, ws]) => ws.map((w) => ({ nodeId, request: w.request })));
  }

  cancel(runId: string): boolean {
    const run = this.active.get(runId);
    if (!run) return false;
    run.ctrl.abort();
    return true;
  }

  isActive(runId: string) {
    return this.active.has(runId);
  }

  activeRecord(runId: string): RunRecord | undefined {
    return this.active.get(runId)?.record;
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.active.get(runId)?.record ?? (await this.deps.store.getRun(runId));
  }

  subscribe(runId: string, listener: Listener): (() => void) | null {
    const run = this.active.get(runId);
    if (!run) return null;
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  async waitForRun(runId: string): Promise<RunRecord | undefined> {
    const run = this.active.get(runId);
    if (run) return run.done;
    return this.deps.store.getRun(runId);
  }
}
