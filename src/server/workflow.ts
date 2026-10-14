import type { Hono } from "hono";
import type { NodeCategory, Registry, StaticContext } from "../core/registry.js";
import type { AgentSpec, JSONSchema, RunRecord, StoredAgent } from "../core/types.js";
import { validateSpec } from "../core/validator.js";
import { ancestorsOf, diffSpecs, mergeSpecs } from "../core/workflow.js";
import type { RunManager } from "../runtime/runManager.js";
import type { TriggerManager } from "../runtime/triggers.js";
import type { FileStore, WorkflowDraft } from "../store/fileStore.js";

/**
 * The API of the workflow editor (docs/WORKFLOW_EDITOR.md): drafts, the static view of a draft (ports, output
 * schemas, diagnostics), test runs of a draft, the AI assistant, and the test webhook.
 */

export interface NodeInspection {
  /** The ports of the step, with the implicit "error" port last. */
  ports: string[];
  outputSchema?: JSONSchema;
  sideEffects: boolean;
  category?: NodeCategory;
  title?: string;
}

/** The static view of a spec for the canvas: what the compiler says, and the ports and output fields of each step. */
export function inspectSpec(spec: AgentSpec, registry: Registry, getAgent: (id: string) => StoredAgent | undefined) {
  const validation = validateSpec(spec, registry, { getAgent });
  const ctx: StaticContext = { spec: validation.spec ?? spec, getAgent, registry };
  const nodes: Record<string, NodeInspection> = {};
  for (const n of spec.nodes ?? []) {
    if (!n || typeof n.id !== "string") continue;
    const cls = registry.get(n.type);
    const parsed = cls?.configSchema.safeParse(n.config ?? {});
    const config = parsed?.success ? parsed.data : (n.config ?? {});
    let outputSchema: JSONSchema | undefined;
    let sideEffects = false;
    try {
      outputSchema = cls?.outputSchema?.(config as never, ctx);
    } catch {
      outputSchema = undefined;
    }
    try {
      sideEffects = !!cls?.sideEffects?.(config as never);
    } catch {
      sideEffects = false;
    }
    nodes[n.id] = { ports: registry.portsOf({ ...n, config: config as Record<string, unknown> }), outputSchema, sideEffects, category: cls?.category, title: cls?.title };
  }
  return { valid: validation.valid, errors: validation.errors, warnings: validation.warnings, diagnostics: validation.diagnostics, nodes };
}

/** A blank agent: an input step and an output step. */
export function blankSpec(id: string, name: string): AgentSpec {
  return {
    specVersion: "anvil/v1",
    id,
    name,
    description: "",
    version: 1,
    inputSchema: { type: "object", properties: { text: { type: "string", description: "The input text" } } },
    nodes: [
      { id: "input", type: "input", name: "Input", config: {}, position: { x: 0, y: 0 } },
      { id: "output", type: "output", name: "Output", config: { value: { text: "{{input.text}}" } }, position: { x: 320, y: 0 } },
    ],
    edges: [{ from: "input", to: "output" }],
    policy: { maxCostUsd: 0.5, maxNodeExecutions: 500, timeoutMs: 600_000, requireApprovalForSideEffects: false },
    tests: [],
    meta: { createdIn: "workflow-editor" },
  };
}

/** The full data of each finished step of a run: the step data of an editor run, or the outputs in its events. */
export function stepDataOf(run: RunRecord): Record<string, { output: unknown; ports: string[] }> {
  if (run.stepData) return run.stepData;
  const out: Record<string, { output: unknown; ports: string[] }> = {};
  for (const e of run.events) if (e.type === "node.completed") out[e.nodeId] = { output: e.output, ports: e.ports };
  return out;
}

