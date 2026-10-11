import type { AgentSpec, RunEvent } from "@core/types";
import { Square, X } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { categoryOf } from "../lib/categories";
import { duration, money } from "../lib/format";
import { type RunState, useNow } from "../lib/useRun";
import { EventFeed, EventRow } from "./Feed";
import { GraphView } from "./GraphView";
import { HumanPanel } from "./HumanDialog";
import { OutputView } from "./OutputView";
import { JsonBlock, StatusBadge, Tabs } from "./ui";

export function firedPorts(events: RunEvent[]) {
  const out: Record<string, string[]> = {};
  for (const e of events) if (e.type === "node.completed") out[e.nodeId] = e.ports;
  return out;
}

export function RunHeaderStats({ run }: { run: RunState }) {
  const live = run.status === "running" || run.status === "waiting" || run.status === "connecting";
  const now = useNow(live);
  const elapsed = run.startedAt ? (run.endedAt ?? now) - run.startedAt : undefined;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-[var(--color-muted)]">
      <StatusBadge status={run.status} />
      <span className="mono">{duration(elapsed)}</span>
      <span className="mono">{money(run.usage.costUsd)}</span>
      <span className="mono">
        <span className="text-[var(--color-s1)]">S1</span> {run.usage.decisionCalls} · <span className="text-[var(--color-s2)]">S2</span> {run.usage.llmCalls}
      </span>
      <span className="mono">{(run.usage.inputTokens + run.usage.outputTokens).toLocaleString()} tok</span>
    </div>
  );
}

export function NodeInspector({ spec, nodeId, run, onClose }: { spec: AgentSpec; nodeId: string; run?: RunState; onClose: () => void }) {
  const node = spec.nodes.find((n) => n.id === nodeId);
  const [tab, setTab] = useState<"output" | "config" | "events">(run ? "output" : "config");
  if (!node) return null;
  const cat = categoryOf(node.type);
  const events = run?.events.filter((e) => "nodeId" in e && e.nodeId === nodeId) ?? [];
  const started = [...events].reverse().find((e) => e.type === "node.started") as Extract<RunEvent, { type: "node.started" }> | undefined;
  const completed = [...events].reverse().find((e) => e.type === "node.completed") as Extract<RunEvent, { type: "node.completed" }> | undefined;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-2 border-b border-[var(--color-line)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{node.name || node.id}</div>
          <div className="mono mt-0.5 text-[11px]">
            <span style={{ color: cat.color }}>{node.type}</span> <span className="text-[var(--color-faint)]">· {node.id}</span>
          </div>
          {node.description && <div className="mt-1 text-[12px] text-[var(--color-muted)]">{node.description}</div>}
        </div>
        {run?.nodeStates[nodeId] && <StatusBadge status={run.nodeStates[nodeId]} />}
        <button className="btn btn-ghost !p-1" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ...(run ? [{ id: "output" as const, label: "Output" }] : []),
          { id: "config" as const, label: "Config" },
          ...(run ? [{ id: "events" as const, label: `Trace (${events.length})` }] : []),
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {tab === "output" && run && (
          <div className="space-y-3">
            {completed ? (
              <>
                <div className="mono flex gap-4 text-[11px] text-[var(--color-muted)]">
                  <span>{duration(completed.durationMs)}</span>
                  <span>{money(completed.usage.costUsd)}</span>
                  <span>ports: {completed.ports.join(", ")}</span>
                </div>
                <JsonBlock value={completed.output} />
              </>
            ) : run.nodeErrors[nodeId] ? (
              <div className="rounded-lg border border-[rgba(248,113,113,0.4)] bg-[rgba(248,113,113,0.06)] p-3 text-[12px] text-[var(--color-bad)]">{run.nodeErrors[nodeId]}</div>
            ) : (
              <div className="text-[12px] text-[var(--color-muted)]">{run.nodeStates[nodeId] === "skipped" ? "Skipped — its branch was not taken." : "No output yet."}</div>
            )}
            {started?.config !== undefined && (
              <details>
                <summary className="label cursor-pointer">Resolved config (templates filled)</summary>
                <JsonBlock value={started.config} className="mt-2" />
              </details>
            )}
          </div>
        )}
        {tab === "config" && <JsonBlock value={node.config} />}
        {tab === "events" && <EventFeed events={events} showNode={false} />}
      </div>
    </div>
  );
}

