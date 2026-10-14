import { describe, expect, it } from "vitest";
import { validateSpec } from "../src/core/validator.js";
import type { AgentSpec } from "../src/core/types.js";
import { FakeClient, anvilWith } from "./helpers.js";

const spec = (nodes: AgentSpec["nodes"], edges: AgentSpec["edges"], extra: Partial<AgentSpec> = {}): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "wf",
  name: "wf",
  description: "",
  version: 1,
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  nodes,
  edges,
  policy: { maxCostUsd: 1, maxNodeExecutions: 100, timeoutMs: 60_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
  ...extra,
});

/** input → a → b → output, with transforms that pass the text on. */
const chain = (over: Partial<Record<"a" | "b", Partial<AgentSpec["nodes"][number]>>> = {}) =>
  spec(
    [
      { id: "input", type: "input", config: {} },
      { id: "a", type: "transform", config: { value: { text: "A:{{input.text}}" } }, ...over.a },
      { id: "b", type: "transform", config: { value: { text: "{{nodes.a.output.text ?? 'none'}}+B" } }, ...over.b },
      { id: "output", type: "output", config: { value: { text: "{{nodes.b.output.text}}" } } },
    ],
    [
      { from: "input", to: "a" },
      { from: "a", to: "b" },
      { from: "b", to: "output" },
    ],
  );

describe("workflow editor: engine", () => {
  it("skips a disabled step, keeps its out edge active, and gives it an empty output", async () => {
    const anvil = await anvilWith(new FakeClient());
    const rec = await anvil.runs.run({ spec: chain({ a: { disabled: true } }) }, { text: "x" });
    expect(rec.status).toBe("completed");
    expect(rec.nodeStates).toMatchObject({ a: "skipped", b: "done", output: "done" });
    expect(rec.output).toEqual({ text: "none+B" });
    expect(rec.events.some((e) => e.type === "node.skipped" && e.nodeId === "a" && e.reason === "disabled")).toBe(true);
  });

  it("uses pinned output and does not run the pinned step", async () => {
    const anvil = await anvilWith(new FakeClient());
    const rec = await anvil.runs.run({ spec: chain() }, { text: "x" }, { pinned: { a: { output: { text: "PIN" } } } });
    expect(rec.output).toEqual({ text: "PIN+B" });
    expect(rec.events.some((e) => e.type === "node.started" && e.nodeId === "a")).toBe(false);
  });

  it("stops a partial run at the target step and gives its output", async () => {
    const anvil = await anvilWith(new FakeClient());
    const rec = await anvil.runs.run({ spec: chain() }, { text: "x" }, { targetNodeId: "a", origin: "editor" });
    expect(rec.status).toBe("completed");
    expect(rec.output).toEqual({ text: "A:x" });
    expect(rec.nodeStates).toMatchObject({ a: "done", b: "pending", output: "pending" });
    expect(rec).toMatchObject({ origin: "editor", targetNodeId: "a" });
  });

  it("fails a partial run with an unknown target step", async () => {
    const anvil = await anvilWith(new FakeClient());
    const rec = await anvil.runs.run({ spec: chain() }, { text: "x" }, { targetNodeId: "nope" });
    expect(rec.status).toBe("failed");
    expect(rec.error).toMatch(/Unknown target step "nope"/);
  });

  it("gives a preview for a webhook and a POST in a dry run, and sends nothing", async () => {
    const anvil = await anvilWith(new FakeClient());
    process.env.WF_TEST_HOOK = "http://127.0.0.1:9/never";
    const s = spec(
      [
        { id: "input", type: "input", config: {} },
        { id: "post", type: "http", config: { method: "POST", url: "http://127.0.0.1:9/x", body: { a: 1 } } },
        { id: "hook", type: "send_webhook", config: { urlSecret: "WF_TEST_HOOK", body: { t: "{{input.text}}" } } },
        { id: "output", type: "output", config: { value: { post: "{{nodes.post.output.body}}", hook: "{{nodes.hook.output}}" } } },
      ],
      [
        { from: "input", to: "post" },
        { from: "post", to: "hook" },
        { from: "hook", to: "output" },
      ],
    );
    const rec = await anvil.runs.run({ spec: s }, { text: "x" }, { dryRun: true });
    expect(rec.status).toBe("completed");
    expect(rec.dryRun).toBe(true);
    const out = rec.output as { post: { dryRun: boolean; action: string }; hook: { sent: boolean; dryRun: boolean } };
    expect(out.post).toMatchObject({ dryRun: true, action: "http" });
    expect(out.hook).toMatchObject({ sent: false, dryRun: true });
  });
});