export function mountWorkflow(
  app: Hono,
  deps: {
    store: FileStore;
    runs: RunManager;
    registry: Registry;
    triggers: TriggerManager;
    dataDir: string;
    summarize: (a: StoredAgent) => unknown;
  },
) {
  const { store, runs, registry, triggers } = deps;
  const getAgent = (id: string) => store.getAgent(id);
  const editable = (id: string): StoredAgent | Response => {
    const a = store.getAgent(id);
    if (!a) return Response.json({ error: "not found" }, { status: 404 });
    if (a.system) return Response.json({ error: "System agents are defined in code (src/builder/systemAgents.ts)" }, { status: 403 });
    return a;
  };

  /* ---- static view ---- */
  app.post("/api/workflow/inspect", async (c) => {
    const { spec } = await c.req.json<{ spec: AgentSpec }>();
    if (!spec || typeof spec !== "object") return c.json({ error: "spec is required" }, 400);
    return c.json(inspectSpec(spec, registry, getAgent));
  });

  /** Compare two specs, or merge a draft with a newer version (three-way, by step id). */
  app.post("/api/workflow/diff", async (c) => {
    const { a, b } = await c.req.json<{ a: AgentSpec; b: AgentSpec }>();
    return c.json(diffSpecs(a, b));
  });
  app.post("/api/workflow/merge", async (c) => {
    const { base, ours, theirs } = await c.req.json<{ base: AgentSpec; ours: AgentSpec; theirs: AgentSpec }>();
    return c.json(mergeSpecs(base, ours, theirs));
  });

  /* ---- new agents ---- */
  app.post("/api/agents/blank", async (c) => {
    const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
    const name = body.name?.trim() || "New workflow";
    const id = store.uniqueId(name);
    const saved = await store.saveVersion(blankSpec(id, name), { note: "created in the workflow editor" });
    return c.json(deps.summarize(saved), 201);
  });

  /* ---- drafts ---- */
  app.get("/api/agents/:id/draft", async (c) => {
    const d = await store.getDraft(c.req.param("id"));
    return d ? c.json(d) : c.json({ error: "no draft" }, 404);
  });

  app.put("/api/agents/:id/draft", async (c) => {
    const a = editable(c.req.param("id"));
    if (a instanceof Response) return a;
    const body = await c.req.json<Partial<WorkflowDraft>>();
    if (!body.spec || typeof body.spec !== "object") return c.json({ error: "spec is required" }, 400);
    const prior = await store.getDraft(a.id);
    const draft: WorkflowDraft = {
      agentId: a.id,
      baseVersion: body.baseVersion ?? prior?.baseVersion ?? a.currentVersion,
      spec: { ...body.spec, id: a.id },
      pinData: body.pinData ?? prior?.pinData,
      testInput: body.testInput ?? prior?.testInput,
      updatedAt: Date.now(),
    };
    await store.saveDraft(draft);
    return c.json({ ok: true, updatedAt: draft.updatedAt, latestVersion: store.latestVersion(a.id) });
  });

  app.delete("/api/agents/:id/draft", async (c) => c.json({ deleted: await store.deleteDraft(c.req.param("id")) }));

  /** Save the draft as a new version. A newer version than the base gives 409 with the data for a merge. */
  app.post("/api/agents/:id/draft/save", async (c) => {
    const a = editable(c.req.param("id"));
    if (a instanceof Response) return a;
    const body = await c.req.json<{ spec: AgentSpec; baseVersion: number; note?: string; force?: boolean }>();
    const latest = store.latestVersion(a.id)!;
    if (!body.force && body.baseVersion < latest) {
      const base = store.getSpec(a.id, body.baseVersion);
      const theirs = store.getSpec(a.id, latest)!;
      return c.json(
        {
          error: `A newer version (v${latest}) came after v${body.baseVersion}. Merge the draft with it, then save again.`,
          conflict: true,
          baseVersion: body.baseVersion,
          latestVersion: latest,
          ...(base ? { merge: mergeSpecs(base, { ...body.spec, id: a.id }, theirs) } : {}),
          theirs,
        },
        409,
      );
    }
    if (runs.activeFor(a.id).length) return c.json({ error: "A build, refine or evolve run changes this agent now. Wait for it to end, then save." }, 409);
    const r = validateSpec({ ...body.spec, id: a.id }, registry, { getAgent });
    if (!r.valid) return c.json({ error: "The workflow has errors", diagnostics: r.diagnostics }, 400);
    const saved = await store.saveVersion({ ...r.spec!, id: a.id }, { note: body.note?.trim() || "edited in the workflow editor" });
    await store.deleteDraft(a.id);
    return c.json({ agent: deps.summarize(saved), version: saved.currentVersion });
  });

  /* ---- test runs ---- */
  app.post("/api/workflow/run", async (c) => {
    const body = await c.req.json<{
      agentId: string;
      spec: AgentSpec;
      input?: unknown;
      mode?: "full" | "to_node" | "node_only";
      target?: string;
      pinData?: Record<string, { output: unknown; ports?: string[] }>;
      reuseRunId?: string;
      dryRun?: boolean;
    }>();
    const a = editable(body.agentId);
    if (a instanceof Response) return a;
    const spec: AgentSpec = { ...body.spec, id: a.id };
    const v = validateSpec(spec, registry, { getAgent });
    if (!v.valid) return c.json({ error: "The workflow has errors: fix them before a test run", diagnostics: v.diagnostics }, 400);
    const mode = body.mode ?? "full";
    if (mode !== "full" && (!body.target || !v.spec!.nodes.some((n) => n.id === body.target))) return c.json({ error: "target must name a step of the workflow" }, 400);
    let pinned = { ...(body.pinData ?? {}) };
    let input: unknown = body.input ?? {};
    if (mode === "node_only") {
      // The steps before the target use the data of an earlier run (or pinned data): only the target runs again.
      const prev = body.reuseRunId ? await runs.getRun(body.reuseRunId) : undefined;
      if (body.reuseRunId && !prev) return c.json({ error: `run ${body.reuseRunId} not found` }, 404);
      const data = prev ? stepDataOf(prev) : {};
      if (prev && body.input === undefined) input = prev.input;
      for (const id of ancestorsOf(v.spec!, body.target!)) if (!pinned[id] && data[id]) pinned[id] = data[id];
    }
    // A pinned step that is not in the spec does nothing.
    pinned = Object.fromEntries(Object.entries(pinned).filter(([id]) => v.spec!.nodes.some((n) => n.id === id)));
    const r = runs.start({ spec: v.spec! }, input, {
      kind: "run",
      origin: "editor",
      dryRun: body.dryRun !== false,
      pinned,
      ...(mode !== "full" ? { targetNodeId: body.target } : {}),
    });
    return c.json({ runId: r.id }, 202);
  });

  /* ---- the AI assistant ---- */
  app.post("/api/workflow/assist", async (c) => {
    const body = await c.req.json<{ agentId: string; spec: AgentSpec; instruction: string; selection?: string[] }>();
    if (!body.instruction?.trim()) return c.json({ error: "instruction is required" }, 400);
    const a = editable(body.agentId);
    if (a instanceof Response) return a;
    const focus = body.selection?.length ? `\nThe change is about these steps: ${body.selection.join(", ")}.` : "";
    const r = runs.start({ agentId: "anvil-assistant" }, { spec: { ...body.spec, id: a.id }, instruction: `${body.instruction.trim()}${focus}` }, { kind: "refine" });
    return c.json({ runId: r.id }, 202);
  });

  /* ---- test webhook ---- */
  app.post("/api/agents/:id/triggers/:tid/listen", async (c) => {
    const body = await c.req.json<{ timeoutMs?: number }>().catch(() => ({}) as { timeoutMs?: number });
    const timeoutMs = Math.min(Math.max(body.timeoutMs ?? 120_000, 1000), 300_000);
    try {
      const event = await triggers.listenForTest(c.req.param("id"), c.req.param("tid"), timeoutMs, c.req.raw.signal);
      return event ? c.json({ captured: true, event }) : c.json({ captured: false });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
}