/** Full run visualization: live graph + inspector/timeline + output + human requests. */
/** The harness status: attempts, strategies, and the gaps of a partial result. */
export function HarnessBanner({ run }: { run: RunState }) {
  const steps = run.artifacts.filter((a) => a.kind === "harness").map((a) => a.data as { event: string; strategy?: string; failureClass?: string; attempt?: number });
  const summary = run.record?.harness;
  const strategies = summary?.strategies ?? steps.filter((s) => s.event === "strategy").map((s) => s.strategy!);
  if (!summary && !strategies.length) return null;
  const partial = summary?.status === "partial";
  const tone = partial ? "border-[rgba(251,191,36,0.4)] bg-[rgba(251,191,36,0.06)]" : "border-[var(--color-line)] bg-transparent";
  return (
    <div className={`rounded-lg border p-3 text-[12px] ${tone}`}>
      <div className="mb-1 flex items-center gap-2">
        <span className="label">Harness</span>
        <span className={partial ? "text-[var(--color-warn)]" : "text-[var(--color-ok)]"}>{summary ? (partial ? "partial result" : "accepted") : "trying again"}</span>
        <span className="ml-auto text-[var(--color-muted)]">
          {summary?.attempts ?? strategies.length + 1} attempt{(summary?.attempts ?? strategies.length + 1) === 1 ? "" : "s"}
        </span>
      </div>
      {strategies.length > 0 && <div className="text-[var(--color-muted)]">Strategies: {strategies.join(" → ")}</div>}
      {summary?.failureClass && <div className="text-[var(--color-muted)]">Failure class: {summary.failureClass}</div>}
      {partial && summary.gaps.length > 0 && (
        <ul className="mt-1 list-disc pl-4">
          {summary.gaps.map((g, i) => (
            <li key={i}>{g}</li>
          ))}
        </ul>
      )}
      {partial && summary.reason && <div className="mt-1 text-[var(--color-muted)]">{summary.reason}</div>}
    </div>
  );
}

export function RunViewer({ spec, run, runId, compactHeader, outputAction }: { spec: AgentSpec; run: RunState; runId: string; compactHeader?: boolean; outputAction?: ReactNode }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [side, setSide] = useState<"timeline" | "output">("timeline");
  const ports = useMemo(() => firedPorts(run.events), [run.events]);
  const done = ["completed", "failed", "cancelled"].includes(run.status);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {!compactHeader && (
        <div className="flex items-center gap-3 border-b border-[var(--color-line)] px-4 py-2.5">
          <RunHeaderStats run={run} />
          {!done && (
            <button className="btn btn-ghost ml-auto text-xs" onClick={() => api.cancel(runId)}>
              <Square size={12} /> Cancel
            </button>
          )}
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-[minmax(0,1fr)_420px] lg:overflow-hidden">
        <div className="relative min-h-[380px] border-b border-[var(--color-line)] lg:min-h-0 lg:border-b-0 lg:border-r">
          <GraphView spec={spec} states={run.nodeStates} selected={selected} onSelect={setSelected} firedPorts={ports} />
        </div>
        <div className="flex min-h-[380px] flex-col lg:min-h-0">
          {selected ? (
            <NodeInspector spec={spec} nodeId={selected} run={run} onClose={() => setSelected(null)} />
          ) : (
            <>
              <Tabs
                value={side}
                onChange={setSide}
                tabs={[
                  { id: "timeline", label: "Timeline" },
                  { id: "output", label: "Output" },
                ]}
              />
              <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
                <HarnessBanner run={run} />
                {run.pending.map((p, i) => (
                  <HumanPanel key={`${p.nodeId}-${i}`} runId={runId} nodeId={p.nodeId} request={p.request} />
                ))}
                {side === "timeline" ? (
                  <div>
                    {run.events.map((e, i) => (
                      <EventRow key={i} e={e} />
                    ))}
                    {!run.events.length && <div className="text-xs text-[var(--color-muted)]">Waiting for events…</div>}
                  </div>
                ) : run.status === "failed" ? (
                  <div className="rounded-lg border border-[rgba(248,113,113,0.4)] bg-[rgba(248,113,113,0.06)] p-3 text-[12px] text-[var(--color-bad)]">{run.error}</div>
                ) : done ? (
                  <div>
                    {outputAction && <div className="mb-2 flex justify-end">{outputAction}</div>}
                    <OutputView value={run.output} />
                  </div>
                ) : (
                  <div className="text-xs text-[var(--color-muted)]">Running…</div>
                )}
                {done && run.status === "completed" && side === "timeline" && (
                  <div className="card p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <div className="label">Output</div>
                      {outputAction && <div className="ml-auto">{outputAction}</div>}
                    </div>
                    <OutputView value={run.output} />
                  </div>
                )}
                {run.record?.kind === "eval" && run.record.parentRunId && (
                  <Link className="text-xs text-[var(--color-ember)]" to={`/runs/${run.record.parentRunId}`}>
                    ← parent run
                  </Link>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