describe("workflow editor: validator", () => {
  const codes = (s: AgentSpec, anvil: Awaited<ReturnType<typeof anvilWith>>) => validateSpec(s, anvil.registry).diagnostics.map((d) => d.code);

  it("does not let the input or the output step be disabled", async () => {
    const anvil = await anvilWith(new FakeClient());
    const s = chain();
    s.nodes[3].disabled = true;
    expect(codes(s, anvil)).toContain("DISABLED_IO");
  });

  it("warns when a step reads a disabled step without a fallback", async () => {
    const anvil = await anvilWith(new FakeClient());
    const s = chain({ b: { disabled: true } });
    const d = validateSpec(s, anvil.registry).diagnostics.find((x) => x.code === "DISABLED_NODE_REFERENCED");
    expect(d).toMatchObject({ severity: "warning", nodeId: "output" });
    // The fallback in b makes the reference of a safe.
    expect(codes(chain({ a: { disabled: true } }), anvil)).not.toContain("DISABLED_NODE_REFERENCED");
  });

  it("does not count a disabled approval step as a gate", async () => {
    const anvil = await anvilWith(new FakeClient());
    const s = spec(
      [
        { id: "input", type: "input", config: {} },
        { id: "approve", type: "human_approval", config: { title: "Send?" }, disabled: true },
        { id: "hook", type: "send_webhook", config: { urlSecret: "WF_TEST_HOOK", body: { t: "{{input.text}}" } } },
        { id: "output", type: "output", config: { value: { ok: true } } },
      ],
      [
        { from: "input", to: "approve" },
        { from: "approve", to: "hook" },
        { from: "hook", to: "output" },
      ],
      { policy: { maxCostUsd: 1, maxNodeExecutions: 100, timeoutMs: 60_000, requireApprovalForSideEffects: true } },
    );
    const d = validateSpec(s, anvil.registry).diagnostics.find((x) => x.code === "UNGATED_SIDE_EFFECT");
    expect(d).toMatchObject({ severity: "error", nodeId: "hook" });
    s.nodes[1].disabled = false;
    expect(codes(s, anvil)).not.toContain("UNGATED_SIDE_EFFECT");
  });
});

/* ------------------------------------------------------------------ */
/* Pure helpers, the API, and the builder                             */
/* ------------------------------------------------------------------ */

import { Hono } from "hono";
import { diffSpecs, lockedViolations, makesCycle, mergeSpecs, renameNodeId, restoreLocked, uniqueNodeId } from "../src/core/workflow.js";
import { blankSpec, inspectSpec, mountWorkflow } from "../src/server/workflow.js";
import { TriggerManager } from "../src/runtime/triggers.js";

