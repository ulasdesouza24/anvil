import type { AgentSpec, Diagnostic, Trigger } from "@core/types";
import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { autocompletion } from "@codemirror/autocomplete";
import { api, type TestWebhookEvent, type TriggerView } from "../lib/api";
import { JsonBlock, Toggle } from "../components/ui";
import { nextSchedule } from "./schedule";
export function newTrigger(spec: AgentSpec, type: Trigger["type"]): Trigger {
  let i = 1;
  while (spec.triggers?.some((t) => t.id === `${type}_${i}`)) i++;
  const base = { id: `${type}_${i}`, enabled: false };
  switch (type) {
    case "schedule":
      return { ...base, type, cron: "0 9 * * 1-5", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    case "webhook":
      return { ...base, type, respond: false };
    case "poll":
      return { ...base, type, source: { kind: "rss", url: "" }, every: "15m", skipExisting: true, maxPerCheck: 5 };
    case "agent":
      return { ...base, type, agentId: "", on: "completed" };
  }
}
const roots = {
  schedule: ["trigger", "trigger.firedAt"],
  webhook: ["payload", "headers", "query", "trigger", "trigger.firedAt"],
  poll: ["item", "item.id", "item.title", "item.link", "trigger", "trigger.firedAt"],
  agent: ["output", "run", "run.status", "trigger", "trigger.firedAt"],
};
function Mapping({ trigger, onChange }: { trigger: Trigger; onChange: (t: Trigger) => void }) {
  const [text, setText] = useState(JSON.stringify(trigger.input ?? {}, null, 2));
  const [error, setError] = useState("");
  const extensions = useMemo(
    () => [
      json(),
      autocompletion({
        override: [
          (c) => {
            const before = c.state.doc.sliceString(0, c.pos);
            if (before.lastIndexOf("{{") <= before.lastIndexOf("}}")) return null;
            const word = c.matchBefore(/[\w.]*/);
            return { from: word?.from ?? c.pos, options: roots[trigger.type].map((label) => ({ label, type: "variable" })) };
          },
        ],
      }),
    ],
    [trigger.type],
  );
  return (
    <>
      <CodeMirror
        theme="dark"
        value={text}
        extensions={extensions}
        minHeight="110px"
        onChange={(v) => {
          setText(v);
          try {
            onChange({ ...trigger, input: JSON.parse(v) });
            setError("");
          } catch {
            setError("Enter valid JSON");
          }
        }}
      />
      <p className="wf-hint">Use {roots[trigger.type].join(", ")} in expressions.</p>
      {error && <p className="wf-error">{error}</p>}
    </>
  );
}
function WebhookCapture({ agentId, id, onInput, onPin }: { agentId: string; id: string; onInput: (v: unknown) => void; onPin: (v: unknown) => void }) {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.webhookInfo>>>();
  const [event, setEvent] = useState<TestWebhookEvent>();
  const [error, setError] = useState("");
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(Date.now());
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    let active = true;
    api
      .webhookInfo(agentId, id)
      .then((v) => active && setInfo(v))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
      controller.current?.abort();
    };
  }, [agentId, id]);
  useEffect(() => {
    if (!deadline) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [deadline]);
  const listen = async () => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setDeadline(Date.now() + 120000);
    setNow(Date.now());
    setError("");
    try {
      const result = await api.listenWebhook(agentId, id, 120000, c.signal);
      if (!c.signal.aborted) {
        if (result.event) setEvent(result.event);
        else setError("No test event arrived.");
      }
    } catch (e) {
      if (!c.signal.aborted) setError((e as Error).message);
    } finally {
      if (controller.current === c) setDeadline(0);
    }
  };
  return (
    <div className="wf-subform">
      {info && (
        <>
          <h4>Webhook URL</h4>
          <code className="break-all">{info.url}</code>
          <h4>curl</h4>
          <pre className="whitespace-pre-wrap break-all">{info.curl}</pre>
        </>
      )}
      {deadline ? (
        <div className="wf-row">
          <span>Listening · {Math.max(0, Math.ceil((deadline - now) / 1000))}s</span>
          <button
            className="btn"
            onClick={() => {
              controller.current?.abort();
              setDeadline(0);
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button className="btn" onClick={() => void listen()}>
          Listen for test event
        </button>
      )}
      {error && <p className="wf-error">{error}</p>}
      {event && (
        <>
          {(["payload", "headers", "query", "input"] as const).map((k) => (
            <div key={k}>
              <h4>{k === "input" ? "Mapped input" : k}</h4>
              <JsonBlock value={event[k]} />
            </div>
          ))}
          <div className="wf-row">
            <button className="btn" onClick={() => onInput(event.input)}>
              Use as test input
            </button>
            <button className="btn" onClick={() => onPin(event.input)}>
              Pin as input
            </button>
          </div>
        </>
      )}
    </div>
  );
}
export function TriggerPanel({
  trigger: t,
  agentId,
  saved,
  agents,
  diagnostics,
  onChange,
  onDelete,
  onClose,
  onInput,
  onPin,
  readOnly,
  runtime,
  onRuntime,
}: {
  trigger: Trigger;
  agentId: string;
  saved: boolean;
  agents: { id: string; name: string }[];
  diagnostics: Diagnostic[];
  onChange: (t: Trigger) => void;
  onDelete: () => void;
  onClose: () => void;
  onInput: (v: unknown) => void;
  onPin: (v: unknown) => void;
  readOnly: boolean;
  runtime?: TriggerView;
  onRuntime: () => void;
}) {
  const [error, setError] = useState("");
  const times = useMemo(() => {
    if (t.type !== "schedule") return { values: [] };
    try {
      return { values: nextSchedule(t) };
    } catch (e) {
      return { values: [], error: (e as Error).message };
    }
  }, [t]);
  const text = (label: string, value: string | undefined, change: (s: string) => void, hint?: string) => (
    <label className="wf-field">
      {label}
      <input className="input" value={value ?? ""} placeholder={hint} onChange={(e) => change(e.target.value)} />
    </label>
  );
  return (
    <aside className="wf-settings">
      <div className="wf-row">
        <h3>{t.id}</h3>
        <button className="btn ml-auto" onClick={onClose}>
          Close
        </button>
      </div>
      <fieldset disabled={readOnly} inert={readOnly}>
        {text("Description", t.description, (description) => onChange({ ...t, description }))}
        <Toggle label="Enabled by default" checked={t.enabled} onChange={(enabled) => onChange({ ...t, enabled })} />
        {t.type === "schedule" && (
          <>
            <div className="wf-row">
              {["cron", "every"].map((mode) => (
                <label key={mode}>
                  <input
                    type="radio"
                    checked={mode === "cron" ? t.every === undefined : t.every !== undefined}
                    onChange={() => onChange({ ...t, cron: mode === "cron" ? "0 9 * * 1-5" : undefined, every: mode === "every" ? "15m" : undefined })}
                  />
                  {mode === "cron" ? "Cron" : "Every"}
                </label>
              ))}
            </div>
            {t.every !== undefined ? (
              text("Every", t.every, (every) => onChange({ ...t, every }), "15m")
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  {["Minute", "Hour", "Day of month", "Month", "Weekday"].map((label, i) => {
                    const parts = (t.cron ?? "* * * * *").split(/\s+/);
                    const min = i === 2 || i === 3 ? 1 : 0;
                    const max = [59, 23, 31, 12, 6][i];
                    return (
                      <label key={label}>
                        {label}
                        <select
                          className="input"
                          value={parts[i] ?? "*"}
                          onChange={(e) => {
                            parts[i] = e.target.value;
                            onChange({ ...t, cron: parts.join(" ") });
                          }}
                        >
                          <option value="*">Every</option>
                          {Array.from({ length: max - min + 1 }, (_, j) => String(j + min)).map((n) => (
                            <option key={n}>{n}</option>
                          ))}
                          {parts[i] !== "*" && !/^\d+$/.test(parts[i]) && <option>{parts[i]}</option>}
                        </select>
                      </label>
                    );
                  })}
                </div>
                {text("Cron", t.cron, (cron) => onChange({ ...t, cron }))}
              </>
            )}
            {text("Timezone", t.timezone, (timezone) => onChange({ ...t, timezone: timezone || undefined }), Intl.DateTimeFormat().resolvedOptions().timeZone)}
            <h4>Next 5 run times (preview)</h4>
            {times.error && <p className="wf-error">{times.error}</p>}
            {times.values.map((v) => (
              <div key={v}>{new Date(v).toLocaleString(undefined, { timeZone: t.timezone || undefined })}</div>
            ))}
            {t.every && <p className="wf-hint">Intervals start from now. The saved trigger keeps its own schedule.</p>}
          </>
        )}
        {t.type === "webhook" && <Toggle label="Respond with output" checked={t.respond} onChange={(respond) => onChange({ ...t, respond })} />}
        {t.type === "poll" && (
          <>
            <label className="wf-field">
              Kind
              <select
                className="input"
                value={t.source.kind}
                onChange={(e) => {
                  const kind = e.target.value as "rss" | "json" | "page";
                  onChange({ ...t, source: kind === "json" ? { kind, url: t.source.url, itemsPath: "", idPath: "id" } : { kind, url: t.source.url } });
                }}
              >
                {["rss", "json", "page"].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            {text("URL", t.source.url, (url) => onChange({ ...t, source: { ...t.source, url } }))}
            {t.source.kind === "json" && (
              <>
                {text("Items path", t.source.itemsPath, (itemsPath) => {
                  if (t.source.kind === "json") onChange({ ...t, source: { ...t.source, itemsPath } });
                })}
                {text("ID path", t.source.idPath, (idPath) => {
                  if (t.source.kind === "json") onChange({ ...t, source: { ...t.source, idPath } });
                })}
              </>
            )}
            {text("Every", t.every, (every) => onChange({ ...t, every }))}
            <Toggle label="Skip existing items" checked={t.skipExisting} onChange={(skipExisting) => onChange({ ...t, skipExisting })} />
            <label className="wf-field">
              Max per check
              <input className="input" type="number" min={1} max={50} value={t.maxPerCheck} onChange={(e) => onChange({ ...t, maxPerCheck: Number(e.target.value) })} />
            </label>
          </>
        )}
        {t.type === "agent" && (
          <>
            <label className="wf-field">
              Agent
              <select className="input" value={t.agentId} onChange={(e) => onChange({ ...t, agentId: e.target.value })}>
                <option value="">Choose agent</option>
                {agents
                  .filter((a) => a.id !== agentId)
                  .map((a) => (
                    <option value={a.id} key={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="wf-field">
              On
              <select className="input" value={t.on} onChange={(e) => onChange({ ...t, on: e.target.value as "completed" })}>
                {["completed", "failed", "any"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <h3>Input mapping (JSON)</h3>
        <Mapping trigger={t} onChange={onChange} />
        {diagnostics.map((d, i) => (
          <p className="wf-error" key={i}>
            {d.message}
          </p>
        ))}
        <button className="btn my-3" onClick={onDelete}>
          Delete trigger
        </button>
      </fieldset>
      {saved && runtime && (
        <>
          <Toggle
            label="Saved trigger is on"
            checked={runtime.enabled}
            onChange={async (enabled) => {
              if (readOnly) return;
              try {
                await api.setTriggerEnabled(agentId, t.id, enabled);
                onRuntime();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          />
          <p className="wf-hint">This switch changes the saved agent at once. It is separate from the draft default.</p>
        </>
      )}
      {error && <p className="wf-error">{error}</p>}
      {t.type === "webhook" &&
        (saved ? !readOnly && <WebhookCapture agentId={agentId} id={t.id} onInput={onInput} onPin={onPin} /> : <p className="wf-hint">Save the workflow to get the webhook URL</p>)}
    </aside>
  );
}
