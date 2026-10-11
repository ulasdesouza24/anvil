import type { AgentSpec, AgentVersion, Diagnostic, EvaluationReport, RunEvent, RunRecord, TestCase, TestResult } from "@core/types";
import { ArrowRight, Check, ChevronDown, ChevronRight, Circle, CircleSlash, FlaskConical, Paperclip, Play, ShieldAlert, Square, Trophy, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { DecisionCard, EventRow } from "../components/Feed";
import { GraphView } from "../components/GraphView";
import { HumanPanel } from "../components/HumanDialog";
import { NodeInspector, RunHeaderStats } from "../components/RunViewer";
import { BLAME_TEXT, type Quality } from "@core/quality";
import type { FailureBlame } from "@core/types";
import { BlameChip, findBlame } from "../components/Diagnosis";
import { LibraryStageView } from "../components/LibraryViews";
import { JsonBlock, JsonEditor, QualityBadge, ScoreBadge, Spinner, StatusBadge, Tabs } from "../components/ui";
import { api, type RunSummary } from "../lib/api";
import { categoryOf, iconFor } from "../lib/categories";
import { duration, money, pct } from "../lib/format";
import { type RunState, useRun } from "../lib/useRun";

type Artifact = Extract<RunEvent, { type: "artifact" }>;

/** Tolerate half-formed drafts (the compiler hasn't fixed them yet). */
export function safeSpec(raw: unknown): AgentSpec | null {
  const s = raw as Partial<AgentSpec> | undefined;
  if (!s || !Array.isArray(s.nodes)) return null;
  const nodes = s.nodes.filter((n) => n && typeof n.id === "string" && typeof n.type === "string");
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(s.edges) ? s.edges : []).filter((e) => e && ids.has(e.from) && ids.has(e.to));
  return { ...(s as AgentSpec), nodes, edges };
}

function lastArtifact(arts: Artifact[], kind: string, nodeId?: string) {
  for (let i = arts.length - 1; i >= 0; i--) if (arts[i].kind === kind && (!nodeId || arts[i].nodeId === nodeId)) return arts[i];
  return undefined;
}

type CandidateStatus = "ready" | "failed" | "timeout";
type CandidateData = {
  label: string;
  model: string;
  status: CandidateStatus;
  runId?: string;
  error?: string;
  buildScore?: number | null;
  buildCostUsd: number;
  durationMs: number;
};
type CandidateScoreData = { label: string; model: string; passRate: number; score: number; tests: number; costUsd: number };
type SelectionData = {
  winner: string;
  model: string;
  by: "lead" | "judge" | "only";
  reason: string;
  margin: number;
  suite: number;
  judge?: { model: string; choice: string; reason: string; severity: Record<string, "none" | "light" | "medium" | "severe">; accepted: boolean };
  candidates: {
    label: string;
    model: string;
    status: CandidateStatus;
    error?: string;
    buildScore?: number | null;
    passRate?: number;
    score?: number;
    tests?: number;
    costUsd: number;
  }[];
};

