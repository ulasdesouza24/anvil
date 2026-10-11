import { Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CopyButton, Empty, Spinner, Stat } from "../components/ui";
import { api, type BenchReport } from "../lib/api";
import { ago, duration, money } from "../lib/format";

const delta = (n: number | null | undefined, digits = 3, invert = false) => {
  if (n === null || n === undefined || n === 0) return null;
  const good = invert ? n < 0 : n > 0;
  return (
    <span className="mono ml-1 text-[10.5px]" style={{ color: good ? "var(--color-ok)" : "var(--color-bad)" }}>
      {n > 0 ? "+" : ""}
      {n.toFixed(digits)}
    </span>
  );
};

export function BenchmarkPage() {
  const [reports, setReports] = useState<BenchReport[] | null>(null);
  const [sel, setSel] = useState(0);
  useEffect(() => {
    api
      .bench()
      .then(setReports)
      .catch(() => setReports([]));
  }, []);
  if (!reports)
    return (
      <div className="p-8">
        <Spinner />
      </div>
    );
  const r = reports[sel];
  const caseDelta = new Map((r?.delta.cases ?? []).map((c) => [c.id, c]));
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-8 sm:py-8">
        <h1 className="text-[22px] font-bold tracking-tight">Benchmark</h1>
        <p className="max-w-[760px] text-[13px] text-[var(--color-muted)]">
          A fixed suite of build requests measures the builder. Run it after each change to the builder or the harness, and compare the result with the previous report.
        </p>
        <div className="card mt-4 flex flex-wrap items-center gap-3 p-3 text-[12.5px]">
          <span className="label">Run</span>
          <span className="mono whitespace-nowrap">npm run bench -- --budget 3</span>
          <CopyButton text="npm run bench -- --budget 3" />
          <span className="text-[var(--color-faint)]">Each case is a real build and costs money. Use --only, --limit and --budget to control the cost.</span>
        </div>
        {!r && (
          <Empty icon={<Gauge size={28} />} title="No benchmark reports yet">
            Run the command above. Reports go to data/bench.
          </Empty>
        )}
        {r && (
          <>
            <div className="mt-5 flex flex-wrap gap-2">
              {reports.map((x, i) => (
                <button
                  key={x.id}
                  className={`rounded-md border px-2.5 py-1 text-[11.5px] ${i === sel ? "border-[var(--color-ember)] text-[var(--color-fg)]" : "border-[var(--color-line-2)] text-[var(--color-muted)]"}`}
                  onClick={() => setSel(i)}
                >
                  {ago(x.startedAt)} · {x.gitCommit ?? "—"} · {x.totals.cases} cases
                </button>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
              <Stat
                label="Mean score"
                value={
                  <>
                    {r.totals.meanScore ?? "—"}
                    {delta(r.delta.meanScore)}
                  </>
                }
                accent="var(--color-ember)"
              />
              {typeof r.totals.hiddenMeanScore === "number" && <Stat label="Hidden tests" value={r.totals.hiddenMeanScore} accent="var(--color-ember)" />}
              <Stat label="Met" value={`${r.totals.met}/${r.totals.cases}`} />
              <Stat
                label="Cost"
                value={
                  <>
                    {money(r.totals.costUsd)}
                    {delta(r.delta.costUsd, 3, true)}
                  </>
                }
              />
              <Stat label="Repeated calls" value={r.totals.repeatedToolCalls} />
              <Stat
                label="Evolve"
                value={`${r.totals.testItemsRemoved ?? 0} / ${r.totals.intentRejections ?? 0} / ${r.totals.disputedItems ?? 0}`}
                sub="removed / intent / disputed"
              />
              <Stat
                label={`Library ${r.options.library === false ? "(off)" : "(on)"}`}
                value={`${r.totals.examplesUsed ?? 0} / ${r.totals.lessonsUsed ?? 0}`}
                sub="examples / lessons used"
              />
              <Stat label="Tokens / step" value={r.totals.tokensPerStepAvg.toLocaleString()} />
              <Stat label="Cache hit" value={`${Math.round(r.totals.cacheHitRate * 100)}%`} />
              <Stat label="Partial" value={`${Math.round(r.totals.partialRate * 100)}%`} sub={duration(r.totals.durationMs)} />
            </div>
            <div className="card mt-4 overflow-x-auto">
              <table className="min-w-max w-full text-[12px]">
                <thead className="border-b border-[var(--color-line)] text-left">
                  <tr className="label">
                    {[
                      "Case",
                      "Category",
                      "Score",
                      "Pass",
                      "Hidden",
                      "Cost",
                      "Eval cost",
                      "Searches",
                      "Steps max",
                      "Repeats",
                      "Cache",
                      "Recall",
                      "Summaries",
                      "Examples / lessons",
                      "Met",
                    ].map((h) => (
                      <th key={h} className="px-3 py-2 font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-line)]">
                  {r.cases.map((c) => {
                    const m = c.metrics;
                    const d = caseDelta.get(c.id);
                    return (
                      <tr key={c.id}>
                        <td className="max-w-64 truncate px-3 py-2" title={c.id}>
                          {c.runId ? (
                            <Link className="hover:text-[var(--color-ember)]" to={`/builds/${c.runId}`}>
                              {c.id}
                            </Link>
                          ) : (
                            c.id
                          )}
                        </td>
                        <td className="mono px-3 text-[11px] text-[var(--color-muted)]">{c.category}</td>
                        <td className="mono px-3">
                          {m?.score ?? "—"}
                          {delta(d?.score)}
                        </td>
                        <td className="mono px-3">{m?.passRate ?? "—"}</td>
                        <td className="mono px-3" title={c.hidden?.failed.join("\n")}>
                          {c.hidden ? `${c.hidden.score} · ${c.hidden.tests - c.hidden.failed.length}/${c.hidden.tests}` : "—"}
                        </td>
                        <td className="mono px-3">
                          {m ? money(m.costUsd) : "—"}
                          {delta(d?.costUsd, 3, true)}
                        </td>
                        <td className="mono px-3 text-[var(--color-muted)]">{m ? money(m.evalCostUsd) : "—"}</td>
                        <td className="mono px-3">{m?.webSearches ?? "—"}</td>
                        <td className="mono px-3">{m?.tokensPerStepMax.toLocaleString() ?? "—"}</td>
                        <td className="mono px-3">{m?.repeatedToolCalls ?? "—"}</td>
                        <td className="mono px-3">{m ? `${Math.round(m.cacheHitRate * 100)}%` : "—"}</td>
                        <td className="mono px-3">{m?.recallReads ?? "—"}</td>
                        <td className="mono px-3">{m ? m.detailedSummaries + m.compactions : "—"}</td>
                        <td className="mono px-3" title={m?.domain ?? undefined}>
                          {m ? `${m.examplesUsed ?? 0} / ${m.lessonsUsed ?? 0}` : "—"}
                        </td>
                        <td className="px-3" title={c.misses.join("\n")} style={{ color: c.met ? "var(--color-ok)" : "var(--color-bad)" }}>
                          {c.met ? "yes" : "no"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {r.skipped.length > 0 && <div className="mt-3 text-[12px] text-[var(--color-warn)]">Skipped: {r.skipped.map((s) => `${s.id} (${s.reason})`).join(", ")}</div>}
          </>
        )}
      </div>
    </div>
  );
}
