import { Clock, KeyRound, Link2, Play, Plus, Rss, Trash2, Webhook, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AgentSummary, type Diagnostic, type TriggerDef, type TriggerView } from "../lib/api";
import { ago } from "../lib/format";
import { CopyButton, Spinner, StatusBadge, Toggle } from "./ui";

export const TRIGGER_ICON = { schedule: Clock, webhook: Webhook, poll: Rss, agent: Link2 } as const;

function until(t?: number) {
  if (!t) return "—";
  const s = Math.round((t - Date.now()) / 1000);
  if (s <= 0) return "due now";
  if (s < 90) return `in ${s}s`;
  if (s < 5400) return `in ${Math.round(s / 60)}m`;
  if (s < 172800) return `in ${Math.round(s / 3600)}h`;
  return new Date(t).toLocaleString();
}

function summary(t: TriggerDef, v: TriggerView) {
  switch (t.type) {
    case "schedule":
      return v.schedule;
    case "webhook":
      return t.respond ? "HTTP POST → responds with the output" : "HTTP POST → accepted, runs in background";
    case "poll":
      return `${t.source.kind.toUpperCase()} ${t.source.url} · every ${t.every}`;
    case "agent":
      return `after ${t.agentId} ${t.on === "any" ? "finishes" : t.on}`;
  }
}

function WebhookInfo({ agentId, id }: { agentId: string; id: string }) {
  const [info, setInfo] = useState<{
    url: string;
    token: string;
    curl: string;
    auth?: "either" | "hmac" | "token";
    signature?: string;
    curlSigned?: string;
  } | null>(null);
  const load = (rotate = false) => api.webhookInfo(agentId, id, rotate).then(setInfo);
  if (!info)
    return (
      <button className="btn !py-1 text-[12px]" onClick={() => load()}>
        <KeyRound size={13} /> Show URL & token
      </button>
    );
  return (
    <div className="w-full space-y-1.5 rounded-md bg-[var(--color-bg)] p-2.5 text-[11.5px]">
      <div className="flex items-center gap-2">
        <span className="label w-12">URL</span>
        <span className="mono min-w-0 flex-1 truncate">{info.url}</span>
        <CopyButton text={info.url} />
      </div>
      <div className="flex items-center gap-2">
        <span className="label w-12">Secret</span>
        <span className="mono min-w-0 flex-1 truncate">{info.token}</span>
        <CopyButton text={info.token} />
        <button className="btn btn-ghost !px-2 !py-0.5 text-[11px]" onClick={() => confirm("Rotate the secret? The old one stops working.") && load(true)}>
          rotate
        </button>
      </div>
      <div className="flex items-center gap-2">
        <span className="label w-12">curl</span>
        <span className="mono min-w-0 flex-1 truncate text-[var(--color-muted)]">{info.curl}</span>
        <CopyButton text={info.curl} />
      </div>
      {info.curlSigned && (
        <div className="flex items-center gap-2">
          <span className="label w-12">signed</span>
          <span className="mono min-w-0 flex-1 truncate text-[var(--color-muted)]">{info.curlSigned}</span>
          <CopyButton text={info.curlSigned} />
        </div>
      )}
      {(info.auth || info.signature) && (
        <div className="truncate text-[var(--color-muted)]">
          {info.auth && <>auth: {info.auth}</>}
          {info.auth && info.signature && " · "}
          {info.signature}
        </div>
      )}
    </div>
  );
}

