import type { HumanRequest, NodeStatus, RunEvent, RunRecord, Usage } from "@core/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, withToken } from "./api";

export interface RunState {
  record: (RunRecord & { active?: boolean }) | null;
  events: RunEvent[];
  status: RunRecord["status"] | "connecting";
  nodeStates: Record<string, NodeStatus>;
  nodeOutputs: Record<string, unknown>;
  nodeErrors: Record<string, string>;
  usage: Usage;
  pending: { nodeId: string; request: HumanRequest }[];
  output: unknown;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  artifacts: Extract<RunEvent, { type: "artifact" }>[];
}

const zero: Usage = { llmCalls: 0, decisionCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

export function deriveState(events: RunEvent[], record: RunState["record"]): Omit<RunState, "record" | "events"> {
  const nodeStates: Record<string, NodeStatus> = { ...(record?.nodeStates ?? {}) };
  const nodeOutputs: Record<string, unknown> = {};
  const nodeErrors: Record<string, string> = {};
  const usage: Usage = { ...zero };
  const waiting = new Map<string, HumanRequest[]>();
  let status: RunState["status"] = record?.status ?? "connecting";
  let output: unknown = record?.output;
  let error = record?.error;
  let startedAt = record?.startedAt;
  let endedAt = record?.endedAt;
  const artifacts: RunState["artifacts"] = [];
  for (const e of events) {
    switch (e.type) {
      case "run.started":
        status = "running";
        startedAt = e.t;
        break;
      case "node.started":
        nodeStates[e.nodeId] = "running";
        break;
      case "node.completed":
        nodeStates[e.nodeId] = "done";
        nodeOutputs[e.nodeId] = e.output;
        delete nodeErrors[e.nodeId];
        waiting.delete(e.nodeId);
        break;
      case "node.skipped":
        nodeStates[e.nodeId] = "skipped";
        break;
      case "node.failed":
        if (!e.willRetry) nodeStates[e.nodeId] = "failed";
        nodeErrors[e.nodeId] = e.error;
        break;
      case "node.waiting":
        nodeStates[e.nodeId] = "waiting";
        waiting.set(e.nodeId, [...(waiting.get(e.nodeId) ?? []), e.request]);
        status = "waiting";
        break;
      case "node.resumed": {
        nodeStates[e.nodeId] = "running";
        const l = waiting.get(e.nodeId) ?? [];
        l.shift();
        if (l.length) waiting.set(e.nodeId, l);
        else waiting.delete(e.nodeId);
        if (!waiting.size) status = "running";
        break;
      }
      case "llm":
        usage.llmCalls++;
        usage.inputTokens += e.inputTokens;
        usage.outputTokens += e.outputTokens;
        usage.costUsd += e.costUsd;
        break;
      case "decision":
        usage.decisionCalls++;
        usage.costUsd += e.costUsd;
        break;
      case "usage":
        usage.llmCalls += e.usage.llmCalls ?? 0;
        usage.decisionCalls += e.usage.decisionCalls ?? 0;
        usage.inputTokens += e.usage.inputTokens ?? 0;
        usage.outputTokens += e.usage.outputTokens ?? 0;
        usage.costUsd += e.usage.costUsd ?? 0;
        break;
      case "artifact":
        artifacts.push(e);
        break;
      case "run.completed":
        status = "completed";
        output = e.output;
        endedAt = e.t;
        Object.assign(usage, e.usage);
        break;
      case "run.failed":
        status = "failed";
        error = e.error;
        endedAt = e.t;
        Object.assign(usage, e.usage);
        break;
      case "run.cancelled":
        status = "cancelled";
        endedAt = e.t;
        break;
    }
  }
  if (record && ["completed", "failed", "cancelled"].includes(record.status)) {
    status = record.status;
    Object.assign(usage, record.usage);
  }
  if (["completed", "failed", "cancelled"].includes(status)) waiting.clear();
  const pending = [...waiting.entries()].flatMap(([nodeId, reqs]) => reqs.map((request) => ({ nodeId, request })));
  return { status, nodeStates, nodeOutputs, nodeErrors, usage, pending, output, error, startedAt, endedAt, artifacts };
}

/** Live run state from the SSE event stream (replays history, then streams). */
export function useRun(runId: string | undefined): RunState & { refresh: () => void } {
  const [sourceId, setSourceId] = useState<string>();
  const [record, setRecord] = useState<RunState["record"]>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [tick, setTick] = useState(0);
  const buffer = useRef<RunEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | undefined;
    let flushTimer: number | undefined;
    setSourceId(runId);
    setEvents([]);
    setRecord(null);
    buffer.current = [];
    if (!runId) return;
    const flush = () => {
      flushTimer = undefined;
      if (cancelled || !buffer.current.length) return;
      const batch = buffer.current;
      buffer.current = [];
      setEvents((prev) => [...prev, ...batch]);
    };
    const finish = () => {
      es?.close();
      flush();
      void api
        .runRecord(runId)
        .then((r) => {
          if (!cancelled) setRecord({ ...r, events: [] });
        })
        .catch(() => undefined);
    };
    const connect = () => {
      if (cancelled) return;
      es = new EventSource(withToken(`/api/runs/${runId}/events`));
      es.addEventListener("event", (m) => {
        const event = JSON.parse((m as MessageEvent).data) as RunEvent;
        buffer.current.push(event);
        if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) finish();
        else if (!flushTimer) flushTimer = window.setTimeout(flush, 60);
      });
      es.addEventListener("end", finish);
    };
    void api
      .runRecord(runId)
      .then((r) => {
        if (cancelled) return;
        setRecord({ ...r, events: [] });
        if (["completed", "failed", "cancelled"].includes(r.status)) setEvents(r.events);
        else connect();
      })
      .catch(() => connect());
    return () => {
      cancelled = true;
      es?.close();
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [runId, tick]);

  const matching = sourceId === runId;
  const visibleRecord = matching ? record : null;
  const visibleEvents = matching ? events : [];
  const derived = useMemo(() => deriveState(visibleEvents, visibleRecord), [events, record, runId, sourceId]);
  return { record: visibleRecord, events: visibleEvents, ...derived, refresh: () => setTick((t) => t + 1) };
}

export function useNow(active: boolean, ms = 500) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}
