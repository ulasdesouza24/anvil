import type { AgentSpec, AgentVersion, Diagnostic, JSONSchema, StoredAgent } from "@core/types";
import { Activity, Check, Download, FlaskConical, MessageSquare, Play, Save, Sparkles, Store, Trash2, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { GraphView } from "../components/GraphView";
import { ShareDialog } from "../components/ShareDialog";
import { TriggersPanel } from "../components/Triggers";
import { NodeInspector, RunViewer } from "../components/RunViewer";
import { SchemaForm } from "../components/SchemaForm";
import { CopyButton, Empty, JsonBlock, JsonEditor, QualityBadge, QualityWarning, ScoreBadge, Spinner, StatusBadge, Tabs, Toggle } from "../components/ui";
import { qualityOf } from "@core/quality";
import { BlameChip, DiagnosisSummary, findBlame } from "../components/Diagnosis";
import { AgentSandboxTab } from "../components/SandboxViews";
import { ChatPanel } from "../components/ChatPanel";

const checkText = (c: { path: string; op: string; value?: unknown }) => `${c.path} ${c.op}${c.value !== undefined ? ` ${JSON.stringify(c.value)}` : ""}`;
import { api, getToken, type AgentHealth, type Feedback, type RunSummary, type ValidationResult } from "../lib/api";
import { ago, duration, money, pct } from "../lib/format";
import { useRun } from "../lib/useRun";

type Tab = "graph" | "run" | "tests" | "health" | "triggers" | "versions" | "sandbox" | "edit" | "api";

function exampleInput(spec: AgentSpec): Record<string, unknown> {
  const t = spec.tests[0]?.input;
  if (t) return structuredClone(t);
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries((spec.inputSchema as JSONSchema).properties ?? {})) if (s.default !== undefined) out[k] = s.default;
  return out;
}

/* ---------------------------------- run tab --------------------------------- */