function CandidateStatusChip({ status, error, stage }: { status: CandidateStatus | "pending" | "building"; error?: string; stage?: string }) {
  const ok = status === "ready";
  const bad = status === "failed" || status === "timeout";
  const active = status === "building";
  const color = ok ? "var(--color-ok)" : bad ? "var(--color-bad)" : active ? "#f97316" : "var(--color-faint)";
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium"
      style={{ borderColor: active ? `${color}55` : color, color, background: active ? `${color}14` : undefined }}
      title={error}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${active ? "pulse-dot" : ""}`} style={{ background: color }} />
      {status}
      {active && stage ? ` · ${stage}` : ""}
    </span>
  );
}

function SeverityChip({ severity }: { severity: "none" | "light" | "medium" | "severe" }) {
  const color = severity === "none" ? "var(--color-ok)" : severity === "light" ? "var(--color-muted)" : severity === "medium" ? "var(--color-warn)" : "var(--color-bad)";
  return (
    <span className="whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px]" style={{ borderColor: color, color }}>
      {severity}
    </span>
  );
}

function activeChildStage(child: RunRecord | undefined) {
  if (!child) return undefined;
  const completed = new Map<string, number>();
  for (let i = child.events.length - 1; i >= 0; i--) {
    const event = child.events[i];
    if (event.type === "node.completed") completed.set(event.nodeId, (completed.get(event.nodeId) ?? 0) + 1);
    if (event.type === "node.started") {
      const count = completed.get(event.nodeId) ?? 0;
      if (!count) return event.nodeId;
      completed.set(event.nodeId, count - 1);
    }
  }
  return undefined;
}

const BUILDER_STAGES = [
  ["tools", "Tools"],
  ["triage", "Triage"],
  ["analyze", "Analyze"],
  ["library", "Library"],
  ["sources", "Sources"],
  ["architect", "Architect"],
  ["classgen", "Class generation"],
  ["compose", "Compose"],
  ["testgen", "Tests"],
  ["evolve", "Evolve"],
  ["publish", "Publish"],
] as const;

function childArtifact(child: RunRecord | undefined, kind: string) {
  if (!child) return undefined;
  for (let i = child.events.length - 1; i >= 0; i--) {
    const event = child.events[i];
    if (event.type === "artifact" && event.kind === kind) return event;
  }
  return undefined;
}

function stageState(child: RunRecord | undefined, nodeId: string) {
  if (!child) return { status: "pending" as const };
  const events = child.events.filter((event) => "nodeId" in event && event.nodeId === nodeId);
  const completed = [...events].reverse().find((event) => event.type === "node.completed") as Extract<RunEvent, { type: "node.completed" }> | undefined;
  const failed = [...events].reverse().find((event) => event.type === "node.failed" && !event.willRetry);
  const started = events.some((event) => event.type === "node.started");
  if (completed) return { status: "done" as const, durationMs: completed.durationMs };
  if (failed) return { status: "failed" as const };
  if (started) return { status: "running" as const };
  return { status: "pending" as const };
}

function evolutionRounds(child: RunRecord | undefined) {
  const finished = (childArtifact(child, "evolution")?.data as { history?: { round: number; score: number; passRate: number; accepted: boolean }[] } | undefined)?.history;
  if (finished?.length) return finished;
  return (child?.events ?? [])
    .filter((event): event is Artifact => event.type === "artifact" && event.kind === "evaluation")
    .map((event) => {
      const data = event.data as { round?: number; report?: { score?: number; passRate?: number } };
      return { round: data.round ?? 0, score: data.report?.score ?? 0, passRate: data.report?.passRate ?? 0, accepted: true };
    });
}

function suiteSize(run: RunState, selection: SelectionData | undefined, scores: Map<string, CandidateScoreData>) {
  if (selection?.suite) return selection.suite;
  const scored = [...scores.values()].find((score) => score.tests > 0)?.tests;
  if (scored) return scored;
  for (let i = run.events.length - 1; i >= 0; i--) {
    const event = run.events[i];
    if (event.type !== "log") continue;
    const match = event.message.match(/shared suite:\s*(\d+) test/);
    if (match) return Number(match[1]);
  }
  return 0;
}

function CandidateColumn({
  label,
  model,
  child,
  build,
  score,
  final,
  winner,
  live,
  evals,
  suite,
}: {
  label: string;
  model?: string;
  child?: RunRecord;
  build?: CandidateData;
  score?: CandidateScoreData;
  final?: SelectionData["candidates"][number];
  winner: boolean;
  live: boolean;
  evals: RunSummary[];
  suite: number;
}) {
  const status = build?.status ?? final?.status ?? (child?.status === "failed" ? "failed" : live ? "building" : "pending");
  const rounds = evolutionRounds(child);
  const llmCalls =
    child?.events.reduce((sum, event) => sum + (event.type === "llm" ? 1 : event.type === "usage" ? (event.usage.llmCalls ?? 0) : 0), 0) ?? child?.usage.llmCalls ?? 0;
  const completedEvals = evals.filter((item) => item.status === "completed").length;
  const failedEvals = evals.filter((item) => item.status === "failed" || item.status === "cancelled").length;
  const runningEvals = evals.filter((item) => item.status === "running" || item.status === "queued" || item.status === "waiting").length;
  const repeats = score && suite ? Math.max(1, Math.round(evals.length / suite)) : Math.max(1, Math.ceil(evals.length / Math.max(1, suite)));
  const totalRuns = suite ? suite * repeats : 0;
  const doneRuns = completedEvals + failedEvals;
  const finalPassed = score ? Math.round(score.passRate * score.tests) : undefined;
  const passed = finalPassed ?? completedEvals;
  const failed = score ? Math.max(0, score.tests - passed) : failedEvals;
  return (
    <div
      className={`min-w-0 rounded-xl border bg-[var(--color-panel)] ${winner ? "border-[rgba(249,115,22,0.7)] shadow-[0_0_0_1px_rgba(249,115,22,0.15)]" : "border-[var(--color-line)]"}`}
    >
      <div className="border-b border-[var(--color-line)] p-3">
        <div className="flex min-w-0 items-center gap-2">
          {winner ? (
            <Trophy size={14} className="text-[var(--color-ember)]" />
          ) : (
            <span className="grid h-5 w-5 place-items-center rounded bg-[var(--color-panel-2)] text-[11px] font-semibold">{label}</span>
          )}
          <span className="min-w-0 truncate text-[12.5px] font-semibold">Candidate {label}</span>
          <span className="ml-auto shrink-0">
            <CandidateStatusChip status={status} stage={status === "building" ? activeChildStage(child) : undefined} error={build?.error ?? final?.error ?? child?.error} />
          </span>
        </div>
        <div className="mono mt-1.5 truncate text-[10.5px] text-[var(--color-muted)]" title={model}>
          {model ?? "waiting for model…"}
        </div>
        <div className="mono mt-2 flex min-w-0 items-center gap-3 text-[10.5px] text-[var(--color-faint)]">
          <span className="shrink-0 whitespace-nowrap">{money((build?.buildCostUsd ?? child?.usage.costUsd ?? 0) + (score?.costUsd ?? 0))}</span>
          <span className="shrink-0 whitespace-nowrap">
            {llmCalls} LLM call{llmCalls === 1 ? "" : "s"}
          </span>
          {child && (
            <Link className="ml-auto shrink-0 whitespace-nowrap text-[var(--color-ember)]" to={`/builds/${child.id}`}>
              full build →
            </Link>
          )}
        </div>
      </div>
      <div className="space-y-0.5 p-2.5">
        {BUILDER_STAGES.map(([id, name]) => {
          const state = stageState(child, id);
          const isActive = state.status === "running";
          return (
            <div
              key={id}
              className={`flex min-h-6 items-center gap-2 rounded px-1.5 text-[11px] ${isActive ? "bg-[rgba(249,115,22,0.06)] text-[var(--color-fg)]" : state.status === "pending" ? "text-[var(--color-faint)] opacity-55" : "text-[var(--color-muted)]"}`}
            >
              {state.status === "done" ? (
                <Check size={12} className="text-[var(--color-ok)]" />
              ) : state.status === "failed" ? (
                <X size={12} className="text-[var(--color-bad)]" />
              ) : isActive ? (
                <Spinner size={12} />
              ) : (
                <Circle size={9} />
              )}
              <span>{name}</span>
              {state.status === "done" && state.durationMs !== undefined && (
                <span className="mono ml-auto text-[10px] text-[var(--color-faint)]">{duration(state.durationMs)}</span>
              )}
            </div>
          );
        })}
        {rounds.length > 0 && (
          <div className="ml-5 flex flex-wrap gap-1.5 pb-1 pt-0.5">
            {rounds.map((round, i) => (
              <span key={`${round.round}-${i}`} className="mono rounded border border-[var(--color-line-2)] px-1.5 py-0.5 text-[9.5px] text-[var(--color-muted)]">
                r{round.round} {pct(round.passRate)} · {(round.score * 100).toFixed(0)}
                {round.accepted ? " ✓" : ""}
              </span>
            ))}
          </div>
        )}
      </div>
      {(evals.length > 0 || score) && (
        <div className="border-t border-[var(--color-line)] p-3">
          <div className="flex items-center text-[10.5px] text-[var(--color-muted)]">
            <span>Shared tests · pass^{repeats}</span>
            <span className="mono ml-auto">
              {Math.min(doneRuns, totalRuns || doneRuns)} / {totalRuns || "…"}
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--color-panel-2)]">
            <div className="h-full rounded-full bg-[var(--color-ember)] transition-[width]" style={{ width: `${totalRuns ? Math.min(100, (doneRuns / totalRuns) * 100) : 0}%` }} />
          </div>
          <div className="mono mt-1.5 flex gap-3 text-[10px]">
            <span className="text-[var(--color-ok)]">{passed} passed</span>
            <span className="text-[var(--color-bad)]">{failed} failed</span>
            {runningEvals > 0 && <span className="text-[var(--color-faint)]">{runningEvals} running</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function BestOfView({ run, children, childSummaries }: { run: RunState; children: RunRecord[]; childSummaries: RunSummary[] }) {
  const announced = lastArtifact(run.artifacts, "candidates")?.data as { models: string[]; available: string[]; failed: { model: string; error: string }[] } | undefined;
  const selection = lastArtifact(run.artifacts, "selection")?.data as SelectionData | undefined;
  const builds = new Map<string, CandidateData>();
  const scores = new Map<string, CandidateScoreData>();
  for (const artifact of run.artifacts) {
    if (artifact.kind === "candidate") {
      const candidate = artifact.data as CandidateData;
      builds.set(candidate.label, candidate);
    }
    if (artifact.kind === "candidateScore") {
      const score = artifact.data as CandidateScoreData;
      scores.set(score.label, score);
    }
  }
  const selected = new Map(selection?.candidates.map((candidate) => [candidate.label, candidate]) ?? []);
  const models = announced?.available ?? selection?.candidates.map((candidate) => candidate.model) ?? [];
  const labels = Array.from(new Set([...models.map((_, i) => String.fromCharCode(65 + i)), ...builds.keys(), ...scores.keys(), ...selected.keys()]));
  const childrenByModel = new Map<string, RunRecord>();
  const childrenWithoutModel: RunRecord[] = [];
  for (const child of children) {
    const builderModel = (child.input as { builderModel?: unknown } | undefined)?.builderModel;
    if (typeof builderModel === "string") childrenByModel.set(builderModel, child);
    else childrenWithoutModel.push(child);
  }
  const unmatchedModels = models.filter((model) => !childrenByModel.has(model));
  childrenWithoutModel.forEach((child, i) => {
    if (unmatchedModels[i]) childrenByModel.set(unmatchedModels[i], child);
  });
  const live = run.status === "running" || run.status === "waiting" || run.status === "connecting";
  const testing = Boolean(announced && !selection && models.length && models.every((_, i) => builds.has(String.fromCharCode(65 + i))));
  const byText = selection?.by === "lead" ? "by lead" : selection?.by === "judge" ? "by judge" : "only one ready";
  const suite = suiteSize(run, selection, scores);
  const evals = childSummaries.filter((child) => child.kind === "eval");

  return (
    <div className="space-y-2.5">
      <div className="card p-3.5">
        <div className="label mb-2">Candidates</div>
        {announced ? (
          <div className="space-y-1 text-[11.5px] text-[var(--color-muted)]">
            <div className="break-words" title={announced.models.join(" · ")}>
              {announced.models.join(" · ")}
            </div>
            {announced.failed.map((failure) => (
              <div key={failure.model} className="flex gap-1.5 text-[var(--color-bad)]">
                <X size={12} className="mt-0.5 shrink-0" />
                <span className="min-w-0 break-words">
                  <span className="mono break-all">{failure.model}</span> — {failure.error}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
            <Spinner /> Preparing candidates…
          </div>
        )}
      </div>

      {labels.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(260px,100%),1fr))] gap-2.5 pb-1">
          {labels.map((label, i) => {
            const build = builds.get(label);
            const score = scores.get(label);
            const final = selected.get(label);
            const winner = selection?.winner === label;
            const model = build?.model ?? final?.model ?? models[i];
            const child = model ? childrenByModel.get(model) : undefined;
            const candidateId = (child?.output as { spec?: { id?: unknown } } | undefined)?.spec?.id;
            const candidateEvals = typeof candidateId === "string" ? evals.filter((item) => item.agentId === candidateId) : [];
            return (
              <CandidateColumn
                key={label}
                label={label}
                model={model}
                child={child}
                build={build}
                score={score}
                final={final}
                winner={winner}
                live={live}
                evals={candidateEvals}
                suite={suite}
              />
            );
          })}
        </div>
      )}

      {testing && (
        <div className="flex items-center gap-2 px-1 text-[12px] text-[var(--color-muted)]">
          <Spinner /> Testing the candidates on the shared suite (pass^k)…
        </div>
      )}

      {selection && (
        <div className="card p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <Trophy size={14} className="text-[var(--color-ember)]" />
            <span className="text-[13px] font-semibold">Candidate {selection.winner} selected</span>
            <span className="rounded-full border border-[var(--color-line-2)] px-2 py-0.5 text-[10.5px] text-[var(--color-muted)]">{byText}</span>
          </div>
          <div className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-muted)]">{selection.reason}</div>
          <div className="mono mt-1 text-[10.5px] text-[var(--color-faint)]">
            {selection.suite} shared tests · margin {pct(selection.margin)}
          </div>
          {selection.judge && (
            <div className="mt-3 border-t border-[var(--color-line)] pt-2.5 text-[11.5px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono text-[var(--color-faint)]">{selection.judge.model}</span>
                <span>chose {selection.judge.choice}</span>
                <span style={{ color: selection.judge.accepted ? "var(--color-ok)" : "var(--color-warn)" }}>
                  {selection.judge.accepted ? "choice accepted" : "choice not accepted"}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {Object.entries(selection.judge.severity).map(([label, severity]) => (
                  <span key={label} className="inline-flex items-center gap-1">
                    {label}
                    <SeverityChip severity={severity} />
                  </span>
                ))}
              </div>
              <div className="mt-1.5 text-[var(--color-muted)]">{selection.judge.reason}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const BEST_OF_PHASES = ["Model check", "Building candidates", "Shared tests (pass^k)", "Selection", "Published"] as const;

function graphSpecKey(spec: AgentSpec) {
  const value = JSON.stringify(spec);
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${spec.nodes.length}-${spec.edges.length}-${(hash >>> 0).toString(36)}`;
}

