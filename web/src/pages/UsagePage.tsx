import { useEffect, useState } from "react";
import { Spinner, Stat } from "../components/ui";
import { api } from "../lib/api";
import { compact, money } from "../lib/format";

export function UsagePage() {
  const [u, setU] = useState<Awaited<ReturnType<typeof api.usage>> | null>(null);
  useEffect(() => {
    api
      .usage()
      .then(setU)
      .catch(() => undefined);
  }, []);
  if (!u)
    return (
      <div className="p-8">
        <Spinner />
      </div>
    );
  const days = Object.entries(u.byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-14);
  const maxDay = Math.max(0.0000001, ...days.map(([, d]) => d.costUsd));
  const agents = Object.entries(u.byAgent)
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .slice(0, 10);
  const s1Share = u.totals.decisionCalls / Math.max(1, u.totals.decisionCalls + u.totals.llmCalls);
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1200px] px-8 py-8">
        <h1 className="text-[22px] font-bold tracking-tight">Usage</h1>
        <p className="text-[13px] text-[var(--color-muted)]">
          Cost and call volume across builds and runs. Decisions go to the fast System-1 model; generation to the System-2 LLM.
        </p>
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Total cost" value={money(u.totals.costUsd)} accent="var(--color-ember)" />
          <Stat label="Runs" value={u.totals.runs} sub={`${u.totals.failures} failed`} />
          <Stat label="System 1 calls" value={u.totals.decisionCalls} sub={`${(s1Share * 100).toFixed(0)}% of all model calls`} accent="var(--color-s1)" />
          <Stat label="System 2 calls" value={u.totals.llmCalls} accent="var(--color-s2)" />
          <Stat label="Tokens" value={compact(u.totals.inputTokens + u.totals.outputTokens)} sub={`${compact(u.totals.inputTokens)} in · ${compact(u.totals.outputTokens)} out`} />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="card p-4">
            <div className="label mb-4">Cost per day</div>
            <div className="flex h-[160px] items-end gap-2">
              {days.map(([day, d]) => (
                <div key={day} className="flex flex-1 flex-col items-center gap-1.5" title={`${day}: ${money(d.costUsd)} · ${d.runs} runs`}>
                  <span className="mono text-[10px] text-[var(--color-faint)]">{money(d.costUsd)}</span>
                  <div className="w-full rounded-t bg-[var(--color-ember)]" style={{ height: `${Math.max(2, (d.costUsd / maxDay) * 120)}px`, opacity: 0.85 }} />
                  <span className="mono text-[10px] text-[var(--color-faint)]">{day.slice(5)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="card p-4">
            <div className="label mb-3">By kind</div>
            <table className="w-full text-[12.5px]">
              <tbody className="divide-y divide-[var(--color-line)]">
                {Object.entries(u.byKind).map(([k, v]) => (
                  <tr key={k}>
                    <td className="mono py-2">{k}</td>
                    <td className="py-2 text-right text-[var(--color-muted)]">{v.runs} runs</td>
                    <td className="mono py-2 text-right text-[var(--color-s1)]">{v.decisionCalls}</td>
                    <td className="mono py-2 text-right text-[var(--color-s2)]">{v.llmCalls}</td>
                    <td className="mono py-2 text-right text-[var(--color-muted)]">{compact(v.tokens)} tok</td>
                    <td className="mono py-2 text-right">{money(v.costUsd)}</td>
                    <td className="mono py-2 text-right text-[var(--color-faint)]">{money(v.costUsd / Math.max(1, v.runs))}/run</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card mt-4 p-4">
          <div className="label mb-3">Top agents by cost</div>
          <div className="space-y-2">
            {agents.map(([id, a]) => (
              <div key={id} className="grid grid-cols-[220px_1fr_80px_90px] items-center gap-3 text-[12.5px]">
                <span className="truncate">{a.name}</span>
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-panel-2)]">
                  <div className="h-full rounded-full bg-[var(--color-ember)]" style={{ width: `${(a.costUsd / Math.max(0.0000001, agents[0][1].costUsd)) * 100}%` }} />
                </div>
                <span className="text-right text-[11.5px] text-[var(--color-muted)]">{a.runs} runs</span>
                <span className="mono text-right">{money(a.costUsd)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