function RunTab({ agent, spec }: { agent: StoredAgent; spec: AgentSpec }) {
  const [input, setInput] = useState<Record<string, unknown>>(() => exampleInput(spec));
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recent, setRecent] = useState<RunSummary[]>([]);
  const run = useRun(runId ?? undefined);

  useEffect(() => {
    api
      .runs({ agentId: agent.id, kind: "run", limit: 8 })
      .then(setRecent)
      .catch(() => undefined);
  }, [agent.id, run.status]);

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.run(agent.id, input, spec.version);
      setRunId(r.runId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 overflow-auto lg:grid-cols-[360px_minmax(0,1fr)] lg:overflow-hidden">
      <div className="min-h-[380px] overflow-auto border-b border-[var(--color-line)] p-5 lg:min-h-0 lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-2">
          <div className="label">Input</div>
          {spec.tests.length > 0 && (
            <select
              className="input ml-auto !w-auto !py-1 text-[12px]"
              defaultValue=""
              onChange={(e) => e.target.value !== "" && setInput(structuredClone(spec.tests[Number(e.target.value)].input))}
            >
              <option value="">Load a test input…</option>
              {spec.tests.map((t, i) => (
                <option key={t.id} value={i}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="mt-3">
          <SchemaForm schema={spec.inputSchema as JSONSchema} value={input} onChange={setInput} />
        </div>
        <button className="btn btn-primary mt-4 w-full justify-center !py-2" onClick={start} disabled={busy || agent.system}>
          {busy ? <Spinner /> : <Play size={14} />} Run v{spec.version}
        </button>
        {agent.system && <div className="mt-2 text-[11.5px] text-[var(--color-muted)]">Meta-agents run from the Build page and agent actions.</div>}
        {err && <div className="mt-2 text-[12px] text-[var(--color-bad)]">{err}</div>}
        {recent.length > 0 && (
          <div className="mt-8">
            <div className="label mb-2">Recent runs</div>
            <div className="space-y-1">
              {recent.map((r) => (
                <button
                  key={r.id}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-[var(--color-panel-2)]"
                  onClick={() => setRunId(r.id)}
                >
                  <StatusBadge status={r.status} />
                  <span className="mono min-w-0 flex-1 truncate text-[11px] text-[var(--color-faint)]">{r.inputPreview}</span>
                  <span className="mono text-[10.5px] text-[var(--color-faint)]">{ago(r.startedAt)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="min-h-[420px] lg:min-h-0">
        {runId ? (
          <RunViewer spec={spec} run={run} runId={runId} />
        ) : (
          <div className="relative h-full">
            <GraphView spec={spec} />
            <div className="pointer-events-none absolute inset-x-0 top-4 text-center text-[12px] text-[var(--color-faint)]">
              Fill the input and press Run — nodes light up as they execute.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* --------------------------------- tests tab -------------------------------- */

function TestsTab({ agent, version }: { agent: StoredAgent; version: AgentVersion }) {
  const nav = useNavigate();
  const ev = version.evaluation;
  const [feedback, setFeedback] = useState<Feedback[] | null>(null);
  const [improving, setImproving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .feedbackList(agent.id)
      .then(setFeedback)
      .catch((e) => setErr((e as Error).message));
  }, [agent.id]);

  const improve = async () => {
    setImproving(true);
    setErr(null);
    try {
      nav(`/builds/${(await api.improveFromFeedback(agent.id)).runId}`);
    } catch (e) {
      setErr((e as Error).message);
      setImproving(false);
    }
  };
  return (
    <div className="h-full overflow-auto p-6">
      <div className="flex items-center gap-3">
        <div>
          <div className="text-[15px] font-semibold">Evaluation · v{version.version}</div>
          <div className="text-[12px] text-[var(--color-muted)]">
            {ev
              ? `Ran ${ago(ev.at)} · ${money(ev.costUsd)}${ev.stePer100w !== undefined ? ` · STE ${ev.stePer100w} violations per 100 words` : ""}`
              : "This version has not been evaluated yet."}
          </div>
        </div>
        {ev && <ScoreBadge score={ev.score} passRate={ev.passRate} size="lg" />}
        {!agent.system && (
          <div className="ml-auto flex gap-2">
            <button className="btn" onClick={async () => nav(`/builds/${(await api.evaluate(agent.id, version.version)).runId}`)}>
              <FlaskConical size={14} /> Run tests
            </button>
            <button className="btn btn-primary" onClick={async () => nav(`/builds/${(await api.evolve(agent.id)).runId}`)}>
              <Sparkles size={14} /> Evolve
            </button>
          </div>
        )}
      </div>
      {feedback && feedback.length > 0 && (
        <div className="card mt-5 overflow-hidden">
          <div className="flex items-center gap-3 border-b border-[var(--color-line)] px-4 py-3">
            <div>
              <div className="text-[13px] font-semibold">Feedback</div>
              <div className="text-[11.5px] text-[var(--color-muted)]">Wrong outputs saved as tests, newest first.</div>
            </div>
            {!agent.system && (
              <button className="btn btn-primary ml-auto" onClick={improve} disabled={improving}>
                {improving ? <Spinner /> : <Sparkles size={13} />} Improve from feedback
              </button>
            )}
          </div>
          <div className="divide-y divide-[var(--color-line)]">
            {feedback.map((item) => (
              <div key={item.id} className="flex items-start gap-3 px-4 py-2.5 text-[12px]">
                <div className="min-w-0 flex-1 text-[var(--color-muted)]">{item.reason}</div>
                <span className="shrink-0 text-[11px] text-[var(--color-faint)]" title={new Date(item.at).toLocaleString()}>
                  {ago(item.at)}
                </span>
                <Link className="shrink-0 text-[11.5px] text-[var(--color-ember)]" to={`/runs/${item.runId}`}>
                  run →
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
      {err && <div className="mt-3 text-[12px] text-[var(--color-bad)]">{err}</div>}
      <DiagnosisSummary report={ev} />
      <div className="mt-5 space-y-3">
        {version.spec.tests.map((t) => {
          const r = ev?.results.find((x) => x.testId === t.id);
          return (
            <div key={t.id} className="card p-4">
              <div className="flex items-center gap-2 text-[13px] font-medium">
                {r ? (
                  r.passed ? (
                    <Check size={14} className="text-[var(--color-ok)]" />
                  ) : (
                    <X size={14} className="text-[var(--color-bad)]" />
                  )
                ) : (
                  <FlaskConical size={14} className="text-[var(--color-faint)]" />
                )}
                {t.name}
                {t.id.startsWith("f") && <span className="rounded-full border border-[rgba(249,115,22,0.5)] px-2 py-0.5 text-[10.5px] text-[var(--color-ember)]">feedback</span>}
                {t.id.startsWith("g") && <span className="rounded-full border border-[var(--color-line-2)] px-2 py-0.5 text-[10.5px] text-[var(--color-muted)]">given</span>}
                {r && (
                  <span className="mono ml-auto text-[11px] text-[var(--color-muted)]">
                    score {(r.score * 100).toFixed(0)}
                    {r.partial ? " · partial" : ""}
                    {r.ste ? ` · STE ${r.ste.per100w}/100w` : ""} · {duration(r.durationMs)}
                  </span>
                )}
                {r?.runId && (
                  <Link className="text-[11px] text-[var(--color-ember)]" to={`/runs/${r.runId}`}>
                    trace →
                  </Link>
                )}
              </div>
              <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <div className="label mb-1">Input</div>
                  <JsonBlock value={t.input} className="max-h-56" />
                </div>
                <div>
                  <div className="label mb-1">Assertions</div>
                  <div className="space-y-1">
                    {t.criteria.map((c) => {
                      const cr = r?.criteria.find((x) => x.criterion === c);
                      return (
                        <div key={c} className="flex gap-2 text-[12px]">
                          <span className="mono w-10 shrink-0 text-right" style={{ color: cr ? (cr.passed ? "var(--color-ok)" : "var(--color-bad)") : "var(--color-faint)" }}>
                            {cr ? pct(cr.probability) : "—"}
                          </span>
                          <div className="min-w-0 break-words">
                            <span className="text-[var(--color-muted)]">{c}</span>
                            {cr && !cr.passed && findBlame(r, "criterion", c) && <BlameChip d={findBlame(r, "criterion", c)!} />}
                          </div>
                        </div>
                      );
                    })}
                    {t.checks.map((c, i) => (
                      <div key={i} className="flex gap-2 text-[12px]">
                        <span
                          className="mono w-10 shrink-0 text-right"
                          style={{ color: r ? (r.checks[i]?.passed ? "var(--color-ok)" : "var(--color-bad)") : "var(--color-faint)" }}
                        >
                          {r ? (r.checks[i]?.passed ? "pass" : "fail") : "—"}
                        </span>
                        <div className="min-w-0 break-words">
                          <span className="mono text-[11.5px] text-[var(--color-muted)]">
                            {c.path} {c.op} {c.value !== undefined ? JSON.stringify(c.value) : ""}
                          </span>
                          {r && !r.checks[i]?.passed && findBlame(r, "check", checkText(c)) && <BlameChip d={findBlame(r, "check", checkText(c))!} />}
                        </div>
                      </div>
                    ))}
                  </div>
                  {r?.error && <div className="mt-2 text-[12px] text-[var(--color-bad)]">{r.error}</div>}
                </div>
              </div>
              {r?.output !== undefined && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11.5px] text-[var(--color-faint)]">Output</summary>
                  <JsonBlock value={r.output} className="mt-1 max-h-72" />
                </details>
              )}
            </div>
          );
        })}
        {!version.spec.tests.length && <Empty title="No tests">Refine the agent or rebuild it with testing enabled.</Empty>}
      </div>
    </div>
  );
}

/* -------------------------------- health tab ------------------------------- */

function HealthTab({ agentId, initial }: { agentId: string; initial: AgentHealth }) {
  const [health, setHealth] = useState(initial);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const last = health.last;

  const check = async () => {
    setChecking(true);
    setErr(null);
    try {
      setHealth(await api.checkHealth(agentId));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="h-full overflow-auto p-6">
      <div className="flex items-start gap-3">
        <div>
          <div className="text-[15px] font-semibold">Live data health</div>
          <div className="mt-1 flex items-center gap-2 text-[12px] text-[var(--color-muted)]">
            <span title={health.status === "broken" ? last?.cause : undefined}>
              <StatusBadge status={health.status} />
            </span>
            <span>{last ? `Last checked ${ago(last.at)}` : "No check has run yet"}</span>
            {last && (
              <span className="mono text-[11px] text-[var(--color-faint)]">
                score {pct(last.score)} · baseline {pct(last.baseline)}
              </span>
            )}
          </div>
        </div>
        <button className="btn ml-auto" onClick={check} disabled={checking}>
          {checking ? <Spinner /> : <Activity size={14} />} {checking ? "Checking…" : "Check now"}
        </button>
      </div>
      {err && <div className="mt-3 text-[12px] text-[var(--color-bad)]">{err}</div>}
      {health.status === "broken" && last?.cause && (
        <div className="mt-4 rounded-lg border border-[rgba(248,113,113,0.4)] bg-[rgba(248,113,113,0.06)] px-3 py-2 text-[12px] text-[var(--color-bad)]">{last.cause}</div>
      )}
      {health.history.length > 0 ? (
        <div className="card mt-5 overflow-x-auto">
          <table className="min-w-max w-full text-[12.5px]">
            <thead className="border-b border-[var(--color-line)] text-left">
              <tr className="label">
                <th className="px-4 py-2.5 font-semibold">Time</th>
                <th className="px-2 py-2.5 font-semibold">Version</th>
                <th className="px-2 py-2.5 font-semibold">Status</th>
                <th className="px-2 py-2.5 text-right font-semibold">Score</th>
                <th className="px-2 py-2.5 text-right font-semibold">Baseline</th>
                <th className="px-2 py-2.5 text-right font-semibold">Failed tests</th>
                <th className="px-2 py-2.5 text-right font-semibold">Cost</th>
                <th className="px-4 py-2.5 text-right font-semibold">Fix</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-line)]">
              {health.history.map((check, i) => (
                <tr key={`${check.at}-${i}`} className="transition-colors hover:bg-[var(--color-panel-2)]">
                  <td className="px-4 py-2.5 text-[11px] text-[var(--color-faint)]" title={new Date(check.at).toLocaleString()}>
                    {ago(check.at)}
                  </td>
                  <td className="mono px-2 text-[11.5px] text-[var(--color-muted)]">v{check.version}</td>
                  <td className="px-2">
                    <span title={check.status === "broken" ? check.cause : undefined}>
                      <StatusBadge status={check.status} />
                    </span>
                  </td>
                  <td className="mono px-2 text-right">{pct(check.score)}</td>
                  <td className="mono px-2 text-right text-[var(--color-muted)]">{pct(check.baseline)}</td>
                  <td className="mono px-2 text-right" title={check.failed.length ? check.failed.join("\n") : undefined}>
                    {check.failed.length}
                  </td>
                  <td className="mono px-2 text-right text-[var(--color-muted)]">{money(check.costUsd)}</td>
                  <td className="px-4 text-right">
                    {check.fixRunId ? (
                      <Link className="text-[11.5px] text-[var(--color-ember)]" to={`/builds/${check.fixRunId}`}>
                        fix run →
                      </Link>
                    ) : (
                      <span className="text-[var(--color-faint)]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon={<Activity size={28} />} title="No health checks yet">
          Run a check to test this agent against fresh live data.
        </Empty>
      )}
    </div>
  );
}

/* ------------------------------- versions tab ------------------------------- */

function VersionsTab({ agent, onChange }: { agent: StoredAgent; onChange: () => void }) {
  const scored = agent.versions.filter((v) => v.score !== undefined && v.score !== null);
  const max = agent.versions.length;
  return (
    <div className="h-full overflow-auto p-6">
      {scored.length > 1 && (
        <div className="card mb-5 p-4">
          <div className="label mb-3">Score across versions</div>
          <svg viewBox={`0 0 ${Math.max(1, max - 1) * 80 + 40} 90`} className="h-[110px] w-full" preserveAspectRatio="none">
            {[0.5, 1].map((y) => (
              <line key={y} x1="0" x2="100%" y1={80 - y * 70} y2={80 - y * 70} stroke="#232731" strokeDasharray="3 3" />
            ))}
            <polyline fill="none" stroke="#f97316" strokeWidth="2" points={scored.map((v) => `${(v.version - 1) * 80 + 20},${80 - (v.score ?? 0) * 70}`).join(" ")} />
            {scored.map((v) => (
              <g key={v.version}>
                <circle cx={(v.version - 1) * 80 + 20} cy={80 - (v.score ?? 0) * 70} r="4" fill="#f97316" />
                <text x={(v.version - 1) * 80 + 20} y={80 - (v.score ?? 0) * 70 - 9} fill="#9097a4" fontSize="10" textAnchor="middle">
                  v{v.version} · {((v.score ?? 0) * 100).toFixed(0)}
                </text>
              </g>
            ))}
          </svg>
        </div>
      )}
      <div className="card divide-y divide-[var(--color-line)]">
        {[...agent.versions].reverse().map((v) => (
          <div key={v.version} className="flex flex-wrap items-center gap-4 px-4 py-3 text-[13px]">
            <span className="mono w-10 font-semibold">v{v.version}</span>
            {v.version > agent.currentVersion && (
              <span className="rounded-full border border-[rgba(249,115,22,0.5)] px-2 py-0.5 text-[10.5px] text-[var(--color-ember)]">draft</span>
            )}
            <span className="min-w-0 flex-1 truncate text-[var(--color-muted)]">{v.note}</span>
            <span className="text-[11.5px] text-[var(--color-faint)]">{v.spec.nodes.length} nodes</span>
            <ScoreBadge score={v.evaluation?.score ?? v.score} passRate={v.evaluation?.passRate} />
            <span className="w-20 text-right text-[11.5px] text-[var(--color-faint)]">{ago(v.createdAt)}</span>
            {v.buildRunId && (
              <Link className="text-[11.5px] text-[var(--color-ember)]" to={`/builds/${v.buildRunId}`}>
                build log
              </Link>
            )}
            {agent.currentVersion === v.version ? (
              <span className="rounded-full bg-[rgba(52,211,153,0.12)] px-2 py-0.5 text-[11px] text-[var(--color-ok)]">current</span>
            ) : (
              !agent.system && (
                <button
                  className="btn !py-1 text-[11.5px]"
                  onClick={async () => {
                    await api.setCurrent(agent.id, v.version);
                    onChange();
                  }}
                >
                  Make current
                </button>
              )
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------- edit tab --------------------------------- */

function EditTab({ agent, spec, onSaved }: { agent: StoredAgent; spec: AgentSpec; onSaved: () => void }) {
  const nav = useNavigate();
  const [instruction, setInstruction] = useState("");
  const [optimize, setOptimize] = useState(false);
  const [text, setText] = useState(() => JSON.stringify({ ...spec, meta: undefined }, null, 2));
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const parsed = JSON.parse(text);
        setParseErr(null);
        setValidation(await api.validate({ ...parsed, id: agent.id }));
      } catch (e) {
        setParseErr((e as Error).message);
        setValidation(null);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [text, agent.id]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const parsed = JSON.parse(text);
      const a = await api.saveAgent(agent.id, { ...parsed, meta: spec.meta }, "edited JSON in Anvil UI");
      setMsg(`Saved as v${a.currentVersion}`);
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 overflow-auto lg:grid-cols-[minmax(0,1fr)_380px] lg:overflow-hidden">
      <div className="flex min-h-[480px] flex-col border-b border-[var(--color-line)] lg:min-h-0 lg:border-b-0 lg:border-r">
        <div className="flex items-center gap-3 border-b border-[var(--color-line)] px-4 py-2">
          <div className="text-[12.5px] font-medium">Spec JSON</div>
          {parseErr ? (
            <span className="text-[11.5px] text-[var(--color-bad)]">JSON: {parseErr}</span>
          ) : validation ? (
            <span className="text-[11.5px]" style={{ color: validation.valid ? "var(--color-ok)" : "var(--color-bad)" }}>
              {validation.valid ? "✓ compiles" : `${validation.errors} errors`} · {validation.warnings} warnings
            </span>
          ) : null}
          <button className="btn btn-primary ml-auto !py-1 text-[12px]" disabled={agent.system || saving || !validation?.valid} onClick={save}>
            {saving ? <Spinner /> : <Save size={13} />} Save as new version
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <JsonEditor value={text} onChange={setText} readOnly={agent.system} />
        </div>
        {msg && <div className="border-t border-[var(--color-line)] px-4 py-2 text-[12px] text-[var(--color-muted)]">{msg}</div>}
      </div>
      <div className="min-h-0 overflow-auto p-5">
        {!agent.system && (
          <div className="card p-4">
            <div className="flex items-center gap-2 text-[13px] font-semibold">
              <Wand2 size={14} className="text-[var(--color-ember)]" /> Refine with an instruction
            </div>
            <p className="mt-1 text-[12px] text-[var(--color-muted)]">
              The refiner meta-agent patches the spec, recompiles, updates tests and re-evaluates, then publishes a new version.
            </p>
            <textarea
              className="input mt-3 min-h-[96px] resize-y"
              placeholder="e.g. Also return a Turkish translation of the reply, and escalate to a human if the customer mentions a lawyer."
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
            <div className="mt-3 flex items-center gap-3">
              <Toggle checked={optimize} onChange={setOptimize} label="Evolve after" />
              <button
                className="btn btn-primary ml-auto"
                disabled={!instruction.trim()}
                onClick={async () => nav(`/builds/${(await api.refine(agent.id, instruction, optimize)).runId}`)}
              >
                <Wand2 size={13} /> Refine
              </button>
            </div>
          </div>
        )}
        <div className="mt-5">
          <div className="label mb-2">Diagnostics</div>
          {validation?.diagnostics.length ? (
            <div className="space-y-2">
              {validation.diagnostics.map((d: Diagnostic, i: number) => (
                <div key={i} className="rounded-lg border border-[var(--color-line)] p-2.5 text-[12px]">
                  <div className="mono text-[10.5px]" style={{ color: d.severity === "error" ? "var(--color-bad)" : "var(--color-warn)" }}>
                    {d.severity} · {d.code} {d.path && <span className="text-[var(--color-faint)]">{d.path}</span>}
                  </div>
                  <div className="mt-0.5 text-[var(--color-muted)]">{d.message}</div>
                  {d.hint && <div className="mt-0.5 text-[11px] text-[var(--color-faint)]">{d.hint}</div>}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[12px] text-[var(--color-muted)]">{validation ? "No issues — the spec compiles cleanly." : "…"}</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- api tab --------------------------------- */

function ApiTab({ spec }: { spec: AgentSpec }) {
  const input = JSON.stringify(exampleInput(spec));
  const origin = window.location.port === "5173" ? "http://127.0.0.1:8787" : window.location.origin;
  const curl = `curl -s ${origin}/api/agents/${spec.id}/run \\\n  -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ input: JSON.parse(input), wait: true }).replace(/'/g, "'\\''")}'`;
  const authorization = getToken() ? `\n    "Authorization": "Bearer <ANVIL_API_TOKEN>",` : "";
  const js = `const res = await fetch("${origin}/api/agents/${spec.id}/run", {\n  method: "POST",\n  headers: {\n    "Content-Type": "application/json",${authorization}\n  },\n  body: JSON.stringify({ input: ${input}, wait: true }),\n});\nconst { output, usage } = await res.json();`;
  return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-[860px] space-y-5">
        <div>
          <div className="text-[15px] font-semibold">Instant API</div>
          <p className="mt-1 text-[12.5px] text-[var(--color-muted)]">
            Every agent is served at its own endpoint. Omit <span className="mono">wait</span> to get a run id and stream events from{" "}
            <span className="mono">/api/runs/:id/events</span> (SSE).
          </p>
        </div>
        {[
          { label: "curl", code: curl },
          { label: "JavaScript", code: js },
        ].map((s) => (
          <div key={s.label} className="card overflow-hidden">
            <div className="flex items-center border-b border-[var(--color-line)] px-3 py-1.5">
              <span className="label">{s.label}</span>
              <span className="ml-auto">
                <CopyButton text={s.code} label="Copy" />
              </span>
            </div>
            <pre className="mono overflow-auto p-3 text-[12px] leading-relaxed text-[#cfd4dc]">{s.code}</pre>
          </div>
        ))}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <div className="label mb-1">Input schema</div>
            <JsonBlock value={spec.inputSchema} />
          </div>
          <div>
            <div className="label mb-1">Output schema</div>
            <JsonBlock value={spec.outputSchema ?? spec.nodes.find((n) => n.type === "output")?.config.value ?? {}} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------- page ---------------------------------- */

export function AgentPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const [agent, setAgent] = useState<StoredAgent | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [sharing, setSharing] = useState(false);
  const [agentHealth, setAgentHealth] = useState<AgentHealth | null>(null);
  const [hasHealth, setHasHealth] = useState(false);
  const tab = (params.get("tab") as Tab) ?? "graph";
  const setTab = (t: Tab) => setParams(t === "graph" ? {} : { tab: t }, { replace: true });

  const load = () => {
    if (!id) return;
    api
      .agent(id)
      .then((a) => {
        setAgent(a);
        setViewVersion(null);
      })
      .catch((e) => setErr(e.message));
  };
  useEffect(load, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!id) return;
    setAgentHealth(null);
    setHasHealth(false);
    Promise.all([api.health(id), api.healthList()])
      .then(([detail, list]) => {
        setAgentHealth(detail);
        setHasHealth(Boolean(detail.last) || list.some((h) => h.agentId === id));
      })
      .catch(() => undefined);
  }, [id]);

  const version = useMemo(() => agent?.versions.find((v) => v.version === (viewVersion ?? agent.currentVersion)), [agent, viewVersion]);
  if (err) return <div className="p-8 text-[var(--color-bad)]">{err}</div>;
  if (!agent || !version)
    return (
      <div className="p-8">
        <Spinner />
      </div>
    );
  const spec = version.spec;
  const conversation = spec.meta?.interaction === "conversation" || Boolean((spec.inputSchema as JSONSchema).properties?.messages);

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-[var(--color-line)] px-6 pt-4">
        <div className="flex flex-col items-start gap-4 lg:flex-row">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <h1 className="min-w-0 truncate text-[20px] font-bold tracking-tight" title={agent.name}>
                {agent.name}
              </h1>
              {agent.system && (
                <span className="whitespace-nowrap rounded-full border border-[rgba(249,115,22,0.5)] px-2 py-0.5 text-[10.5px] text-[var(--color-ember)]">meta-agent</span>
              )}
              {conversation && (
                <span className="whitespace-nowrap rounded-full border border-[rgba(167,139,250,0.5)] px-2 py-0.5 text-[10.5px] text-[var(--color-s2)]">Conversation</span>
              )}
              <ScoreBadge score={version.evaluation?.score ?? version.score} passRate={version.evaluation?.passRate} />
              {!agent.system && <QualityBadge quality={qualityOf(version.evaluation)} />}
            </div>
            <p className="mt-1 line-clamp-2 max-w-[820px] text-[13px] text-[var(--color-muted)]">{agent.description}</p>
            {!agent.system && <QualityWarning quality={qualityOf(version.evaluation)} report={version.evaluation} />}
            <div className="mono mt-1.5 flex min-w-0 flex-wrap items-center gap-3 text-[11px] text-[var(--color-faint)]">
              <span className="max-w-full truncate" title={agent.id}>
                {agent.id}
              </span>
              <select
                className="rounded border border-[var(--color-line-2)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[11px] text-[var(--color-muted)]"
                value={version.version}
                onChange={(e) => setViewVersion(Number(e.target.value))}
              >
                {[...agent.versions].reverse().map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                    {v.version === agent.currentVersion ? " (current)" : ""}
                  </option>
                ))}
              </select>
              <span>
                {spec.nodes.length} nodes · {spec.edges.length} edges
              </span>
              {typeof spec.meta?.pattern === "string" && <span>pattern: {spec.meta.pattern.replace(/_/g, " ")}</span>}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2 lg:ml-auto">
            <button
              className="btn"
              onClick={async () => {
                // A download through the API client: a hosted API needs the session token in a header.
                const spec = await api.exportAgent(agent.id, version.version);
                const url = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" }));
                const link = document.createElement("a");
                link.href = url;
                link.download = `${spec.id}.v${spec.version}.anvil.json`;
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              <Download size={14} /> Export
            </button>
            {!agent.system && (
              <button
                className="btn btn-danger"
                onClick={async () => {
                  if (!confirm(`Delete agent "${agent.name}" and all its versions?`)) return;
                  await api.deleteAgent(agent.id);
                  nav("/agents");
                }}
              >
                <Trash2 size={14} />
              </button>
            )}
            {!agent.system && (
              <button className="btn" title="Share this version in the Agent Bazaar" onClick={() => setSharing(true)}>
                <Store size={14} /> Share
              </button>
            )}
            {sharing && <ShareDialog agent={agent} version={version.version} onClose={() => setSharing(false)} />}
            {!agent.system && (
              <Link className="btn" to={`/agents/${agent.id}/workflow`} title="Open the agent in the workflow editor">
                Edit workflow
              </Link>
            )}
            {!agent.system && (
              <button className="btn btn-primary" onClick={() => setTab("run")}>
                {conversation ? <MessageSquare size={14} /> : <Play size={14} />} {conversation ? "Chat" : "Run"}
              </button>
            )}
          </div>
        </div>
        <div className="-mx-4 mt-3">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "graph", label: "Graph" },
              { id: "run", label: conversation ? "Chat" : "Run" },
              { id: "tests", label: `Tests (${spec.tests.length})` },
              ...(hasHealth ? [{ id: "health" as const, label: "Health" }] : []),
              { id: "triggers", label: `Triggers${spec.triggers?.length ? ` (${spec.triggers.length})` : ""}` },
              { id: "versions", label: `Versions (${agent.versions.length})` },
              { id: "sandbox", label: "Sandbox" },
              { id: "edit", label: agent.system ? "Spec" : "Edit & refine" },
              { id: "api", label: "API" },
            ]}
          />
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {tab === "graph" && (
          <div className={`grid h-full grid-cols-1 ${selected ? "grid-rows-[minmax(320px,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_400px] lg:grid-rows-1" : "grid-rows-1"}`}>
            <div className="relative min-h-0">
              <div className="absolute top-3 left-3 z-10">
                {!agent.system && (
                  <Link className="btn" to={`/agents/${agent.id}/workflow`}>
                    Edit workflow
                  </Link>
                )}
              </div>
              <GraphView spec={spec} selected={selected} onSelect={setSelected} compact={agent.system} />
            </div>
            {selected && (
              <div className="min-h-0 border-t border-[var(--color-line)] lg:border-l lg:border-t-0">
                <NodeInspector spec={spec} nodeId={selected} onClose={() => setSelected(null)} />
              </div>
            )}
          </div>
        )}
        {tab === "run" &&
          (conversation ? (
            <ChatPanel key={`${agent.id}-${version.version}`} agentId={agent.id} version={version.version} />
          ) : (
            <RunTab key={`${agent.id}-${version.version}`} agent={agent} spec={spec} />
          ))}
        {tab === "tests" && <TestsTab agent={agent} version={version} />}
        {tab === "health" && hasHealth && agentHealth && <HealthTab key={agent.id} agentId={agent.id} initial={agentHealth} />}
        {tab === "triggers" && <TriggersPanel agentId={agent.id} system={agent.system} />}
        {tab === "versions" && <VersionsTab agent={agent} onChange={load} />}
        {tab === "sandbox" && <AgentSandboxTab agentId={agent.id} readOnly={agent.system} onSaved={load} />}
        {tab === "edit" && <EditTab key={`${agent.id}-${version.version}`} agent={agent} spec={spec} onSaved={load} />}
        {tab === "api" && <ApiTab spec={spec} />}
      </div>
    </div>
  );
}
