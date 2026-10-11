import type { AgentSpec } from "@core/types";
import { Save, ThumbsDown, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { RunViewer } from "../components/RunViewer";
import { Spinner } from "../components/ui";
import { api, type FeedbackTest } from "../lib/api";
import { useRun } from "../lib/useRun";

const META = new Set(["anvil-builder", "anvil-refiner", "anvil-evaluator", "anvil-evolver", "anvil-classsmith"]);

function FeedbackForm({ runId, agentId }: { runId: string; agentId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [expected, setExpected] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [test, setTest] = useState<FeedbackTest | null>(null);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const result = await api.giveFeedback(runId, reason.trim(), expected.trim() || undefined);
      setTest(result.test);
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (test)
    return (
      <div className="card w-full p-3 text-[12px]">
        <div className="flex items-center gap-2 font-medium">
          <span className="text-[var(--color-ok)]">Test added</span>
          <span>{test.name}</span>
          <Link className="ml-auto text-[11.5px] text-[var(--color-ember)]" to={`/agents/${agentId}?tab=tests`}>
            Tests →
          </Link>
        </div>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-[var(--color-muted)]">
          {test.criteria.map((criterion) => (
            <li key={criterion}>{criterion}</li>
          ))}
        </ul>
      </div>
    );

  if (!open)
    return (
      <button className="btn !px-2 !py-1 text-[11.5px]" onClick={() => setOpen(true)}>
        <ThumbsDown size={12} /> Wrong
      </button>
    );

  return (
    <div className="card w-full space-y-3 p-3">
      <div className="flex items-center gap-2 text-[12.5px] font-semibold">
        Turn this feedback into a test
        <button className="btn btn-ghost ml-auto !p-1" onClick={() => setOpen(false)} disabled={saving}>
          <X size={13} />
        </button>
      </div>
      <label className="block">
        <div className="mb-1 text-[12px] text-[var(--color-muted)]">What is wrong?</div>
        <textarea className="input min-h-[72px] resize-y" required value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <label className="block">
        <div className="mb-1 text-[12px] text-[var(--color-muted)]">
          Expected output <span className="text-[var(--color-faint)]">(optional)</span>
        </div>
        <textarea className="input min-h-[60px] resize-y" value={expected} onChange={(e) => setExpected(e.target.value)} />
      </label>
      {err && <div className="text-[12px] text-[var(--color-bad)]">{err}</div>}
      <div className="flex justify-end">
        <button className="btn btn-primary" disabled={saving || !reason.trim()} onClick={save}>
          {saving ? <Spinner /> : <Save size={13} />} Save
        </button>
      </div>
    </div>
  );
}

export function RunPage() {
  const { id } = useParams();
  const run = useRun(id);
  const [spec, setSpec] = useState<AgentSpec | null>(null);
  const [system, setSystem] = useState(false);
  const [missing, setMissing] = useState(false);
  const agentId = run.record?.agentId;
  const version = run.record?.version;

  useEffect(() => {
    if (!agentId || META.has(agentId)) return;
    api
      .agent(agentId)
      .then((a) => {
        setSystem(Boolean(a.system));
        setSpec((a.versions.find((v) => v.version === version) ?? a.versions.find((v) => v.version === a.currentVersion))?.spec ?? null);
      })
      .catch(() => setMissing(true));
  }, [agentId, version]);

  // Evaluation runs of unsaved candidates: reconstruct the graph from the parent build's artifacts.
  useEffect(() => {
    if (!missing || !run.record?.parentRunId) return;
    api.runRecord(run.record.parentRunId).then((p) => {
      const arts = p.events.filter((e) => e.type === "artifact" && e.kind === "spec");
      const last = arts.at(-1) as { data?: { spec?: AgentSpec } } | undefined;
      if (last?.data?.spec) setSpec(last.data.spec);
    });
  }, [missing, run.record?.parentRunId]);

  if (agentId && META.has(agentId)) return <Navigate to={`/builds/${id}`} replace />;
  if (!run.record || !spec)
    return (
      <div className="flex items-center gap-2 p-8 text-[13px] text-[var(--color-muted)]">
        <Spinner /> Loading run…
      </div>
    );
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-[var(--color-line)] px-6 py-3">
        <div className="label">{run.record.kind === "eval" ? "Evaluation run" : "Run"}</div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2 text-[15px] font-semibold">
          <Link to={`/agents/${run.record.agentId}`} className="min-w-0 truncate hover:text-[var(--color-ember)]" title={run.record.agentName}>
            {run.record.agentName}
          </Link>
          <span className="mono min-w-0 truncate text-[12px] font-normal text-[var(--color-faint)]" title={run.record.id}>
            v{run.record.version} · {run.record.id}
          </span>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <RunViewer
          spec={spec}
          run={run}
          runId={id!}
          outputAction={run.status === "completed" && run.record.kind === "run" && !system ? <FeedbackForm runId={id!} agentId={run.record.agentId} /> : undefined}
        />
      </div>
    </div>
  );
}