describe("workflow editor: pure helpers", () => {
  it("renames a step and each reference to it in templates, code and edges", () => {
    const s = chain();
    s.nodes.push({ id: "calc", type: "code", config: { code: 'return nodes.a.output.text + nodes["a"].output.text + nodes.ab;' } });
    s.edges.push({ from: "a", to: "calc" });
    const r = renameNodeId(s, "a", "first");
    expect(r.nodes.map((n) => n.id)).toEqual(["input", "first", "b", "output", "calc"]);
    expect(JSON.stringify(r.nodes[2].config)).toContain("nodes.first.output.text");
    expect((r.nodes[4].config as { code: string }).code).toBe('return nodes.first.output.text + nodes["first"].output.text + nodes.ab;');
    expect(r.edges).toContainEqual({ from: "input", to: "first" });
    expect(() => renameNodeId(s, "a", "b")).toThrow(/already used/);
    expect(() => renameNodeId(s, "a", "Bad Id")).toThrow(/not a valid step id/);
  });

  it("gives free ids, finds cycles, and compares two specs", () => {
    expect(uniqueNodeId(chain(), "A")).toBe("a_2");
    expect(uniqueNodeId(chain(), "Send to Slack!")).toBe("send_to_slack");
    expect(makesCycle(chain(), "b", "a")).toBe(true);
    expect(makesCycle(chain(), "a", "output")).toBe(false);
    const b = chain();
    b.nodes[1] = { ...b.nodes[1], name: "A step", position: { x: 1, y: 2 } };
    b.nodes[2] = { ...b.nodes[2], position: { x: 5, y: 5 } };
    b.nodes.push({ id: "c", type: "transform", config: { value: 1 } });
    b.edges.push({ from: "b", to: "c" });
    const d = diffSpecs(chain(), b);
    expect(d).toMatchObject({ added: ["c"], removed: [], moved: ["b"], edgesAdded: [{ from: "b", to: "c" }] });
    expect(d.changed).toEqual([{ id: "a", fields: ["name"] }]);
  });

  it("merges a draft with a newer version and reports a conflict", () => {
    const base = chain();
    const ours = chain();
    ours.nodes[1].config = { value: { text: "ours" } };
    ours.nodes.push({ id: "mine", type: "transform", config: { value: 1 } });
    ours.edges.push({ from: "a", to: "mine" });
    const theirs = { ...chain(), version: 2 };
    theirs.nodes[2].config = { value: { text: "theirs" } };
    theirs.nodes.push({ id: "theirs_step", type: "transform", config: { value: 2 } });
    const m = mergeSpecs(base, ours, theirs);
    expect(m.conflicts).toEqual([]);
    expect(m.spec.version).toBe(2);
    expect(m.spec.nodes.map((n) => n.id)).toEqual(["input", "a", "b", "output", "mine", "theirs_step"]);
    expect(m.spec.nodes[1].config).toEqual({ value: { text: "ours" } });
    expect(m.spec.nodes[2].config).toEqual({ value: { text: "theirs" } });
    theirs.nodes[1].config = { value: { text: "also changed" } };
    expect(mergeSpecs(base, ours, theirs).conflicts).toEqual([{ kind: "node", id: "a" }]);
  });

  it("finds and restores a changed locked step, and ignores its position", () => {
    const before = chain({ a: { locked: true } });
    const after = chain();
    after.nodes[1] = { ...after.nodes[1], config: { value: "changed" }, position: { x: 9, y: 9 } };
    expect(lockedViolations(before, after)).toEqual(["a"]);
    const moved = chain({ a: { locked: true, position: { x: 3, y: 3 } } });
    expect(lockedViolations(before, moved)).toEqual([]);
    expect(lockedViolations(before, { ...after, nodes: after.nodes.filter((n) => n.id !== "a") })).toEqual(["a"]);
    expect(restoreLocked(before, after).nodes[1].config).toEqual(before.nodes[1].config);
  });
});