function BestOfPhaseStepper({ run }: { run: RunState }) {
  const [, setTick] = useState(0);
  const announced = lastArtifact(run.artifacts, "candidates")?.data as { available?: string[] } | undefined;
  const candidates = run.artifacts.filter((artifact) => artifact.kind === "candidate");
  const scores = run.artifacts.filter((artifact) => artifact.kind === "candidateScore");
  const selection = lastArtifact(run.artifacts, "selection");
  const published = lastArtifact(run.artifacts, "published");
  const available = announced?.available?.length ?? 0;
  let current = !announced
    ? 0
    : candidates.length < available
      ? 1
      : scores.length < candidates.filter((artifact) => (artifact.data as CandidateData).status === "ready").length
        ? 2
        : !selection
          ? 3
          : !published
            ? 4
            : 5;
  if (["failed", "cancelled"].includes(run.status)) current = Math.min(current, 4);
  const running = run.status === "running" || run.status === "waiting" || run.status === "connecting";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const elapsedMs = Math.max(0, (run.endedAt ?? Date.now()) - (run.startedAt ?? Date.now()));
  return (
    <div className="border-b border-[var(--color-line)] bg-[var(--color-panel)] px-6 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-y-2">
          {BEST_OF_PHASES.map((phase, index) => {
            const done = index < current;
            const active = index === current && current < BEST_OF_PHASES.length;
            const failed = active && ["failed", "cancelled"].includes(run.status);
            const color = failed ? "var(--color-bad)" : done ? "var(--color-ok)" : active ? "var(--color-ember)" : "var(--color-faint)";
            return (
              <div key={phase} className="flex shrink-0 items-center whitespace-nowrap text-[11px] font-medium" style={{ color }}>
                {index > 0 && <div className="mx-3 h-px w-6 shrink-0" style={{ background: index <= current ? "var(--color-ok)" : "var(--color-line-2)" }} />}
                <span
                  className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${active && !failed ? "pulse-dot" : ""}`}
                  style={{ borderColor: color, background: done ? "rgba(52,211,153,0.1)" : active ? "rgba(249,115,22,0.1)" : undefined }}
                >
                  {done ? <Check size={11} /> : failed ? <X size={11} /> : <span className="mono text-[9px]">{index + 1}</span>}
                </span>
                <span className="ml-2">{phase}</span>
              </div>
            );
          })}
        </div>
        <span className="mono shrink-0 rounded-full border border-[var(--color-line-2)] px-2.5 py-1 text-[10.5px] text-[var(--color-muted)]">{duration(elapsedMs)} elapsed</span>
      </div>
    </div>
  );
}

function BestOfGraph({ run, children, selectedNode, onSelect }: { run: RunState; children: RunRecord[]; selectedNode: string | null; onSelect: (nodeId: string | null) => void }) {
  const announced = lastArtifact(run.artifacts, "candidates")?.data as { available?: string[] } | undefined;
  const selection = lastArtifact(run.artifacts, "selection")?.data as SelectionData | undefined;
  const candidates = run.artifacts.filter((artifact) => artifact.kind === "candidate").map((artifact) => artifact.data as CandidateData);
  const models = announced?.available ?? selection?.candidates.map((candidate) => candidate.model) ?? [];
  const childByModel = new Map<string, RunRecord>();
  children.forEach((child) => {
    const model = (child.input as { builderModel?: unknown } | undefined)?.builderModel;
    if (typeof model === "string") childByModel.set(model, child);
  });
  const cachedRun = useRef<string | undefined>(undefined);
  const specCache = useRef(new Map<string, { key: string; spec: AgentSpec; stage?: string; child?: RunRecord }>());
  if (cachedRun.current !== run.record?.id) {
    cachedRun.current = run.record?.id;
    specCache.current.clear();
  }
  const options = models
    .map((model, index) => {
      const label = candidates.find((candidate) => candidate.model === model)?.label ?? String.fromCharCode(65 + index);
      const child = childByModel.get(model);
      const artifact = child ? [...child.events].reverse().find((event): event is Artifact => event.type === "artifact" && event.kind === "spec") : undefined;
      const data = artifact?.data as { stage?: string; spec?: unknown } | undefined;
      const nextSpec = safeSpec(data?.spec);
      if (nextSpec) {
        const key = graphSpecKey(nextSpec);
        const cached = specCache.current.get(label);
        if (!cached || cached.key !== key) specCache.current.set(label, { key, spec: nextSpec, stage: data?.stage, child });
        else if (cached.child !== child || cached.stage !== data?.stage) specCache.current.set(label, { ...cached, stage: data?.stage, child });
      }
      const cached = specCache.current.get(label);
      return cached ? { label, ...cached } : { label, child, spec: null, stage: data?.stage, key: "" };
    })
    .filter((option) => option.spec);
  const visible = selection ? options.filter((option) => option.label === selection.winner) : options;
  const [candidate, setCandidate] = useState("");
  const active = visible.find((option) => option.label === candidate) ?? visible[0];
  useEffect(() => {
    if (active && candidate !== active.label) setCandidate(active.label);
  }, [active, candidate]);
  useEffect(() => onSelect(null), [active?.label]);
  if (!active?.spec)
    return (
      <div className="grid h-full place-items-center text-[12.5px] text-[var(--color-muted)]">
        <div className="text-center">
          <div className="shimmer mx-auto mb-3 h-1 w-40 rounded-full" />
          Candidate graphs appear as soon as their composer writes a draft.
        </div>
      </div>
    );
  const specStage = active.stage === "repaired" || active.stage === "compiled" ? active.stage : active.stage === "improved" ? "compiled" : "draft";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-line)] px-3">
        {visible.map((option) => (
          <button
            key={option.label}
            onClick={() => setCandidate(option.label)}
            className={`rounded px-2.5 py-1 text-[11px] font-medium ${option.label === active.label ? "bg-[var(--color-panel-2)] text-[var(--color-fg)]" : "text-[var(--color-muted)]"}`}
          >
            {option.label}
          </button>
        ))}
        <span className="ml-1 rounded-full border border-[var(--color-line-2)] px-2 py-0.5 text-[10px] text-[var(--color-muted)]">{selection ? "selected" : specStage}</span>
        {active.child && (
          <Link to={`/builds/${active.child.id}`} className="ml-auto text-[10.5px] text-[var(--color-ember)]">
            full build →
          </Link>
        )}
      </div>
      <div className={`grid min-h-0 flex-1 grid-cols-1 ${selectedNode ? "grid-rows-[minmax(320px,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-1" : "grid-rows-1"}`}>
        <div className="relative min-h-0">
          <GraphView key={`${active.label}-${active.key}`} spec={active.spec} selected={selectedNode} onSelect={onSelect} />
          <div className="pointer-events-none absolute left-4 top-3 text-[11px] text-[var(--color-faint)]">
            {active.spec.nodes.length} nodes · {active.spec.edges.length} edges
          </div>
        </div>
        {selectedNode && (
          <div className="border-t border-[var(--color-line)] lg:border-l lg:border-t-0">
            <NodeInspector spec={active.spec} nodeId={selectedNode} onClose={() => onSelect(null)} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- stage renderers ----------------------------- */

function TriageView({ a }: { a: Artifact }) {
  const d = a.data as { pattern: string; patternConfidence: number; clarity: number; complexity: number; flags: Record<string, number>; escalated: boolean };
  return (
    <div className="space-y-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-[rgba(251,191,36,0.12)] px-2 py-0.5 font-medium text-[var(--color-s1)]">{d.pattern.replace(/_/g, " ")}</span>
        <span className="text-[var(--color-muted)]">confidence {pct(d.patternConfidence)}</span>
        {d.escalated && <span className="text-[var(--color-s2)]">↑ escalated to S2</span>}
        <span className="text-[var(--color-muted)]">
          · clarity {pct(d.clarity)} · complexity {d.complexity.toFixed(1)}/3
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(d.flags).map(([k, v]) => (
          <span
            key={k}
            className="mono rounded border px-1.5 py-0.5 text-[10.5px]"
            style={{ borderColor: v >= 0.5 ? "rgba(251,191,36,0.5)" : "var(--color-line-2)", color: v >= 0.5 ? "var(--color-s1)" : "var(--color-faint)" }}
          >
            {k.replace(/_/g, " ")} {(v * 100).toFixed(0)}%
          </span>
        ))}
      </div>
    </div>
  );
}

const FILE_ROLE = { sample_input: "example input", reference: "reference data", context: "context" } as const;

function TaskSpecView({ a }: { a: Artifact }) {
  const { taskSpec: t, needsClarification } = a.data as {
    taskSpec: {
      name: string;
      goal: string;
      inputs: { name: string; type: string; required: boolean; file?: boolean }[];
      outputs: { name: string; type: string }[];
      successCriteria: string[];
      assumptions: string[];
      rules?: { id: string; rule: string; kind: "must" | "must_not"; important: boolean; source: string }[];
      interaction?: "single" | "conversation";
      files?: { id: string; name: string; role: "sample_input" | "reference" | "context"; use: string }[];
    };
    needsClarification: boolean;
  };
  return (
    <div className="space-y-2 text-[12px]">
      <div>
        <span className="font-semibold">{t.name}</span>
        {t.interaction === "conversation" && <span className="mono ml-1.5 rounded bg-[var(--color-panel-2)] px-1.5 py-0.5 text-[10.5px] font-normal">conversation</span>}{" "}
        <span className="text-[var(--color-muted)]">— {t.goal}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="label !text-[10px]">in</span>
        {t.inputs.map((i) => (
          <span key={i.name} className="mono rounded bg-[var(--color-panel-2)] px-1.5 py-0.5 text-[10.5px]">
            {i.name}
            {i.required ? "*" : ""}:{i.file ? "file" : i.type}
          </span>
        ))}
        <span className="label ml-2 !text-[10px]">out</span>
        {t.outputs.map((o) => (
          <span key={o.name} className="mono rounded bg-[var(--color-panel-2)] px-1.5 py-0.5 text-[10.5px]">
            {o.name}:{o.type}
          </span>
        ))}
      </div>
      <ul className="space-y-0.5 text-[var(--color-muted)]">
        {t.successCriteria.slice(0, 5).map((c) => (
          <li key={c} className="flex gap-1.5">
            <Check size={12} className="mt-0.5 shrink-0 text-[var(--color-ok)]" /> {c}
          </li>
        ))}
      </ul>
      {(t.rules?.length ?? 0) > 0 && (
        <div className="space-y-0.5">
          <div className="label !text-[10px]">Rules</div>
          {t.rules!.map((r) => (
            <div key={r.id} className="flex items-start gap-2 text-[11.5px]">
              <span
                className="mono shrink-0 rounded border px-1.5 py-0.5 text-[10px]"
                style={{ borderColor: r.kind === "must" ? "var(--color-ok)" : "var(--color-bad)", color: r.kind === "must" ? "var(--color-ok)" : "var(--color-bad)" }}
              >
                {r.kind === "must" ? "must" : "must not"}
              </span>
              <span className="min-w-0 flex-1">{r.rule}</span>
              {r.important && <ShieldAlert size={12} className="mt-0.5 shrink-0 text-[var(--color-ember)]" />}
              <span className="shrink-0 text-[var(--color-muted)]">{r.source}</span>
            </div>
          ))}
        </div>
      )}
      {(t.files?.length ?? 0) > 0 && (
        <div className="space-y-0.5">
          {t.files!.map((f) => (
            <div key={f.id} className="flex items-center gap-2 text-[11.5px]">
              <Paperclip size={12} className="shrink-0 text-[var(--color-ember)]" />
              <span className="truncate">{f.name}</span>
              <span className="mono shrink-0 rounded bg-[var(--color-panel-2)] px-1.5 py-0.5 text-[10px]">{FILE_ROLE[f.role]}</span>
              <span className="truncate text-[var(--color-muted)]">{f.use}</span>
            </div>
          ))}
        </div>
      )}
      {needsClarification && <div className="text-[#fda4af]">Needs clarification before designing.</div>}
    </div>
  );
}

function PlanView({ a }: { a: Artifact }) {
  const { plan, gate } = a.data as {
    plan: {
      pattern: string;
      rationale: string;
      steps: { id: string; type: string; purpose: string; model?: string; branch?: { from: string; port: string } | null }[];
      newClasses?: { type: string; kind: string; purpose: string; service?: string }[];
    };
    gate: { complete: number; minimal: number };
  };
  return (
    <div className="space-y-2 text-[12px]">
      <div className="text-[var(--color-muted)]">{plan.rationale}</div>
      <ol className="space-y-1">
        {plan.steps.map((s, i) => {
          const Icon = iconFor(s.type);
          const cat = categoryOf(s.type);
          return (
            <li key={s.id} className="flex items-start gap-2">
              <span className="mono mt-0.5 w-4 text-[10px] text-[var(--color-faint)]">{i + 1}</span>
              <Icon size={13} className="mt-0.5 shrink-0" style={{ color: cat.color }} />
              <span className="min-w-0 flex-1">
                <span className="mono text-[11px]">{s.id}</span> <span className="text-[var(--color-faint)]">{s.type}</span>
                {s.model && (
                  <span className="mono ml-1.5 inline-block max-w-full truncate rounded bg-[rgba(251,191,36,0.1)] px-1 text-[10px] text-[var(--color-s1)]" title={s.model}>
                    {s.model}
                  </span>
                )}
                {s.branch && (
                  <span className="mono ml-1.5 text-[10px] text-[var(--color-faint)]">
                    if {s.branch.from}→{s.branch.port}
                  </span>
                )}
                <div className="text-[11.5px] text-[var(--color-muted)]">{s.purpose}</div>
              </span>
            </li>
          );
        })}
      </ol>
      {plan.newClasses && plan.newClasses.length > 0 && (
        <div className="rounded-md border border-[rgba(232,121,249,0.3)] bg-[rgba(232,121,249,0.05)] p-2">
          <div className="text-[11px] font-medium text-[#e879f9]">Missing capabilities → new classes</div>
          {plan.newClasses.map((c) => (
            <div key={c.type} className="mt-1 text-[11.5px] text-[var(--color-muted)]">
              <span className="mono text-[var(--color-fg)]">{c.type}</span>{" "}
              <span className="text-[var(--color-faint)]">
                {c.kind}
                {c.service ? ` · ${c.service}` : ""}
              </span>{" "}
              — {c.purpose}
            </div>
          ))}
        </div>
      )}
      <div className="mono text-[10.5px] text-[var(--color-faint)]">
        Jev plan gate: complete {pct(gate.complete)} · minimal {pct(gate.minimal)}
      </div>
    </div>
  );
}

function SourcesView({ arts, nodeId }: { arts: Artifact[]; nodeId: string }) {
  const plan = lastArtifact(arts, "sourcePlan", nodeId)?.data as
    | {
        needs: {
          need: { id: string; description: string; fields: string[]; required: boolean };
          primary: { candidate: { url?: string; classType?: string }; access: string; score: number } | null;
          use?: { nodeType: string };
          tried: { candidate: { url?: string; classType?: string }; access: string; reachable: boolean; blocked?: string; relevance: number; note?: string; status: number }[];
        }[];
        unresolved: string[];
      }
    | undefined;
  if (!plan) return <div className="text-[12px] text-[var(--color-faint)]">No external data needs.</div>;
  return (
    <div className="space-y-2 text-[12px]">
      {plan.needs.map((n) => (
        <div key={n.need.id} className="rounded-md border border-[var(--color-line)] px-2.5 py-1.5">
          <div className="flex items-center gap-2">
            <span className="mono text-[11px]">{n.need.id}</span>
            <span className="truncate text-[11px] text-[var(--color-muted)]">{n.need.fields.join(", ")}</span>
            <span className="ml-auto text-[11px]" style={{ color: n.primary ? "var(--color-ok)" : "var(--color-bad)" }}>
              {n.primary ? `→ ${n.use?.nodeType ?? n.primary.access}` : n.need.required ? "no working source" : "no source (optional)"}
            </span>
          </div>
          {n.tried.map((x, i) => (
            <div key={i} className="mono mt-0.5 flex gap-2 truncate text-[10.5px] text-[var(--color-faint)]">
              <span style={{ color: x === (n.primary as unknown) ? "var(--color-ok)" : undefined }}>{x.reachable && !x.blocked ? (x.relevance >= 0.5 ? "✓" : "·") : "✗"}</span>
              <span className="truncate">{x.candidate.url ?? x.candidate.classType}</span>
              <span className="shrink-0">
                {x.blocked ? `blocked: ${x.blocked}` : x.reachable ? `${x.access} · relevance ${x.relevance.toFixed(2)}` : (x.note ?? `HTTP ${x.status}`)}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ClassgenView({ arts, nodeId }: { arts: Artifact[]; nodeId: string }) {
  const attempts = arts.filter((a) => a.nodeId === nodeId && a.kind === "class");
  const summary = lastArtifact(arts, "classes", nodeId)?.data as
    { results: { type: string; ok: boolean; reused?: boolean; status?: string; approved?: boolean; kind?: string; error?: string; attempts: number }[] } | undefined;
  if (!attempts.length && !summary) return <div className="text-[12px] text-[var(--color-faint)]">No missing capabilities — the built-in library covers this task.</div>;
  return (
    <div className="space-y-1.5 text-[12px]">
      {attempts.map((a, i) => {
        const d = a.data as {
          attempt: number;
          def: { type: string; title: string; status: string; impl: { kind: string }; testReport: { name: string; passed: boolean; error?: string }[] };
        };
        const color = d.def.status === "passed" ? "var(--color-ok)" : d.def.status === "failed" ? "var(--color-bad)" : "var(--color-muted)";
        return (
          <div key={i} className="rounded-md border border-[var(--color-line)] px-2.5 py-1.5">
            <div className="flex items-center gap-2">
              <span className="mono text-[11px]">{d.def.type}</span>
              <span className="text-[11px] text-[var(--color-faint)]">
                {d.def.impl.kind} · attempt {d.attempt}
              </span>
              <span className="ml-auto text-[11px]" style={{ color }}>
                tests {d.def.status}
              </span>
            </div>
            {d.def.testReport.map((r) => (
              <div key={r.name} className="mt-0.5 flex gap-1.5 text-[11px] text-[var(--color-muted)]">
                {r.passed ? <Check size={11} className="mt-0.5 text-[var(--color-ok)]" /> : <X size={11} className="mt-0.5 text-[var(--color-bad)]" />} {r.name}
                {r.error && <span className="truncate text-[var(--color-bad)]">{r.error}</span>}
              </div>
            ))}
          </div>
        );
      })}
      {summary?.results.map((r) =>
        r.reused ? (
          <div key={r.type} className="text-[11.5px] text-[var(--color-muted)]">
            <span className="mono">{r.type}</span> already in the library — reused
          </div>
        ) : !r.ok ? (
          <div key={r.type} className="text-[11.5px] text-[var(--color-warn)]">
            <span className="mono">{r.type}</span> could not be made to work — falling back to generic nodes
          </div>
        ) : r.approved === false ? (
          <div key={r.type} className="text-[11.5px] text-[#fda4af]">
            <span className="mono">{r.type}</span> has side effects — approve it in the{" "}
            <Link to="/library" className="underline">
              Node Library
            </Link>{" "}
            before running agents that use it
          </div>
        ) : null,
      )}
    </div>
  );
}

function CompileView({ passes }: { passes: Artifact[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="space-y-1 text-[12px]">
      {passes.map((p, i) => {
        const d = p.data as { attempt: number; strategy: string; errors: number; warnings: number; diagnostics: Diagnostic[]; fixes: string[]; notes?: string };
        return (
          <div key={i}>
            <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(open === i ? null : i)}>
              {open === i ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span className="mono text-[11px] text-[var(--color-faint)]">pass {d.attempt}</span>
              <span className="mono text-[11px]">{d.strategy}</span>
              <span className="mono ml-auto text-[11px]" style={{ color: d.errors ? "var(--color-bad)" : "var(--color-ok)" }}>
                {d.errors} errors
              </span>
              <span className="mono text-[11px] text-[var(--color-faint)]">{d.warnings} warn</span>
            </button>
            {open === i && (
              <div className="ml-5 mt-1 space-y-1">
                {d.fixes.length > 0 && <div className="text-[11px] text-[var(--color-muted)]">auto-fixes: {d.fixes.join("; ")}</div>}
                {d.notes && <div className="text-[11px] text-[var(--color-muted)]">repair notes: {d.notes}</div>}
                {d.diagnostics.map((x, j) => (
                  <div key={j} className="text-[11px]">
                    <span className="mono" style={{ color: x.severity === "error" ? "var(--color-bad)" : "var(--color-warn)" }}>
                      {x.code}
                    </span>{" "}
                    <span className="text-[var(--color-muted)]">{x.message}</span>
                    {x.hint && <span className="text-[var(--color-faint)]"> — {x.hint}</span>}
                  </div>
                ))}
                {!d.diagnostics.length && <div className="text-[11px] text-[var(--color-ok)]">clean</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EvolveView({ arts, nodeId }: { arts: Artifact[]; nodeId: string }) {
  const mine = arts.filter((a) => a.nodeId === nodeId && ["evaluation", "critique", "testsAdjusted", "intentRejected", "acceptanceAdjusted"].includes(a.kind));
  const history = lastArtifact(arts, "evolution", nodeId)?.data as { history: { round: number; score: number; passRate: number; accepted: boolean; change: string }[] } | undefined;
  return (
    <div className="space-y-2 text-[12px]">
      {mine.map((a, i) => {
        if (a.kind === "evaluation") {
          const d = a.data as { round: number; report: EvaluationReport };
          return (
            <div key={i} className="flex items-center gap-3">
              <span className="mono text-[11px] text-[var(--color-faint)]">round {d.round}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-panel-2)]">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${d.report.score * 100}%`, background: d.report.score >= 0.85 ? "#34d399" : d.report.score >= 0.6 ? "#fbbf24" : "#f87171" }}
                />
              </div>
              <span className="mono text-[11px]">score {(d.report.score * 100).toFixed(0)}</span>
              <span className="mono text-[11px] text-[var(--color-muted)]">{pct(d.report.passRate)} pass</span>
            </div>
          );
        }
        if (a.kind === "critique") {
          const d = a.data as { round: number; diagnosis: string; changes: string[] };
          return (
            <div key={i} className="rounded-md border border-[rgba(167,139,250,0.25)] bg-[rgba(167,139,250,0.05)] p-2">
              <div className="text-[11px] font-medium text-[var(--color-s2)]">Critic · round {d.round}</div>
              <div className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">{d.diagnosis}</div>
              <ul className="mt-1 list-disc pl-4 text-[11px] text-[var(--color-muted)]">
                {d.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          );
        }
        if (a.kind === "acceptanceAdjusted") {
          const d = a.data as { removed: { id: string; rule: string }[]; tests: string[] };
          return (
            <div key={i} className="rounded-md border border-[rgba(251,191,36,0.3)] bg-[rgba(251,191,36,0.05)] p-2 text-[11px]">
              <div className="font-medium text-[var(--color-warn)]">
                Removed {d.removed.length} acceptance rule(s): the outputs of {d.tests.length} test(s) met every test item, but these rules rejected them.
              </div>
              <ul className="mono mt-1 list-disc pl-4 text-[var(--color-muted)]">
                {d.removed.map((x) => (
                  <li key={x.id}>
                    {x.id}: {x.rule}
                  </li>
                ))}
              </ul>
            </div>
          );
        }
        if (a.kind === "intentRejected") {
          const d = a.data as { round: number; p: number; changes: string[] };
          return (
            <div key={i} className="rounded-md border border-[rgba(248,113,113,0.3)] bg-[rgba(248,113,113,0.05)] p-2 text-[11px]">
              <div className="font-medium text-[var(--color-bad)]">
                Round {d.round}: change rejected. It changes the meaning of the request (p={d.p.toFixed(2)}).
              </div>
              <ul className="mt-1 list-disc pl-4 text-[var(--color-muted)]">
                {d.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          );
        }
        const d = a.data as { dropped: { criterion?: string; item?: string; test?: string; blame?: FailureBlame; meaning?: string }[] };
        return (
          <div key={i} className="rounded-md border border-[rgba(251,191,36,0.3)] bg-[rgba(251,191,36,0.05)] p-2 text-[11px]">
            <div className="font-medium text-[var(--color-warn)]">Removed {d.dropped.length} faulty test item(s). The diagnosis gives them to the tests, not to the agent.</div>
            <ul className="mt-1 list-disc pl-4 text-[var(--color-muted)]">
              {d.dropped.map((x, j) => (
                <li key={j}>
                  “{x.item ?? x.criterion}”{x.test ? ` (${x.test})` : ""}
                  {x.blame && <span className="text-[var(--color-warn)]"> · {BLAME_TEXT[x.blame].label}</span>}
                  {x.meaning && <span> · {x.meaning}</span>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {history && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {history.history.map((h) => (
            <span
              key={h.round}
              className="mono rounded border px-1.5 py-0.5 text-[10.5px]"
              title={h.change}
              style={{ borderColor: h.accepted ? "rgba(52,211,153,0.4)" : "var(--color-line-2)", color: h.accepted ? "var(--color-ok)" : "var(--color-faint)" }}
            >
              r{h.round} {(h.score * 100).toFixed(0)} {h.accepted ? "✓" : "✗"}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function StageBody({ type, nodeId, run }: { type: string; nodeId: string; run: RunState }) {
  const arts = run.artifacts;
  switch (type) {
    case "anvil_tools": {
      const a = lastArtifact(arts, "givenTools", nodeId);
      const d = a?.data as { closed: boolean; tools: { type: string; name: string; description: string; sideEffects: boolean }[] } | undefined;
      if (!d?.closed) return <div className="text-[12px] text-[var(--color-faint)]">No given tools: an open build.</div>;
      return (
        <div className="space-y-2 text-[12px]">
          <div className="text-[var(--color-muted)]">Closed build: the agent uses only these tools.</div>
          <div className="space-y-1.5">
            {d.tools.map((tool) => (
              <div key={tool.type} className="rounded-md border border-[var(--color-line)] px-2.5 py-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{tool.name}</span>
                  <span className="mono rounded bg-[var(--color-panel-2)] px-1.5 py-0.5 text-[10px] text-[var(--color-muted)]">{tool.type}</span>
                  {tool.sideEffects && <span className="rounded border border-[var(--color-warn)] px-1.5 py-0.5 text-[10px] text-[var(--color-warn)]">changes data</span>}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-[var(--color-muted)]">{tool.description}</div>
              </div>
            ))}
          </div>
        </div>
      );
    }
    case "anvil_triage": {
      const a = lastArtifact(arts, "triage", nodeId);
      const est = lastArtifact(arts, "estimate", nodeId)?.data as { lowUsd: number; highUsd: number; basis: string; samples: number; limitUsd: number } | undefined;
      return a ? (
        <div className="space-y-2">
          <TriageView a={a} />
          {est && (
            <div className="mono text-[11px]" style={{ color: est.highUsd > est.limitUsd ? "var(--color-warn)" : "var(--color-muted)" }}>
              estimated cost ${est.lowUsd.toFixed(3)}–${est.highUsd.toFixed(3)} · {est.basis === "history" ? `from ${est.samples} similar builds` : "starting estimate"} · limit $
              {est.limitUsd}
            </div>
          )}
        </div>
      ) : null;
    }
    case "anvil_analyze": {
      const a = lastArtifact(arts, "taskSpec", nodeId);
      return a ? <TaskSpecView a={a} /> : null;
    }
    case "anvil_architect": {
      const a = lastArtifact(arts, "plan", nodeId);
      return a ? <PlanView a={a} /> : null;
    }
    case "anvil_compose":
    case "anvil_edit": {
      const passes = arts.filter((a) => a.kind === "validation" && a.nodeId === nodeId);
      return passes.length ? <CompileView passes={passes} /> : null;
    }
    case "anvil_testgen": {
      const a = lastArtifact(arts, "tests", nodeId);
      const tests = (a?.data as { tests: TestCase[] } | undefined)?.tests ?? [];
      return tests.length ? (
        <ul className="space-y-0.5 text-[12px] text-[var(--color-muted)]">
          {tests.map((t) => (
            <li key={t.id} className="flex gap-1.5">
              <FlaskConical size={12} className="mt-0.5 shrink-0 text-[var(--color-ember)]" /> {t.name}{" "}
              <span className="text-[var(--color-faint)]">
                · {t.criteria.length} criteria, {t.checks.length} checks
              </span>
            </li>
          ))}
        </ul>
      ) : null;
    }
    case "anvil_library": {
      const a = lastArtifact(arts, "library", nodeId);
      return a ? <LibraryStageView data={a.data as Parameters<typeof LibraryStageView>[0]["data"]} /> : null;
    }
    case "anvil_sources":
      return <SourcesView arts={arts} nodeId={nodeId} />;
    case "anvil_classgen":
      return <ClassgenView arts={arts} nodeId={nodeId} />;
    case "anvil_evolve":
      return <EvolveView arts={arts} nodeId={nodeId} />;
    case "anvil_publish": {
      const a = lastArtifact(arts, "published", nodeId);
      const d = a?.data as { agentId: string; version: number } | undefined;
      return d ? (
        <Link to={`/agents/${d.agentId}`} className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--color-ok)]">
          {d.agentId} v{d.version} is live <ArrowRight size={13} />
        </Link>
      ) : null;
    }
    default:
      return null;
  }
}

function Stage({ node, run, index }: { node: AgentSpec["nodes"][number]; run: RunState; index: number }) {
  const status = run.nodeStates[node.id] ?? "pending";
  const [expanded, setExpanded] = useState(false);
  const cat = categoryOf(node.type);
  const Icon = iconFor(node.type);
  const events = run.events.filter((e) => "nodeId" in e && e.nodeId === node.id);
  const started = events.find((e) => e.type === "node.started");
  const completed = [...events].reverse().find((e) => e.type === "node.completed") as Extract<RunEvent, { type: "node.completed" }> | undefined;
  const decisions = events.filter((e) => e.type === "decision") as Extract<RunEvent, { type: "decision" }>[];
  const detail = events.filter((e) => e.type === "llm" || e.type === "log" || e.type === "node.failed");
  const active = status === "running" || status === "waiting";
  if (status === "skipped") {
    return (
      <div className="flex items-center gap-3 px-1 py-1.5 text-[12px] text-[var(--color-faint)]">
        <CircleSlash size={13} /> {node.name ?? node.id} <span className="text-[11px]">skipped</span>
      </div>
    );
  }
  return (
    <div
      className={`fade-in relative rounded-xl border p-3.5 transition-colors ${active ? "border-[rgba(249,115,22,0.55)] bg-[rgba(249,115,22,0.035)]" : "border-[var(--color-line)] bg-[var(--color-panel)]"} ${status === "pending" ? "opacity-45" : ""}`}
    >
      {active && <div className="shimmer pointer-events-none absolute inset-x-0 top-0 h-[2px] rounded-t-xl" />}
      <div className="flex items-center gap-2.5">
        <div className="grid h-7 w-7 place-items-center rounded-md" style={{ background: cat.bg, color: cat.color }}>
          {status === "running" ? <Spinner size={14} /> : <Icon size={14} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px] font-semibold">
            <span className="mono text-[10.5px] font-normal text-[var(--color-faint)]">{String(index).padStart(2, "0")}</span> {node.name ?? node.id}
          </div>
          {node.description && <div className="truncate text-[11.5px] text-[var(--color-muted)]">{node.description}</div>}
        </div>
        {status === "done" && completed && (
          <span className="mono text-[10.5px] text-[var(--color-faint)]">
            {duration(completed.durationMs)} · {money(completed.usage.costUsd)}
          </span>
        )}
        {status === "failed" && <X size={14} className="text-[var(--color-bad)]" />}
        {status === "done" && <Check size={14} className="text-[var(--color-ok)]" />}
      </div>
      {(started || status !== "pending") && (
        <div className="mt-3 space-y-2.5 pl-[38px]">
          <StageBody type={node.type} nodeId={node.id} run={run} />
          {decisions.slice(-3).map((d, i) => (
            <DecisionCard key={i} e={d} defaultOpen={active} />
          ))}
          {detail.length > 0 && (
            <div>
              <button className="flex items-center gap-1 text-[11px] text-[var(--color-faint)] hover:text-[var(--color-muted)]" onClick={() => setExpanded(!expanded)}>
                {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />} {detail.filter((e) => e.type === "llm").length} LLM calls ·{" "}
                {detail.filter((e) => e.type === "log").length} logs
              </button>
              {expanded && (
                <div className="mt-1">
                  {detail.map((e, i) => (
                    <EventRow key={i} e={e} showNode={false} />
                  ))}
                </div>
              )}
            </div>
          )}
          {status === "failed" && <div className="text-[12px] text-[var(--color-bad)]">{run.nodeErrors[node.id]}</div>}
        </div>
      )}
    </div>
  );
}

/* --------------------------------- tests tab -------------------------------- */

function TestsTab({ run, version }: { run: RunState; version?: AgentVersion | null }) {
  const tests = version?.spec.tests ?? (lastArtifact(run.artifacts, "tests")?.data as { tests: TestCase[] } | undefined)?.tests ?? [];
  const results = version
    ? (version.evaluation?.results.map((result) => ({ round: 1, result })) ?? [])
    : run.artifacts.filter((a) => a.kind === "testResult").map((a) => a.data as { round: number; result: TestResult });
  const latestRound = results.reduce((m, r) => Math.max(m, r.round), 0);
  const latest = new Map(results.filter((r) => r.round === latestRound).map((r) => [r.result.testId, r.result]));
  if (!tests.length) return <div className="p-6 text-[12px] text-[var(--color-muted)]">Tests appear here once synthesized.</div>;
  return (
    <div className="space-y-3 p-4">
      <div className="text-[11.5px] text-[var(--color-muted)]">
        {version
          ? version.evaluation
            ? `Results from evaluation of v${version.version}.`
            : `Published tests for v${version.version}; this version has no evaluation results.`
          : `Results from evaluation round ${latestRound}.`}{" "}
        Criteria are graded by Jev (probability the output satisfies them); checks are deterministic.
      </div>
      {tests.map((t) => {
        const r = latest.get(t.id);
        return (
          <div key={t.id} className="card p-3">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              {r ? r.passed ? <Check size={14} className="text-[var(--color-ok)]" /> : <X size={14} className="text-[var(--color-bad)]" /> : <Spinner size={12} />}
              {t.name}
              {r && (
                <span className="mono ml-auto text-[11px] text-[var(--color-muted)]">
                  {r.environment ? "not scored · rate limit" : `score ${(r.score * 100).toFixed(0)}`}
                  {r.partial ? " · partial" : ""}
                  {r.ste ? ` · STE ${r.ste.per100w}/100w` : ""} · {duration(r.durationMs)}
                </span>
              )}
              {r?.runId && (
                <Link to={`/runs/${r.runId}`} className="text-[11px] text-[var(--color-ember)]">
                  trace →
                </Link>
              )}
            </div>
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[11px] text-[var(--color-faint)]">input</summary>
              <JsonBlock value={t.input} className="mt-1 max-h-48" />
            </details>
            <div className="mt-2 space-y-1">
              {t.criteria.map((c) => {
                const cr = r?.criteria.find((x) => x.criterion === c);
                return (
                  <div key={c} className="grid grid-cols-[1fr_60px] items-center gap-2 text-[11.5px]">
                    <span className="min-w-0 break-words text-[var(--color-muted)]">
                      {c}
                      {cr && !cr.passed && findBlame(r, "criterion", c) && <BlameChip d={findBlame(r, "criterion", c)!} />}
                    </span>
                    <span className="mono text-right" style={{ color: cr ? (cr.passed ? "var(--color-ok)" : "var(--color-bad)") : "var(--color-faint)" }}>
                      {cr ? `${(cr.probability * 100).toFixed(0)}%` : "—"}
                    </span>
                  </div>
                );
              })}
              {t.checks.map((c, i) => {
                const cr = r?.checks[i];
                return (
                  <div key={i} className="grid grid-cols-[1fr_60px] items-center gap-2 text-[11.5px]">
                    <span className="mono min-w-0 break-words text-[var(--color-muted)]">
                      {c.path} {c.op} {c.value !== undefined ? JSON.stringify(c.value) : ""}
                    </span>
                    <span className="mono text-right" style={{ color: cr ? (cr.passed ? "var(--color-ok)" : "var(--color-bad)") : "var(--color-faint)" }}>
                      {cr ? (cr.passed ? "pass" : "fail") : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
            {r?.environment && (
              <div className="mt-2 text-[11.5px] text-[var(--color-warn)]">
                Not scored: the environment stopped this test, not the agent. Evidence: {r.environment}. Run the evaluation again when the limit resets.
              </div>
            )}
            {r?.error && <div className="mt-2 text-[11.5px] text-[var(--color-bad)]">{r.error}</div>}
            {r?.output !== undefined && (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-[11px] text-[var(--color-faint)]">output</summary>
                <JsonBlock value={r.output} className="mt-1 max-h-64" />
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------------- page ---------------------------------- */

export function BuildPage() {
  const { runId } = useParams();
  const run = useRun(runId);
  const [meta, setMeta] = useState<AgentSpec | null>(null);
  const [publishedVersion, setPublishedVersion] = useState<AgentVersion | null>(null);
  const [tab, setTab] = useState<"graph" | "json" | "tests" | "builder">("graph");
  const [selected, setSelected] = useState<string | null>(null);
  const [childRuns, setChildRuns] = useState<RunRecord[]>([]);
  const [childSummaries, setChildSummaries] = useState<RunSummary[]>([]);
  const childRecords = useRef(new Map<string, RunRecord>());
  const childStatuses = useRef(new Map<string, RunSummary["status"]>());

  const metaId = run.record?.agentId;
  useEffect(() => {
    if (!metaId) return;
    api
      .agent(metaId)
      .then((a) => setMeta(a.versions.find((v) => v.version === a.currentVersion)?.spec ?? null))
      .catch(() => undefined);
  }, [metaId]);

  const isBestOf = run.record?.agentId === "anvil-best-of" || Boolean(lastArtifact(run.artifacts, "candidates"));
  const published = lastArtifact(run.artifacts, "published")?.data as { agentId: string; version: number; name: string; quality?: Quality } | undefined;
  const finalOutput = run.output as { agentId?: unknown; version?: unknown; score?: number; passRate?: number } | undefined;
  const publishedRef =
    published ??
    (typeof finalOutput?.agentId === "string" && typeof finalOutput.version === "number"
      ? { agentId: finalOutput.agentId, version: finalOutput.version, name: finalOutput.agentId }
      : undefined);

  useEffect(() => {
    let cancelled = false;
    setPublishedVersion(null);
    if (!isBestOf || !publishedRef) return () => void (cancelled = true);
    api
      .agent(publishedRef.agentId)
      .then((agent) => {
        if (!cancelled) setPublishedVersion(agent.versions.find((version) => version.version === publishedRef.version) ?? null);
      })
      .catch(() => undefined);
    return () => void (cancelled = true);
  }, [isBestOf, publishedRef?.agentId, publishedRef?.version]);

  const specArt = lastArtifact(run.artifacts, "spec");
  const spec = useMemo(() => safeSpec(isBestOf ? publishedVersion?.spec : (specArt?.data as { spec?: unknown } | undefined)?.spec), [isBestOf, publishedVersion, specArt]);
  const stage = (specArt?.data as { stage?: string } | undefined)?.stage;
  // Show the version that was actually published (the best), not merely the last round evaluated.
  const evolution = lastArtifact(run.artifacts, "evolution")?.data as { best?: { score: number; passRate: number } } | undefined;
  const finalEval = lastArtifact(run.artifacts, "evaluation")?.data as { report: EvaluationReport } | undefined;
  const outputEval = finalOutput;
  const lastEval = evolution?.best
    ? { report: evolution.best as EvaluationReport }
    : (finalEval ?? (outputEval?.score !== undefined ? { report: outputEval as EvaluationReport } : undefined));
  const input = (run.record?.input ?? {}) as { request?: string; instruction?: string; agentId?: string };
  const done = ["completed", "failed", "cancelled"].includes(run.status);

  useEffect(() => {
    if (!runId || !isBestOf) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const summaries = await api.runs({ parent: runId });
        if (cancelled) return;
        setChildSummaries(summaries);
        const builds = summaries.filter((child) => child.kind === "build" && child.agentId === "anvil-builder");
        const changed = builds.filter((child) => {
          const active = child.status === "queued" || child.status === "running" || child.status === "waiting";
          return active || !childRecords.current.has(child.id) || childStatuses.current.get(child.id) !== child.status;
        });
        const records = await Promise.all(changed.map((child) => api.runRecord(child.id)));
        if (cancelled) return;
        records.forEach((record) => childRecords.current.set(record.id, record));
        childStatuses.current = new Map(builds.map((child) => [child.id, child.status]));
        setChildRuns(
          builds.flatMap((child) => {
            const record = childRecords.current.get(child.id);
            return record ? [record] : [];
          }),
        );
      } catch {
        // The next poll can recover from a transient request failure.
      }
    };
    void poll();
    const timer = done ? undefined : window.setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [done, isBestOf, runId]);

  useEffect(() => {
    setChildRuns([]);
    setChildSummaries([]);
    childRecords.current.clear();
    childStatuses.current.clear();
  }, [runId]);

  const childCost = childRuns.reduce((sum, child) => sum + child.usage.costUsd, 0);
  const headerRun = !done && run.usage.costUsd === 0 && childCost > 0 ? { ...run, usage: { ...run.usage, costUsd: childCost } } : run;
  const stages = isBestOf ? [] : (meta?.nodes ?? []).filter((n) => n.type !== "input" && n.type !== "output");
  const title = run.record?.kind === "build" ? "Building agent" : (run.record?.agentName ?? "Meta run");

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-[var(--color-line)] px-6 py-4">
        {run.record?.parentRunId && (
          <Link className="mb-3 inline-flex text-[12px] font-medium text-[var(--color-ember)] hover:underline" to={`/builds/${run.record.parentRunId}`}>
            ← Back to best-of run
          </Link>
        )}
        <div className="flex flex-col items-start gap-4 lg:flex-row">
          <div className="min-w-0 flex-1">
            <div className="label">{title}</div>
            <div className="mt-1 line-clamp-2 text-[15px] font-medium leading-snug">{input.request ?? input.instruction ?? input.agentId ?? "…"}</div>
            <div className="mt-2">
              <RunHeaderStats run={headerRun} />
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 lg:ml-auto">
            {!done && runId && (
              <button className="btn btn-ghost" onClick={() => api.cancel(runId)}>
                <Square size={13} /> Cancel
              </button>
            )}
            {published && (
              <>
                {lastEval && <ScoreBadge score={lastEval.report.score} passRate={lastEval.report.passRate} size="lg" />}
                {published.quality && published.quality !== "passed" && <QualityBadge quality={published.quality} />}
                <Link to={`/agents/${published.agentId}?tab=run`} className="btn">
                  <Play size={13} /> Run it
                </Link>
                <Link to={`/agents/${published.agentId}`} className="btn btn-primary">
                  Open {published.name} <ArrowRight size={14} />
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {isBestOf && <BestOfPhaseStepper run={run} />}

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto xl:grid-cols-[minmax(420px,5fr)_7fr] xl:overflow-hidden">
        <div className="min-h-[480px] space-y-2.5 overflow-auto border-b border-[var(--color-line)] p-5 xl:min-h-0 xl:border-b-0 xl:border-r">
          {run.pending.map((p, i) => runId && <HumanPanel key={`${p.nodeId}-${i}`} runId={runId} nodeId={p.nodeId} request={p.request} />)}
          {isBestOf && <BestOfView run={run} children={childRuns} childSummaries={childSummaries} />}
          {stages.map((n, i) => (
            <Stage key={n.id} node={n} run={run} index={i + 1} />
          ))}
          {run.status === "failed" && (
            <div className="rounded-xl border border-[rgba(248,113,113,0.45)] bg-[rgba(248,113,113,0.06)] p-3.5 text-[12.5px] text-[var(--color-bad)]">{run.error}</div>
          )}
          {!isBestOf && !stages.length && (
            <div className="flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
              <Spinner /> Loading…
            </div>
          )}
        </div>

        <div className="flex min-h-[520px] flex-col xl:min-h-0">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "graph", label: "Agent graph" },
              { id: "tests", label: "Tests & evals" },
              { id: "json", label: "Spec JSON" },
              { id: "builder", label: "The builder itself" },
            ]}
            right={stage && <span className="mono text-[10.5px] text-[var(--color-faint)]">spec: {stage}</span>}
          />
          <div className="relative min-h-0 flex-1">
            {tab === "graph" &&
              (isBestOf ? (
                <BestOfGraph run={run} children={childRuns} selectedNode={selected} onSelect={setSelected} />
              ) : spec ? (
                <div className={`grid h-full grid-cols-1 ${selected ? "grid-rows-[minmax(320px,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-1" : "grid-rows-1"}`}>
                  <div className="relative min-h-0">
                    <GraphView spec={spec} selected={selected} onSelect={setSelected} />
                    <div className="pointer-events-none absolute left-4 top-3 text-[11px] text-[var(--color-faint)]">
                      {spec.nodes.length} nodes · {spec.edges.length} edges {!done && stage !== "compiled" && stage !== "improved" ? "· compiling…" : ""}
                    </div>
                  </div>
                  {selected && (
                    <div className="border-t border-[var(--color-line)] lg:border-l lg:border-t-0">
                      <NodeInspector spec={spec} nodeId={selected} onClose={() => setSelected(null)} />
                    </div>
                  )}
                </div>
              ) : (
                <div className="grid h-full place-items-center text-[12.5px] text-[var(--color-muted)]">
                  <div className="text-center">
                    <div className="shimmer mx-auto mb-3 h-1 w-40 rounded-full" />
                    The agent graph appears as soon as the composer writes the first draft.
                  </div>
                </div>
              ))}
            {tab === "json" && (
              <div className="absolute inset-0 overflow-auto">
                {spec ? <JsonEditor value={JSON.stringify(spec, null, 2)} readOnly /> : <div className="p-6 text-[12px] text-[var(--color-muted)]">No spec yet.</div>}
              </div>
            )}
            {tab === "tests" && (
              <div className="absolute inset-0 overflow-auto">
                <TestsTab run={run} version={isBestOf ? publishedVersion : undefined} />
              </div>
            )}
            {tab === "builder" && meta && (
              <div className="flex h-full flex-col">
                <div className="border-b border-[var(--color-line)] px-4 py-2.5 text-[12px] text-[var(--color-muted)]">
                  This run is executed by <span className="mono text-[var(--color-fg)]">{meta.id}</span> — itself a Anvil agent written in the same JSON IR and run by the same
                  engine as the agents it builds.{" "}
                  <Link className="text-[var(--color-ember)]" to={`/agents/${meta.id}`}>
                    Inspect it →
                  </Link>
                </div>
                <div className="relative min-h-0 flex-1">
                  <GraphView spec={meta} states={run.nodeStates} compact />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
