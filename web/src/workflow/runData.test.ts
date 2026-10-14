import { describe, expect, it } from "vitest";
import { emptyUsage, type RunEvent, type RunRecord } from "@core/types";
import { deriveState, type RunState } from "../lib/useRun";
import { defaults, nodeOverlay, stepData } from "./runData";
const complete: RunEvent = {
  type: "node.completed",
  nodeId: "send",
  t: 10,
  durationMs: 4,
  usage: { ...emptyUsage(), costUsd: 0.1 },
  ports: ["out"],
  output: { body: { dryRun: true } },
};
function run(events: RunEvent[], record: RunRecord | null = null): RunState {
  return { events, record, ...deriveState(events, record) };
}
describe("editor run data", () => {
  it("prefers full step data over truncated events", () => {
    const r = run([complete]);
    r.record = {
      id: "r",
      agentId: "a",
      agentName: "A",
      version: 1,
      kind: "run",
      status: "completed",
      input: {},
      startedAt: 0,
      usage: emptyUsage(),
      nodeStates: {},
      events: [],
      stepData: { send: { output: { full: true }, ports: ["out"] } },
    };
    expect(stepData(r).send.output).toEqual({ full: true });
    expect(stepData(run([complete])).send.output).toEqual({ body: { dryRun: true } });
  });
  it("shows dry-run, pinned, duration and cost", () => {
    const r = run([complete, { type: "log", t: 11, nodeId: "send", level: "info", message: "pinned: reused" }]);
    expect(nodeOverlay(r, "send")).toMatchObject({ status: "done", durationMs: 4, cost: 0.1, dryRun: true, runPinned: true });
  });
  it("does not leave a retry error on successful output or human request after cancellation", () => {
    const r = run([
      { type: "node.failed", nodeId: "send", t: 1, error: "retry", attempt: 1, willRetry: true },
      complete,
      { type: "node.waiting", nodeId: "human", t: 12, request: { kind: "input", title: "Answer" } },
      { type: "run.cancelled", t: 13 },
    ]);
    expect(r.nodeErrors.send).toBeUndefined();
    expect(r.pending).toEqual([]);
  });
  it("uses nested defaults and examples including false and zero", () => {
    expect(defaults({ type: "object", properties: { enabled: { default: false }, count: { default: 0 }, nested: { properties: { message: { examples: ["hello"] } } } } })).toEqual({
      enabled: false,
      count: 0,
      nested: { message: "hello" },
    });
  });
});