describe("workflow editor: API", () => {
  const setup = async (client = new FakeClient()) => {
    const anvil = await anvilWith(client);
    const triggers = new TriggerManager({ store: anvil.store, runs: anvil.runs });
    await triggers.load();
    const app = new Hono();
    mountWorkflow(app, {
      store: anvil.store,
      runs: anvil.runs,
      registry: anvil.registry,
      triggers,
      dataDir: anvil.config.dataDir,
      summarize: (a) => ({ id: a.id, currentVersion: a.currentVersion }),
    });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const waitRun = async (runId: string) => {
      for (let i = 0; i < 300; i++) {
        const r = await anvil.runs.getRun(runId);
        if (r && !anvil.runs.isActive(runId)) return r;
        await new Promise((res) => setTimeout(res, 10));
      }
      throw new Error("run did not end");
    };
    return { anvil, triggers, call, waitRun };
  };

  it("inspects ports, output schemas, side effects and diagnostics of a draft", async () => {
    const { anvil } = await setup();
    const s = chain();
    s.nodes.splice(2, 0, { id: "route", type: "router", config: { rules: [{ port: "big", when: { left: "{{input.text}}", op: "exists" } }], default: "small" } });
    s.nodes.push({ id: "hook", type: "send_webhook", config: { urlSecret: "X_HOOK", body: {} } });
    const r = inspectSpec(s, anvil.registry, (id) => anvil.store.getAgent(id));
    expect(r.nodes.route.ports).toEqual(["big", "small", "error"]);
    expect(r.nodes.input.outputSchema).toEqual(s.inputSchema);
    expect(r.nodes.hook.sideEffects).toBe(true);
    expect(r.nodes.a.category).toBe("data");
    expect(r.diagnostics.some((d) => d.nodeId === "route")).toBe(true);
  });

  it("creates a blank agent, keeps a draft, saves it, and refuses a save from an old base", async () => {
    const { anvil, call } = await setup();
    const made = await call("POST", "/api/agents/blank", { name: "My Flow" });
    expect(made.status).toBe(201);
    const id = made.json.id as string;
    expect(id).toBe("my-flow");
    const spec = { ...anvil.store.getSpec(id)! };
    spec.nodes = [...spec.nodes];
    spec.nodes[1] = { ...spec.nodes[1], config: { value: { text: "{{input.text | upper}}" } } };
    expect((await call("PUT", `/api/agents/${id}/draft`, { spec, baseVersion: 1, pinData: { input: { output: { text: "p" } } } })).status).toBe(200);
    expect((await call("GET", `/api/agents/${id}/draft`)).json).toMatchObject({ baseVersion: 1, pinData: { input: { output: { text: "p" } } } });
    // Another version comes first: the save from base 1 gets a conflict and a merge.
    await anvil.store.saveVersion({ ...anvil.store.getSpec(id)!, description: "changed elsewhere" }, { note: "other" });
    const conflict = await call("POST", `/api/agents/${id}/draft/save`, { spec, baseVersion: 1 });
    expect(conflict.status).toBe(409);
    expect(conflict.json).toMatchObject({ conflict: true, latestVersion: 2, merge: { conflicts: [] } });
    const merged = (conflict.json.merge as { spec: AgentSpec }).spec;
    expect(merged.description).toBe("changed elsewhere");
    const saved = await call("POST", `/api/agents/${id}/draft/save`, { spec: merged, baseVersion: 2, note: "merged" });
    expect(saved.json).toMatchObject({ version: 3 });
    expect((await call("GET", `/api/agents/${id}/draft`)).status).toBe(404);
    expect((await call("POST", `/api/agents/${id}/draft/save`, { spec: { ...merged, nodes: [] }, baseVersion: 3 })).status).toBe(400);
  });

  it("runs a draft in full, to a step, and only one step with the data of an earlier run", async () => {
    const { anvil, call, waitRun } = await setup();
    await anvil.store.saveVersion(chain(), { note: "t" });
    const full = await call("POST", "/api/workflow/run", { agentId: "wf", spec: chain(), input: { text: "x" } });
    const first = await waitRun(full.json.runId as string);
    expect(first).toMatchObject({ status: "completed", origin: "editor", dryRun: true, output: { text: "A:x+B" } });
    expect(first.stepData?.a).toEqual({ output: { text: "A:x" }, ports: ["out"] });
    const to = await waitRun((await call("POST", "/api/workflow/run", { agentId: "wf", spec: chain(), input: { text: "y" }, mode: "to_node", target: "a" })).json.runId as string);
    expect(to.output).toEqual({ text: "A:y" });
    // Only b runs again: a keeps the output of the first run, and the input of the first run comes back.
    const changed = chain();
    changed.nodes[2].config = { value: { text: "{{nodes.a.output.text}}!" } };
    const only = await waitRun(
      (await call("POST", "/api/workflow/run", { agentId: "wf", spec: changed, mode: "node_only", target: "b", reuseRunId: first.id })).json.runId as string,
    );
    expect(only.output).toEqual({ text: "A:x!" });
    expect(only.events.some((e) => e.type === "node.started" && e.nodeId === "a")).toBe(false);
    const bad = await call("POST", "/api/workflow/run", { agentId: "wf", spec: { ...chain(), edges: [] }, input: {} });
    expect(bad.status).toBe(400);
  });

  it("catches a test event of a saved webhook trigger without a run, also when the trigger is off", async () => {
    const { anvil, call, triggers } = await setup();
    await anvil.store.saveVersion({ ...chain(), triggers: [{ id: "hook", type: "webhook", enabled: false, respond: false, input: { text: "{{payload.msg}}" } }] }, { note: "t" });
    await triggers.load();
    const token = await triggers.webhookToken("wf", "hook");
    const listening = call("POST", "/api/agents/wf/triggers/hook/listen", { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 20));
    const sent = await triggers.handleWebhook("wf", "hook", { rawBody: '{"msg":"hi"}', payload: { msg: "hi" }, headers: { "x-anvil-token": token }, query: {} });
    expect(sent).toMatchObject({ status: 200, body: { test: true, captured: true } });
    const got = await listening;
    expect(got.json).toMatchObject({ captured: true, event: { payload: { msg: "hi" }, input: { text: "hi" } } });
    expect(anvil.store.listRuns({ agentId: "wf" }).length).toBe(0);
    expect((await call("POST", "/api/agents/wf/triggers/nope/listen", { timeoutMs: 1000 })).status).toBe(400);
  });

  it("keeps a locked step when the assistant changes it, and keeps the positions", async () => {
    const client = new FakeClient((req) =>
      String(req.messages[0]?.content).includes("change Anvil agent specs")
        ? JSON.stringify({
            summary: "changed",
            operations: [
              { op: "replace", path: "/nodes/1/config", value: { value: { text: "hacked" } } },
              { op: "replace", path: "/nodes/2/config", value: { value: { text: "{{nodes.a.output.text}}+C" } } },
            ],
            addTests: [],
            removeTestIds: [],
          })
        : "ok",
    );
    const { anvil, call, waitRun } = await setup(client);
    const s = chain({ a: { locked: true, position: { x: 10, y: 20 } }, b: { position: { x: 30, y: 40 } } });
    await anvil.store.saveVersion(s, { note: "t" });
    const r = await waitRun((await call("POST", "/api/workflow/assist", { agentId: "wf", spec: s, instruction: "change it" })).json.runId as string);
    expect(r.status).toBe("completed");
    const out = (r.output as { spec: AgentSpec }).spec;
    expect(out.nodes[1]).toMatchObject({ id: "a", locked: true, config: { value: { text: "A:{{input.text}}" } }, position: { x: 10, y: 20 } });
    expect(out.nodes[2]).toMatchObject({ config: { value: { text: "{{nodes.a.output.text}}+C" } }, position: { x: 30, y: 40 } });
    // The prompt names the locked step and does not show positions.
    const sent = client.chats.find((c) => String(c.messages[0]?.content).includes("change Anvil agent specs"))!;
    expect(String(sent.messages[0].content)).toMatch(/locked steps: a\b/);
    expect(String(sent.messages.at(-1)?.content)).not.toContain('"position"');
  });

  it("gives a blank spec that compiles", async () => {
    const { anvil } = await setup();
    expect(inspectSpec(blankSpec("x", "X"), anvil.registry, () => undefined).valid).toBe(true);
  });
});