export function TriggerCard({ v, onChange, showAgent }: { v: TriggerView; onChange: () => void; showAgent?: boolean }) {
  const Icon = TRIGGER_ICON[v.trigger.type];
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(null);
      onChange();
    }
  };
  const s = v.state;
  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <div
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
          style={{ background: v.enabled ? "rgba(249,115,22,0.14)" : "var(--color-panel-2)", color: v.enabled ? "#f97316" : "var(--color-faint)" }}
        >
          <Icon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {showAgent && (
              <Link to={`/agents/${v.agentId}?tab=triggers`} className="text-[13.5px] font-semibold hover:text-[var(--color-ember)]">
                {v.agentName}
              </Link>
            )}
            <span className={`mono ${showAgent ? "text-[11.5px] text-[var(--color-faint)]" : "text-[13px] font-semibold"}`}>{v.trigger.id}</span>
            <span className="rounded bg-[var(--color-panel-2)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-muted)]">{v.trigger.type}</span>
          </div>
          <div className="mt-0.5 truncate text-[12px] text-[var(--color-muted)]">{v.trigger.description || summary(v.trigger, v)}</div>
          {v.trigger.description && <div className="mt-0.5 truncate text-[11.5px] text-[var(--color-faint)]">{summary(v.trigger, v)}</div>}
        </div>
        <Toggle checked={v.enabled} onChange={(on) => act("toggle", () => api.setTriggerEnabled(v.agentId, v.trigger.id, on))} label={v.enabled ? "on" : "off"} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 pl-11 text-[11.5px] text-[var(--color-muted)]">
        {v.trigger.type === "schedule" && v.enabled && <span>next: {until(s.nextAt)}</span>}
        {v.trigger.type === "poll" && s.lastCheckedAt && <span>checked {ago(s.lastCheckedAt)}</span>}
        <span>fired {s.fireCount}×</span>
        {(s.queued ?? 0) > 0 && <span className="text-[var(--color-warn)]">{s.queued} queued</span>}
        {s.skippedOverlap > 0 && <span className="text-[var(--color-warn)]">{s.skippedOverlap} rejected (queue)</span>}
        {s.lastFiredAt && (
          <span className="flex items-center gap-1.5">
            last {ago(s.lastFiredAt)}
            {s.lastStatus && <StatusBadge status={s.lastStatus} />}
            {s.lastRunId && (
              <Link className="text-[var(--color-ember)]" to={`/runs/${s.lastRunId}`}>
                run →
              </Link>
            )}
          </span>
        )}
      </div>
      {s.lastError && <div className="mt-2 pl-11 text-[11.5px] text-[var(--color-bad)]">{s.lastError}</div>}
      <div className="mt-3 flex flex-wrap items-center gap-2 pl-11">
        <button className="btn !py-1 text-[12px]" disabled={!!busy} onClick={() => act("fire", () => api.fireTrigger(v.agentId, v.trigger.id))}>
          {busy === "fire" ? <Spinner /> : <Play size={13} />} Fire now
        </button>
        {!showAgent && (
          <button
            className="btn btn-danger !py-1 text-[12px]"
            disabled={!!busy}
            onClick={() => confirm(`Remove trigger "${v.trigger.id}"? (saved as a new version)`) && act("delete", () => api.deleteTrigger(v.agentId, v.trigger.id))}
          >
            <Trash2 size={13} /> Remove
          </button>
        )}
        {v.trigger.type === "webhook" && <WebhookInfo agentId={v.agentId} id={v.trigger.id} />}
      </div>
    </div>
  );
}

const ROOTS: Record<TriggerDef["type"], string> = {
  schedule: "{{trigger.firedAt}} (no event — use fixed values for required inputs)",
  webhook: "{{payload.*}} {{headers.*}} {{query.*}} {{trigger.*}}",
  poll: "{{item.*}} (rss: id, title, link, published, summary · page: url, title, text) {{trigger.*}}",
  agent: "{{output.*}} {{run.status}} {{trigger.*}}",
};

const PLACEHOLDER: Record<TriggerDef["type"], string> = {
  schedule: '{"message": "Daily check-in"}',
  webhook: '{"message": "{{payload.text}}"}',
  poll: '{"title": "{{item.title}}", "url": "{{item.link}}"}',
  agent: '{"brief": "{{output.brief}}"}',
};

