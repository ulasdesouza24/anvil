import { History } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Empty, StatusBadge } from "../components/ui";
import { api, type RunSummary } from "../lib/api";
import { ago, duration, money } from "../lib/format";

const KINDS = ["all", "build", "run", "trigger", "refine", "eval"] as const;

export function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [kind, setKind] = useState<(typeof KINDS)[number]>("all");
  // The test runs of the workflow editor are hidden by default (docs/WORKFLOW_EDITOR.md).
  const [editorRuns, setEditorRuns] = useState(false);
  useEffect(() => {
    const load = () =>
      api
        .runs({ kind: kind === "all" ? undefined : kind, limit: 200, origin: editorRuns ? undefined : "!editor" })
        .then(setRuns)
        .catch(() => undefined);
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [kind, editorRuns]);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1200px] px-8 py-8">
        <div className="flex items-end gap-4">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight">Runs</h1>
            <p className="text-[13px] text-[var(--color-muted)]">Every execution is traced node by node: inputs, outputs, decisions, LLM calls, cost.</p>
          </div>
          <label className="ml-auto flex items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
            <input type="checkbox" checked={editorRuns} onChange={(e) => setEditorRuns(e.target.checked)} /> Editor test runs
          </label>
          <div className="flex gap-1 rounded-lg border border-[var(--color-line)] p-0.5">
            {KINDS.map((k) => (
              <button
                key={k}
                className={`rounded-md px-2.5 py-1 text-[12px] ${kind === k ? "bg-[var(--color-panel-2)] text-[var(--color-fg)]" : "text-[var(--color-muted)]"}`}
                onClick={() => setKind(k)}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
        {runs && !runs.length && <Empty icon={<History size={28} />} title="No runs yet" />}
        {runs && runs.length > 0 && (
          <div className="card mt-6 overflow-hidden">
            <table className="w-full text-[12.5px]">
              <thead className="border-b border-[var(--color-line)] text-left">
                <tr className="label">
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                  <th className="px-2 py-2.5 font-semibold">Kind</th>
                  <th className="px-2 py-2.5 font-semibold">Agent</th>
                  <th className="px-2 py-2.5 font-semibold">Input</th>
                  <th className="px-2 py-2.5 text-right font-semibold">Calls</th>
                  <th className="px-2 py-2.5 text-right font-semibold">Duration</th>
                  <th className="px-2 py-2.5 text-right font-semibold">Cost</th>
                  <th className="px-4 py-2.5 text-right font-semibold">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-line)]">
                {runs.map((r) => (
                  <tr key={r.id} className="transition-colors hover:bg-[var(--color-panel-2)]">
                    <td className="px-4 py-2.5">
                      <Link to={r.agentId.startsWith("anvil-") ? `/builds/${r.id}` : `/runs/${r.id}`}>
                        <StatusBadge status={r.status} />
                      </Link>
                    </td>
                    <td className="mono px-2 text-[11.5px] text-[var(--color-muted)]">
                      {r.kind}
                      {r.origin === "editor" && <span className="ml-1.5 rounded bg-[var(--color-panel-2)] px-1 text-[10px] text-[var(--color-ember)]">editor</span>}
                      {r.dryRun && <span className="ml-1 rounded bg-[var(--color-panel-2)] px-1 text-[10px] text-[var(--color-s1)]">dry run</span>}
                    </td>
                    <td className="px-2">
                      <Link to={r.agentId.startsWith("anvil-") ? `/builds/${r.id}` : `/runs/${r.id}`} className="hover:text-[var(--color-ember)]">
                        {r.agentName}
                      </Link>
                      {r.resultAgentId && <span className="mono ml-2 text-[11px] text-[var(--color-ok)]">→ {r.resultAgentId}</span>}
                    </td>
                    <td className="mono max-w-[320px] truncate px-2 text-[11px] text-[var(--color-faint)]">{r.inputPreview}</td>
                    <td className="mono px-2 text-right text-[11px] text-[var(--color-muted)]">
                      <span className="text-[var(--color-s1)]">{r.usage.decisionCalls}</span> / <span className="text-[var(--color-s2)]">{r.usage.llmCalls}</span>
                    </td>
                    <td className="mono px-2 text-right text-[11px] text-[var(--color-muted)]">{duration((r.endedAt ?? Date.now()) - r.startedAt)}</td>
                    <td className="mono px-2 text-right text-[11px] text-[var(--color-muted)]">{money(r.usage.costUsd)}</td>
                    <td className="px-4 text-right text-[11px] text-[var(--color-faint)]">{ago(r.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
