import type { Answer, Question, RunEvent } from "@core/types";
import { AlertTriangle, ArrowUpRight, Brain, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, CircleSlash, Info, Play, XCircle, Zap } from "lucide-react";
import { useState } from "react";
import { duration, money, preview } from "../lib/format";
import { type CodeArtifact, CodeRunCard, type EgressArtifact, EgressRow, type PackageArtifact, PackageRow } from "./SandboxViews";

/** Probability bars for one Jev answer. */
export function AnswerView({ id, q, a }: { id: string; q?: Question; a: Answer & { escalated?: boolean; rationale?: string } }) {
  const title = q?.instructions ?? id;
  if (a.type === "noul") {
    return (
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-3 text-[11.5px]">
          <span className="truncate text-[var(--color-muted)]" title={title}>
            {title}
          </span>
          <span className="mono shrink-0 font-semibold" style={{ color: a.noul >= 0.5 ? "#34d399" : "#f87171" }}>
            {a.noul >= 0.5 ? "yes" : "no"} {(a.noul * 100).toFixed(0)}%
          </span>
        </div>
        <Bar p={a.noul} color={a.noul >= 0.5 ? "#34d399" : "#f87171"} />
        {a.escalated && <Escalated rationale={a.rationale} />}
      </div>
    );
  }
  const probs = Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1]);
  const labels = a.type === "score" ? (a.legend ?? (q?.type === "score" ? Object.fromEntries(q.criteria.map((c, i) => [String(i), c])) : {})) : {};
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-[11.5px]">
        <span className="truncate text-[var(--color-muted)]" title={title}>
          {title}
        </span>
        <span className="mono shrink-0 font-semibold text-[var(--color-s1)]">
          {a.type === "choice" ? a.choice : a.score.toFixed(2)}
          <span className="ml-1.5 font-normal text-[var(--color-faint)]">conf {(a.confidence * 100).toFixed(0)}%</span>
        </span>
      </div>
      <div className="space-y-[3px]">
        {(a.type === "score" ? probs.sort((x, y) => Number(x[0]) - Number(y[0])) : probs.slice(0, 6)).map(([k, p]) => {
          const winner = a.type === "choice" ? k === a.choice : Math.round(a.score) === Number(k);
          return (
            <div key={k} className="grid grid-cols-[minmax(0,110px)_1fr_34px] items-center gap-2 text-[10.5px]">
              <span className={`mono truncate ${winner ? "text-[var(--color-fg)]" : "text-[var(--color-faint)]"}`} title={labels[k] ?? k}>
                {a.type === "score" ? `${k}·${labels[k] ?? ""}` : k}
              </span>
              <Bar p={p} color={winner ? "#fbbf24" : "#4b5261"} />
              <span className="mono text-right text-[var(--color-faint)]">{(p * 100).toFixed(0)}%</span>
            </div>
          );
        })}
      </div>
      {a.escalated && <Escalated rationale={a.rationale} />}
    </div>
  );
}

function Escalated({ rationale }: { rationale?: string }) {
  return (
    <div className="flex items-start gap-1.5 rounded-md bg-[rgba(167,139,250,0.08)] px-2 py-1 text-[10.5px] text-[var(--color-s2)]">
      <ArrowUpRight size={12} className="mt-px shrink-0" /> <span>Low confidence → escalated to System 2{rationale ? `: ${rationale}` : ""}</span>
    </div>
  );
}

