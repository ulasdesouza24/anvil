import { Box, ChevronDown, ChevronRight, Globe, Package, Plus, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type AgentSandbox, type SandboxStatus } from "../lib/api";
import { duration } from "../lib/format";

/* -------------------------------------------------------------------------- */
/* Timeline rows: one program, one outbound request, one package install      */
/* -------------------------------------------------------------------------- */

export interface CodeArtifact {
  node: string;
  code: string;
  ok: boolean;
  result: string;
  stdout: string;
  error: string | null;
  timedOut: boolean;
  calls: { tool: string; ok: boolean; error?: string; durationMs: number }[];
  egress: EgressArtifact[];
  installs?: { packages: string[]; ok: boolean; error?: string }[];
  durationMs: number;
}

export interface EgressArtifact {
  node?: string;
  tool: string;
  host: string;
  method: string;
  bytes: number;
  decision: "allowed" | "approved" | "blocked" | "rejected";
  reason?: string;
}

export interface PackageArtifact {
  node: string;
  packages: string[];
  ok: boolean;
  error?: string;
  decisions: { project: string; version?: string; decision: string; reason: string }[];
  durationMs: number;
}

const pre = "mono max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-bg)] p-2 text-[11px] leading-relaxed text-[#cfd4dc]";

/** One program of an agent in the timeline: closed it shows the state, open it shows the code, the output, and the calls. */
export function CodeRunCard({ d }: { d: CodeArtifact }) {
  const [open, setOpen] = useState(!d.ok);
  const color = d.ok ? "var(--color-ok)" : "var(--color-bad)";
  const blocked = d.egress.filter((e) => e.decision === "blocked" || e.decision === "rejected").length;
  return (
    <div className="my-1 rounded-lg border border-[var(--color-line)] text-[12px]">
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Box size={12} style={{ color }} />
        <span className="font-medium">{d.node} · Python program</span>
        <span style={{ color }}>{d.ok ? "ok" : d.timedOut ? "time limit" : "failed"}</span>
        <span className="text-[var(--color-faint)]">
          {d.calls.length} tool call(s){blocked ? ` · ${blocked} blocked` : ""}
          {d.installs?.length ? ` · ${d.installs.length} install(s)` : ""}
        </span>
        <span className="mono ml-auto text-[10.5px] text-[var(--color-faint)]">{duration(d.durationMs)}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-[var(--color-line)] p-2.5">
          <div>
            <div className="label mb-1">Code</div>
            <pre className={pre}>{d.code}</pre>
          </div>
          {d.error ? (
            <div>
              <div className="label mb-1 text-[var(--color-bad)]">Error</div>
              <pre className={`${pre} text-[var(--color-bad)]`}>{d.error}</pre>
            </div>
          ) : (
            <div>
              <div className="label mb-1">Result</div>
              <pre className={pre}>{d.result}</pre>
            </div>
          )}
          {d.stdout && (
            <div>
              <div className="label mb-1">Print output</div>
              <pre className={pre}>{d.stdout}</pre>
            </div>
          )}
          {d.calls.length > 0 && (
            <div>
              <div className="label mb-1">Tool calls</div>
              <ul className="space-y-0.5">
                {d.calls.map((c, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mono" style={{ color: c.ok ? "var(--color-ok)" : "var(--color-bad)" }}>
                      {c.ok ? "ok" : "error"}
                    </span>
                    <span className="mono">{c.tool}</span>
                    {c.error && <span className="text-[var(--color-muted)]">{c.error}</span>}
                    <span className="mono ml-auto text-[10.5px] text-[var(--color-faint)]">{duration(c.durationMs)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {d.egress.length > 0 && (
            <div>
              <div className="label mb-1">Outbound requests</div>
              {d.egress.map((e, i) => (
                <EgressRow key={i} e={e} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const DECISION_COLOR: Record<EgressArtifact["decision"], string> = {
  allowed: "var(--color-ok)",
  approved: "var(--color-ok)",
  blocked: "var(--color-bad)",
  rejected: "var(--color-bad)",
};

/** One outbound request of a program and the decision of the egress policy. */
export function EgressRow({ e }: { e: EgressArtifact }) {
  return (
    <div className="flex items-start gap-2 py-[2px] text-[11.5px]">
      <Globe size={11} className="mt-[3px] shrink-0" style={{ color: DECISION_COLOR[e.decision] }} />
      <span className="mono shrink-0">{e.method}</span>
      <span className="mono shrink-0">{e.host || "(none)"}</span>
      <span className="shrink-0" style={{ color: DECISION_COLOR[e.decision] }}>
        {e.decision}
      </span>
      {e.reason && <span className="min-w-0 text-[var(--color-muted)]">{e.reason}</span>}
      {e.bytes > 0 && <span className="mono ml-auto shrink-0 text-[10.5px] text-[var(--color-faint)]">{e.bytes} B</span>}
    </div>
  );
}

/** One package install and the decisions of the package gate. */
export function PackageRow({ d }: { d: PackageArtifact }) {
  const blocked = d.decisions.filter((x) => x.decision === "blocked");
  return (
    <div className="flex items-start gap-2 py-[3px] text-[12px]">
      <Package size={12} className="mt-[2px] shrink-0" style={{ color: d.ok ? "var(--color-ok)" : "var(--color-bad)" }} />
      <div className="min-w-0">
        <span>
          {d.node} · install <span className="mono">{d.packages.join(", ")}</span> {d.ok ? "· ok" : ""}
        </span>
        {d.error && <div className="text-[var(--color-bad)]">{d.error}</div>}
        {d.ok && blocked.length > 0 && <div className="text-[var(--color-faint)]">The gate removed {blocked.length} version(s) with a known vulnerability.</div>}
      </div>
      <span className="mono ml-auto shrink-0 text-[10.5px] text-[var(--color-faint)]">{duration(d.durationMs)}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Connections page: the state of the sandbox                                 */
/* -------------------------------------------------------------------------- */

const NETWORK_TEXT: Record<SandboxStatus["network"], string> = {
  isolated: "Isolated: programs reach the web only through the tool bridge, and packages only through the gate.",
  allowlist: "Allowlist: programs can contact the domains on the allowlist of their run through a proxy. The proxy checks the domain only.",
  open: "Open: programs have full internet access. Use this only for development.",
};

export function SandboxStatusCard() {
  const [st, setSt] = useState<SandboxStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .sandboxStatus()
      .then(setSt)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <div className="card p-4 text-[12.5px] text-[var(--color-bad)]">{error}</div>;
  if (!st) return <div className="card p-4 text-[12.5px] text-[var(--color-faint)]">Checking the sandbox…</div>;
  return (
    <div className="card space-y-3 p-4 text-[12.5px]">
      <div className="flex items-center gap-2">
        {st.available ? <ShieldCheck size={16} className="text-[var(--color-ok)]" /> : <ShieldAlert size={16} className="text-[var(--color-bad)]" />}
        <span className="font-semibold">Python sandbox</span>
        <span style={{ color: st.available ? "var(--color-ok)" : "var(--color-bad)" }}>{st.available ? "ready" : "not available"}</span>
        <span className="mono ml-auto text-[11px] text-[var(--color-faint)]">{st.image}</span>
      </div>
      {!st.available && <div className="text-[var(--color-bad)]">{st.reason}</div>}
      <div
        className="rounded-md border px-2.5 py-1.5"
        style={{
          borderColor: st.network === "open" ? "rgba(248,113,113,0.5)" : "var(--color-line)",
          color: st.network === "open" ? "var(--color-bad)" : "var(--color-muted)",
        }}
      >
        {NETWORK_TEXT[st.network]}
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-4">
        <Field k="Ready containers" v={String(st.pool)} />
        <Field k="Time for each program" v={`${Math.round(st.timeoutMs / 1000)} s`} />
        <Field k="Time for each run" v={`${st.maxSecondsPerRun} s`} />
        <Field k="Memory / CPU" v={`${st.memory} / ${st.cpus}`} />
        <Field k="Package index" v={st.gate.index} />
        <Field k="Vulnerability check" v={st.gate.vulnCheck === "osv" ? "OSV (fail-closed)" : "off"} />
        <Field k="Allow list" v={st.gate.allow.join(", ") || "(all projects)"} />
        <Field k="Deny list" v={st.gate.deny.join(", ") || "(none)"} />
      </div>
      {st.decisions.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[11.5px] text-[var(--color-faint)]">Recent decisions of the package gate ({st.decisions.length})</summary>
          <ul className="mt-1 space-y-0.5 text-[11.5px]">
            {st.decisions.map((d, i) => (
              <li key={i} className="flex gap-2">
                <span style={{ color: d.decision === "allowed" ? "var(--color-ok)" : "var(--color-bad)" }}>{d.decision}</span>
                <span className="mono">
                  {d.project} {d.version ?? ""}
                </span>
                <span className="text-[var(--color-muted)]">{d.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <div className="label">{k}</div>
      <div className="mono truncate text-[11.5px]" title={v}>
        {v}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Agent page: the allowlist of the programs of an agent                      */
/* -------------------------------------------------------------------------- */

export function AgentSandboxTab({ agentId, readOnly, onSaved }: { agentId: string; readOnly?: boolean; onSaved?: () => void }) {
  const [data, setData] = useState<AgentSandbox | null>(null);
  const [approved, setApproved] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(() => {
    api.agentSandbox(agentId).then((d) => {
      setData(d);
      setApproved(d.allowlist.approved);
    });
  }, [agentId]);
  useEffect(load, [load]);
  if (!data) return <div className="p-6 text-[12.5px] text-[var(--color-faint)]">Loading…</div>;
  const changed = JSON.stringify([...approved].sort()) !== JSON.stringify(data.allowlist.approved);
  const add = () => {
    const d = draft
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/^www\./, "");
    if (d && !approved.includes(d)) setApproved([...approved, d]);
    setDraft("");
  };
  return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-[860px] space-y-5 text-[12.5px]">
        <div>
          <div className="text-[15px] font-semibold">Python sandbox</div>
          <p className="mt-1 text-[var(--color-muted)]">
            The programs of this agent (run_code and code_agent) can contact only the domains below. A request that sends data (POST, PUT, PATCH, DELETE) always needs your approval, and test runs never send
            data out. Network mode: <span className="mono">{data.network}</span>.
          </p>
        </div>
        <Group title="From the source plan" hint="The builder tested these sources." items={data.allowlist.plan} />
        <Group title="From the request" hint="The request names these URLs." items={data.allowlist.request} />
        <div>
          <div className="label mb-1">Approved by a person</div>
          <div className="flex flex-wrap gap-1.5">
            {approved.map((d) => (
              <span key={d} className="mono flex items-center gap-1 rounded-md border border-[var(--color-line-2)] px-2 py-0.5 text-[11.5px]">
                {d}
                {!readOnly && (
                  <button aria-label={`Remove ${d}`} onClick={() => setApproved(approved.filter((x) => x !== d))}>
                    <X size={11} />
                  </button>
                )}
              </span>
            ))}
            {!approved.length && <span className="text-[var(--color-faint)]">(none)</span>}
          </div>
          {!readOnly && (
            <div className="mt-2 flex gap-2">
              <input
                className="input mono max-w-[320px] text-[12px]"
                placeholder="api.example.com"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && add()}
              />
              <button className="btn" onClick={add}>
                <Plus size={13} /> Add
              </button>
              <button
                className="btn btn-primary"
                disabled={!changed || saving}
                onClick={async () => {
                  setSaving(true);
                  try {
                    await api.saveAgentSandbox(agentId, approved);
                    setMessage("Saved as a new version of the agent.");
                    load();
                    onSaved?.();
                  } catch (e) {
                    setMessage((e as Error).message);
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                Save
              </button>
            </div>
          )}
          {message && <div className="mt-1.5 text-[11.5px] text-[var(--color-muted)]">{message}</div>}
        </div>
        <p className="text-[11.5px] text-[var(--color-faint)]">
          During a run, the domains of the search results of that run are also allowed: a page that the agent found is not a place to which it sends data.
          {data.maxSeconds ? ` Sandbox time for each run: ${data.maxSeconds} s.` : ""}
        </p>
      </div>
    </div>
  );
}

function Group({ title, hint, items }: { title: string; hint: string; items: string[] }) {
  return (
    <div>
      <div className="label">{title}</div>
      <div className="mb-1 text-[11px] text-[var(--color-faint)]">{hint}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((d) => (
          <span key={d} className="mono rounded-md bg-[var(--color-panel-2)] px-2 py-0.5 text-[11.5px]">
            {d}
          </span>
        ))}
        {!items.length && <span className="text-[var(--color-faint)]">(none)</span>}
      </div>
    </div>
  );
}