function AddTrigger({ agentId, onSaved, onCancel }: { agentId: string; onSaved: () => void; onCancel: () => void }) {
  const [type, setType] = useState<TriggerDef["type"]>("schedule");
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [cronMode, setCronMode] = useState<"cron" | "every">("cron");
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [every, setEvery] = useState("15m");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [respond, setRespond] = useState(false);
  const [sourceKind, setSourceKind] = useState<"rss" | "json" | "page">("rss");
  const [url, setUrl] = useState("");
  const [itemsPath, setItemsPath] = useState("");
  const [idPath, setIdPath] = useState("id");
  const [otherAgent, setOtherAgent] = useState("");
  const [on, setOn] = useState<"completed" | "failed" | "any">("completed");
  const [input, setInput] = useState("");
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [errors, setErrors] = useState<Diagnostic[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.agents().then((a) => setAgents(a.filter((x) => !x.system && x.id !== agentId)));
  }, [agentId]);

  const save = async () => {
    setErr(null);
    setErrors([]);
    let mapping: unknown;
    if (input.trim()) {
      try {
        mapping = JSON.parse(input);
      } catch {
        setErr("Input mapping is not valid JSON");
        return;
      }
    }
    const base = { id: id || `${type}_1`, description: description || undefined, enabled: true, input: mapping };
    const trigger =
      type === "schedule"
        ? { ...base, type, ...(cronMode === "cron" ? { cron, timezone } : { every }) }
        : type === "webhook"
          ? { ...base, type, respond }
          : type === "poll"
            ? { ...base, type, every, skipExisting: true, maxPerCheck: 5, source: sourceKind === "json" ? { kind: sourceKind, url, itemsPath, idPath } : { kind: sourceKind, url } }
            : { ...base, type, agentId: otherAgent, on };
    setBusy(true);
    try {
      await api.saveTrigger(agentId, trigger);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setErrors(((e as { data?: { diagnostics?: Diagnostic[] } }).data?.diagnostics ?? []) as Diagnostic[]);
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, node: React.ReactNode, hint?: string) => (
    <label className="block">
      <div className="mb-1 text-[12px] text-[var(--color-muted)]">
        {label} {hint && <span className="text-[11px] text-[var(--color-faint)]">{hint}</span>}
      </div>
      {node}
    </label>
  );

  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-semibold">New trigger</div>
        <button className="btn btn-ghost ml-auto !p-1" onClick={onCancel}>
          <X size={14} />
        </button>
      </div>
      <div className="flex gap-1 rounded-lg border border-[var(--color-line)] p-0.5">
        {(["schedule", "webhook", "poll", "agent"] as const).map((t) => {
          const I = TRIGGER_ICON[t];
          return (
            <button
              key={t}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] ${type === t ? "bg-[var(--color-panel-2)] text-[var(--color-fg)]" : "text-[var(--color-muted)]"}`}
              onClick={() => setType(t)}
            >
              <I size={13} /> {t}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-3">
        {field("Id", <input className="input mono" placeholder={`${type}_1`} value={id} onChange={(e) => setId(e.target.value.replace(/[^a-z0-9_]/g, ""))} />, "snake_case")}
        {field("Description", <input className="input" placeholder="optional" value={description} onChange={(e) => setDescription(e.target.value)} />)}
      </div>
      {type === "schedule" && (
        <div className="space-y-3">
          <div className="flex gap-4 text-[12px]">
            {(["cron", "every"] as const).map((m) => (
              <label key={m} className="flex items-center gap-1.5">
                <input type="radio" checked={cronMode === m} onChange={() => setCronMode(m)} className="accent-[var(--color-ember)]" /> {m === "cron" ? "Cron" : "Interval"}
              </label>
            ))}
          </div>
          {cronMode === "cron" ? (
            <div className="grid grid-cols-2 gap-3">
              {field("Cron", <input className="input mono" value={cron} onChange={(e) => setCron(e.target.value)} />, "min hour day month weekday")}
              {field("Timezone", <input className="input mono" value={timezone} onChange={(e) => setTimezone(e.target.value)} />)}
            </div>
          ) : (
            field("Every", <input className="input mono" value={every} onChange={(e) => setEvery(e.target.value)} />, "30s · 15m · 2h · 1d")
          )}
        </div>
      )}
      {type === "webhook" && <Toggle checked={respond} onChange={setRespond} label="Respond with the agent output (synchronous)" />}
      {type === "poll" && (
        <div className="space-y-3">
          <div className="grid grid-cols-[120px_1fr_100px] gap-3">
            {field(
              "Source",
              <select className="input" value={sourceKind} onChange={(e) => setSourceKind(e.target.value as "rss")}>
                <option value="rss">RSS / Atom</option>
                <option value="json">JSON list</option>
                <option value="page">Page changes</option>
              </select>,
            )}
            {field("URL", <input className="input mono" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />)}
            {field("Every", <input className="input mono" value={every} onChange={(e) => setEvery(e.target.value)} />)}
          </div>
          {sourceKind === "json" && (
            <div className="grid grid-cols-2 gap-3">
              {field("Items path", <input className="input mono" placeholder="data.items" value={itemsPath} onChange={(e) => setItemsPath(e.target.value)} />)}
              {field("Id path", <input className="input mono" value={idPath} onChange={(e) => setIdPath(e.target.value)} />)}
            </div>
          )}
        </div>
      )}
      {type === "agent" && (
        <div className="grid grid-cols-2 gap-3">
          {field(
            "After agent",
            <select className="input" value={otherAgent} onChange={(e) => setOtherAgent(e.target.value)}>
              <option value="">choose…</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>,
          )}
          {field(
            "When it",
            <select className="input" value={on} onChange={(e) => setOn(e.target.value as "completed")}>
              <option value="completed">completes</option>
              <option value="failed">fails</option>
              <option value="any">finishes</option>
            </select>,
          )}
        </div>
      )}
      {field(
        "Input mapping (JSON, optional)",
        <textarea className="input mono min-h-[70px] text-[12px]" placeholder={PLACEHOLDER[type]} value={input} onChange={(e) => setInput(e.target.value)} />,
        `available: ${ROOTS[type]}`,
      )}
      {(err || errors.length > 0) && (
        <div className="space-y-1 text-[12px] text-[var(--color-bad)]">
          {err && <div>{err}</div>}
          {errors.map((d, i) => (
            <div key={i}>
              {d.message}
              {d.hint && <span className="text-[var(--color-faint)]"> — {d.hint}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-end">
        <button className="btn btn-primary" disabled={busy} onClick={save}>
          {busy && <Spinner />} Save trigger
        </button>
      </div>
    </div>
  );
}

/** Triggers of one agent (Agent page tab). */
export function TriggersPanel({ agentId, system }: { agentId: string; system?: boolean }) {
  const [items, setItems] = useState<TriggerView[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    api
      .triggers(agentId)
      .then(setItems)
      .catch(() => setItems([]));
  }, [agentId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-[900px] space-y-3">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-[15px] font-semibold">Triggers</div>
            <div className="text-[12px] text-[var(--color-muted)]">
              Let this agent run on its own: on a schedule, on a webhook, when a feed or page gets something new, or after another agent.
            </div>
          </div>
          {!system && !adding && (
            <button className="btn btn-primary ml-auto" onClick={() => setAdding(true)}>
              <Plus size={14} /> Add trigger
            </button>
          )}
        </div>
        {adding && (
          <AddTrigger
            agentId={agentId}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              load();
            }}
          />
        )}
        {items?.map((v) => (
          <TriggerCard key={v.trigger.id} v={v} onChange={load} />
        ))}
        {items && !items.length && !adding && <div className="py-10 text-center text-[12.5px] text-[var(--color-faint)]">No triggers — this agent only runs when called.</div>}
      </div>
    </div>
  );
}