function Bar({ p, color }: { p: number; color: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-panel-2)]">
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(1.5, p * 100)}%`, background: color }} />
    </div>
  );
}

function answerSummary(a: Answer): string {
  if (a.type === "choice") return `${a.choice} ${(a.confidence * 100).toFixed(0)}%`;
  if (a.type === "score") return a.score.toFixed(2);
  return `${a.noul >= 0.5 ? "yes" : "no"} ${(a.noul * 100).toFixed(0)}%`;
}

export function DecisionCard({ e, defaultOpen = true }: { e: Extract<RunEvent, { type: "decision" }>; defaultOpen?: boolean }) {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? defaultOpen;
  const entries = Object.entries(e.answers);
  return (
    <div className="rounded-lg border border-[rgba(251,191,36,0.22)] bg-[rgba(251,191,36,0.04)] p-2.5">
      <button className="flex w-full items-center gap-2 text-left text-[12px]" onClick={() => setToggled(!open)}>
        {open ? <ChevronDown size={12} className="shrink-0 text-[var(--color-faint)]" /> : <ChevronRight size={12} className="shrink-0 text-[var(--color-faint)]" />}
        <Zap size={13} className="shrink-0 text-[var(--color-s1)]" />
        <span className="shrink-0 font-medium">{e.purpose}</span>
        {!open && (
          <span className="mono min-w-0 flex-1 truncate text-[10.5px] text-[var(--color-muted)]">
            {entries
              .slice(0, 4)
              .map(([id, a]) => `${id}=${answerSummary(a)}`)
              .join(" · ")}
          </span>
        )}
        <span className="mono ml-auto shrink-0 text-[10.5px] text-[var(--color-faint)]">
          S1 · {entries.length}q · {duration(e.latencyMs)}
          {e.escalated ? " · ↑S2" : ""}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2.5">
          {entries.slice(0, 12).map(([id, a]) => (
            <AnswerView key={id} id={id} q={e.questions[id]} a={a} />
          ))}
          {entries.length > 12 && <div className="text-[10.5px] text-[var(--color-faint)]">+{entries.length - 12} more answers</div>}
        </div>
      )}
    </div>
  );
}

export function EventRow({ e, showNode = true }: { e: RunEvent; showNode?: boolean }) {
  const t = new Date(e.t).toLocaleTimeString([], { hour12: false });
  const node = showNode && "nodeId" in e && e.nodeId ? <span className="mono text-[var(--color-muted)]">{e.nodeId}</span> : null;
  const row = (icon: React.ReactNode, body: React.ReactNode, right?: React.ReactNode) => (
    <div className="fade-in flex items-start gap-2 py-[3px] text-[12px]">
      <span className="mono mt-px w-[54px] shrink-0 text-[10.5px] text-[var(--color-faint)]">{t}</span>
      <span className="mt-[2px] shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">{body}</div>
      {right && <span className="mono shrink-0 text-[10.5px] text-[var(--color-faint)]">{right}</span>}
    </div>
  );
  switch (e.type) {
    case "run.started":
      return row(<Play size={12} className="text-[var(--color-ember)]" />, <span>Run started</span>);
    case "node.started":
      return row(
        <CircleDashed size={12} className="text-[var(--color-ember)]" />,
        <span>
          {node} started{e.attempt > 1 ? ` (attempt ${e.attempt})` : ""}
        </span>,
      );
    case "node.completed":
      return row(
        <CheckCircle2 size={12} className="text-[var(--color-ok)]" />,
        <span>
          {node} <span className="text-[var(--color-faint)]">→ {preview(e.output, 110)}</span>
        </span>,
        `${duration(e.durationMs)}${e.usage.costUsd ? ` · ${money(e.usage.costUsd)}` : ""}`,
      );
    case "node.skipped":
      return row(<CircleSlash size={12} className="text-[var(--color-faint)]" />, <span className="text-[var(--color-faint)]">{node} skipped (branch not taken)</span>);
    case "node.failed":
      return row(
        <XCircle size={12} className="text-[var(--color-bad)]" />,
        <span className="text-[var(--color-bad)]">
          {node} {e.error.slice(0, 240)}
          {e.willRetry ? " — retrying" : ""}
        </span>,
      );
    case "node.waiting":
      return row(
        <AlertTriangle size={12} className="text-[#fb7185]" />,
        <span className="text-[#fb7185]">
          {node} waiting for you: {e.request.title}
        </span>,
      );
    case "node.resumed":
      return row(<CheckCircle2 size={12} className="text-[#fb7185]" />, <span>{node} resumed</span>);
    case "llm":
      return row(
        <Brain size={12} className="text-[var(--color-s2)]" />,
        <span>
          <span className="text-[var(--color-s2)]">S2</span> {e.purpose} <span className="text-[var(--color-faint)]">· {e.tier ?? e.model.split("/").pop()}</span>
        </span>,
        `${e.inputTokens}→${e.outputTokens} tok · ${duration(e.latencyMs)}`,
      );
    case "decision":
      return (
        <div className="py-1 pl-[62px]">
          <DecisionCard e={e} />
        </div>
      );
    case "log":
      if (e.message === "__final__") return null;
      return row(
        <Info size={12} className={e.level === "warn" ? "text-[var(--color-warn)]" : "text-[var(--color-faint)]"} />,
        <span className="text-[var(--color-muted)]">
          {node} {e.message}
        </span>,
      );
    case "artifact":
      // The sandbox: programs, outbound requests outside a program, and package installs.
      if (e.kind === "code") return <CodeRunCard d={e.data as CodeArtifact} />;
      if (e.kind === "package") return <PackageRow d={e.data as PackageArtifact} />;
      if (e.kind === "egress" && (e.data as EgressArtifact).tool === "direct") return <EgressRow e={e.data as EgressArtifact} />;
      return null;
    case "run.completed":
      return row(
        <CheckCircle2 size={12} className="text-[var(--color-ok)]" />,
        <span className="font-medium text-[var(--color-ok)]">Run completed</span>,
        `${duration(e.durationMs)} · ${money(e.usage.costUsd)}`,
      );
    case "run.failed":
      return row(<XCircle size={12} className="text-[var(--color-bad)]" />, <span className="text-[var(--color-bad)]">Run failed: {e.error}</span>);
    case "run.cancelled":
      return row(<CircleSlash size={12} />, <span>Run cancelled</span>);
  }
}

export function EventFeed({ events, showNode = true, filter }: { events: RunEvent[]; showNode?: boolean; filter?: (e: RunEvent) => boolean }) {
  const list = filter ? events.filter(filter) : events;
  return (
    <div className="divide-y divide-transparent">
      {list.map((e, i) => (
        <EventRow key={i} e={e} showNode={showNode} />
      ))}
    </div>
  );
}
