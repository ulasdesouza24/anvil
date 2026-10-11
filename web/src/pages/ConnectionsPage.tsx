import { SandboxStatusCard } from "../components/SandboxViews";
import { Cable, Check, Lock, Plug, Plus, RefreshCw, Save, ShieldCheck, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { CopyButton, Spinner } from "../components/ui";
import { api, type McpServerStatus, type SecretState } from "../lib/api";
import { ago } from "../lib/format";

function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function AddServer({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [transport, setTransport] = useState<"stdio" | "http">("http");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("npx");
  const [args, setArgs] = useState("");
  const [pairs, setPairs] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const server =
        transport === "http"
          ? { name, transport, url, headers: parsePairs(pairs) }
          : { name, transport, command, args: args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((a) => a.replace(/^"|"$/g, "")) ?? [], env: parsePairs(pairs) };
      const r = await api.addMcpServer(server);
      setResult(`${r.sync.added.length} tools added to the library${r.sync.failed.length ? `, ${r.sync.failed.length} failed` : ""}`);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-semibold">Connect an MCP server</div>
        <button className="btn btn-ghost ml-auto !p-1" onClick={onCancel}>
          <X size={14} />
        </button>
      </div>
      <div className="flex gap-1 rounded-lg border border-[var(--color-line)] p-0.5">
        {(["http", "stdio"] as const).map((t) => (
          <button
            key={t}
            className={`flex-1 rounded-md py-1.5 text-[12px] ${transport === t ? "bg-[var(--color-panel-2)] text-[var(--color-fg)]" : "text-[var(--color-muted)]"}`}
            onClick={() => setTransport(t)}
          >
            {t === "http" ? "Remote (Streamable HTTP)" : "Local process (stdio)"}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[200px_minmax(0,1fr)]">
        <label>
          <div className="mb-1 text-[12px] text-[var(--color-muted)]">Name</div>
          <input className="input mono" placeholder="github" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} />
        </label>
        {transport === "http" ? (
          <label>
            <div className="mb-1 text-[12px] text-[var(--color-muted)]">URL</div>
            <input className="input mono" placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
          </label>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[120px_minmax(0,1fr)]">
            <label>
              <div className="mb-1 text-[12px] text-[var(--color-muted)]">Command</div>
              <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} />
            </label>
            <label>
              <div className="mb-1 text-[12px] text-[var(--color-muted)]">Arguments</div>
              <input className="input mono" placeholder="-y @modelcontextprotocol/server-filesystem /tmp" value={args} onChange={(e) => setArgs(e.target.value)} />
            </label>
          </div>
        )}
      </div>
      <label className="block">
        <div className="mb-1 text-[12px] text-[var(--color-muted)]">
          {transport === "http" ? "Headers" : "Environment"}{" "}
          <span className="text-[11px] text-[var(--color-faint)]">
            KEY=value per line · reference secrets as ${"{"}ENV_VAR{"}"} so they stay in .env
          </span>
        </div>
        <textarea
          className="input mono min-h-[60px] text-[12px]"
          placeholder={transport === "http" ? "Authorization=Bearer ${GITHUB_TOKEN}" : "API_KEY=${MY_API_KEY}"}
          value={pairs}
          onChange={(e) => setPairs(e.target.value)}
        />
      </label>
      {err && <div className="text-[12px] text-[var(--color-bad)]">{err}</div>}
      {result && <div className="text-[12px] text-[var(--color-ok)]">{result}</div>}
      <div className="flex justify-end">
        <button className="btn btn-primary" disabled={busy || !name || (transport === "http" ? !url : !command)} onClick={save}>
          {busy ? <Spinner /> : <Plug size={14} />} Connect & import tools
        </button>
      </div>
    </div>
  );
}

function ServerCard({ s, onChange }: { s: McpServerStatus; onChange: () => void }) {
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
  const pending = s.tools.filter((t) => !t.readOnly && !t.approved).length;
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg"
          style={{ background: s.connected ? "rgba(52,211,153,0.12)" : "var(--color-panel-2)", color: s.connected ? "#34d399" : "var(--color-faint)" }}
        >
          <Cable size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono text-[13.5px] font-semibold">{s.config.name}</span>
            <span className="rounded bg-[var(--color-panel-2)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-muted)]">{s.config.transport}</span>
            <span className="text-[11px]" style={{ color: s.connected ? "#34d399" : "var(--color-faint)" }}>
              {s.connected ? `connected${s.serverInfo?.name ? ` · ${s.serverInfo.name} ${s.serverInfo.version ?? ""}` : ""}` : "not connected"}
            </span>
          </div>
          <div
            className="mono mt-0.5 truncate text-[11.5px] text-[var(--color-faint)]"
            title={s.config.transport === "http" ? s.config.url : `${s.config.command} ${s.config.args.join(" ")}`}
          >
            {s.config.transport === "http" ? s.config.url : `${s.config.command} ${s.config.args.join(" ")}`}
          </div>
          {s.error && <div className="mt-1 break-words text-[11.5px] text-[var(--color-bad)]">{s.error}</div>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:ml-11 lg:ml-0">
          <button className="btn !py-1 text-[12px]" disabled={!!busy} onClick={() => act("refresh", () => api.refreshMcpServer(s.config.name))}>
            {busy === "refresh" ? <Spinner /> : <RefreshCw size={13} />} Refresh tools
          </button>
          {pending > 0 && (
            <button
              className="btn !py-1 text-[12px]"
              disabled={!!busy}
              onClick={() =>
                confirm(`Allow agents to use ${pending} tool(s) of "${s.config.name}" that may change data?`) && act("approve", () => api.approveMcpServer(s.config.name))
              }
            >
              <ShieldCheck size={13} /> Approve {pending}
            </button>
          )}
          <button
            className="btn btn-danger !py-1 text-[12px]"
            disabled={!!busy}
            onClick={() =>
              confirm(`Disconnect "${s.config.name}" and remove its tools from the library?`) &&
              act("remove", () =>
                api.removeMcpServer(s.config.name).catch((e) => (confirm(`${(e as Error).message}\n\nRemove anyway?`) ? api.removeMcpServer(s.config.name, true) : undefined)),
              )
            }
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {s.tools.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5 pl-11">
          {s.tools.map((t) => (
            <span
              key={t.type}
              title={`${t.type}\n${t.description ?? ""}`}
              className="mono inline-flex max-w-full items-center gap-1 truncate whitespace-nowrap rounded border px-1.5 py-0.5 text-[10.5px]"
              style={{ borderColor: "var(--color-line-2)", color: t.readOnly || t.approved ? "var(--color-muted)" : "#fda4af" }}
            >
              {t.readOnly ? <Check size={10} /> : t.approved ? <ShieldCheck size={10} /> : <Lock size={10} />} {t.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

type HeaderRow = { name: string; template: string };

function SecretsSection() {
  const [state, setState] = useState<SecretState | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [host, setHost] = useState("");
  const [headers, setHeaders] = useState<HeaderRow[]>([{ name: "Authorization", template: "" }]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .secrets()
      .then(setState)
      .catch((e) => setErr((e as Error).message));
  }, []);

  const act = async (key: string, fn: () => Promise<SecretState>) => {
    setBusy(key);
    setErr(null);
    try {
      setState(await fn());
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveSecret = async () => {
    if (await act("secret", () => api.setSecret(name, value))) {
      setName("");
      setValue("");
    }
  };

  const saveHost = async () => {
    const pairs = Object.fromEntries(headers.filter((row) => row.name.trim() && row.template).map((row) => [row.name.trim(), row.template]));
    if (await act("host", () => api.setHostHeaders(host, pairs))) {
      setHost("");
      setHeaders([{ name: "Authorization", template: "" }]);
    }
  };

  const disabled = !state?.enabled;
  const hostEntries = Object.entries(state?.hostHeaders ?? {});

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="shrink-0 text-[14px] font-semibold">Secrets</h2>
        <span className="text-[12px] text-[var(--color-muted)]">credentials and request headers used by classes and live data sources</span>
      </div>
      <div className="card overflow-hidden">
        {!state ? (
          <div className="flex items-center gap-2 p-5 text-[12px] text-[var(--color-muted)]">
            <Spinner /> Loading secrets…
          </div>
        ) : (
          <>
            {!state.enabled && (
              <div className="border-b border-[var(--color-line)] bg-[rgba(251,191,36,0.06)] px-4 py-3 text-[12px] text-[var(--color-warn)]">
                Set ANVIL_SECRETS_KEY in .env to store secrets (openssl rand -hex 32)
              </div>
            )}

            {state.needed.length > 0 && (
              <div className="border-b border-[var(--color-line)] p-4">
                <div className="label mb-2">Needed</div>
                <div className="flex flex-wrap gap-2">
                  {state.needed.map((item) => (
                    <div key={item.name} className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-[var(--color-line)] px-2.5 py-1.5 text-[11.5px]">
                      <span className="mono min-w-0 truncate font-medium" title={item.name}>
                        {item.name}
                      </span>
                      <span className="min-w-0 truncate text-[var(--color-faint)]" title={item.usedBy.join(", ")}>
                        {item.usedBy.join(", ")}
                      </span>
                      <button className="text-[var(--color-ember)] disabled:opacity-45" disabled={disabled} onClick={() => setName(item.name)}>
                        fill
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-5 p-4 lg:grid-cols-[minmax(0,1fr)_380px]">
              <div>
                <div className="label mb-2">Stored secrets</div>
                {state.secrets.length ? (
                  <div className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)]">
                    {state.secrets.map((secret) => (
                      <div key={secret.name} className="flex items-center gap-2 px-3 py-2.5 text-[12px]">
                        <span className="mono min-w-0 flex-1 truncate font-medium">{secret.name}</span>
                        <span
                          className="whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px]"
                          style={{
                            color: secret.source === "ui" ? "var(--color-ember)" : "var(--color-muted)",
                            borderColor: secret.source === "ui" ? "rgba(249,115,22,0.5)" : "var(--color-line-2)",
                          }}
                        >
                          {secret.source}
                        </span>
                        <span className="mono min-w-0 truncate text-[11px] text-[var(--color-muted)]" title={secret.hint}>
                          {secret.hint}
                        </span>
                        <span
                          className="w-20 text-right text-[11px] text-[var(--color-faint)]"
                          title={secret.updatedAt ? new Date(secret.updatedAt).toLocaleString() : "Set in .env"}
                        >
                          {secret.updatedAt ? ago(secret.updatedAt) : "set in .env"}
                        </span>
                        {secret.source === "ui" ? (
                          <button
                            className="btn btn-danger !p-1.5"
                            disabled={!!busy || disabled}
                            title={`Delete ${secret.name}`}
                            onClick={() => act(`delete-${secret.name}`, () => api.deleteSecret(secret.name))}
                          >
                            {busy === `delete-${secret.name}` ? <Spinner /> : <Trash2 size={12} />}
                          </button>
                        ) : (
                          <span className="w-[29px]" />
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-[var(--color-line)] p-4 text-center text-[12px] text-[var(--color-faint)]">No secrets found.</div>
                )}
              </div>

              <div>
                <div className="label mb-2">Add or replace</div>
                <div className="space-y-3">
                  <label className="block">
                    <div className="mb-1 text-[12px] text-[var(--color-muted)]">Name</div>
                    <input
                      className="input mono"
                      placeholder="GITHUB_TOKEN"
                      value={name}
                      disabled={disabled}
                      onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
                    />
                  </label>
                  <label className="block">
                    <div className="mb-1 text-[12px] text-[var(--color-muted)]">Value</div>
                    <input className="input" type="password" autoComplete="new-password" value={value} disabled={disabled} onChange={(e) => setValue(e.target.value)} />
                  </label>
                  <div className="flex justify-end">
                    <button className="btn btn-primary" disabled={disabled || !!busy || !/^[A-Z][A-Z0-9_]{1,63}$/.test(name) || !value} onClick={saveSecret}>
                      {busy === "secret" ? <Spinner /> : <Lock size={13} />} Save
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t border-[var(--color-line)] p-4">
              <div className="mb-3">
                <div className="text-[13px] font-semibold">Host headers</div>
                <div className="text-[11.5px] text-[var(--color-muted)]">
                  Templates reference a stored secret with ${"{"}NAME{"}"}.
                </div>
              </div>
              {hostEntries.length > 0 && (
                <div className="mb-4 overflow-x-auto rounded-lg border border-[var(--color-line)]">
                  <table className="min-w-max w-full text-left text-[12px]">
                    <thead className="label border-b border-[var(--color-line)]">
                      <tr>
                        <th className="px-3 py-2 font-semibold">Host</th>
                        <th className="px-3 py-2 font-semibold">Header</th>
                        <th className="px-3 py-2 font-semibold">Template</th>
                        <th className="w-12 px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--color-line)]">
                      {hostEntries.map(([hostName, hostHeaders]) =>
                        Object.entries(hostHeaders).map(([headerName, template], index) => (
                          <tr key={`${hostName}-${headerName}`}>
                            <td className="mono px-3 py-2 text-[11.5px]">{index === 0 ? hostName : ""}</td>
                            <td className="mono px-3 py-2 text-[11.5px] text-[var(--color-muted)]">{headerName}</td>
                            <td className="mono px-3 py-2 text-[11.5px] text-[var(--color-muted)]">{template}</td>
                            <td className="px-3 py-2">
                              {index === 0 && (
                                <button
                                  className="btn btn-danger !p-1.5"
                                  disabled={disabled || !!busy}
                                  title={`Remove ${hostName}`}
                                  onClick={() => act(`host-${hostName}`, () => api.setHostHeaders(hostName, {}))}
                                >
                                  {busy === `host-${hostName}` ? <Spinner /> : <Trash2 size={12} />}
                                </button>
                              )}
                            </td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
              )}
              {state.envHostHeaders.length > 0 && <div className="mb-4 text-[11.5px] text-[var(--color-faint)]">Set in .env: {state.envHostHeaders.join(", ")}</div>}

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-[240px_minmax(0,1fr)_auto]">
                <label>
                  <div className="mb-1 text-[12px] text-[var(--color-muted)]">Host</div>
                  <input className="input mono" placeholder="api.github.com" value={host} disabled={disabled} onChange={(e) => setHost(e.target.value)} />
                </label>
                <div>
                  <div className="mb-1 text-[12px] text-[var(--color-muted)]">Headers</div>
                  <div className="space-y-2">
                    {headers.map((row, index) => (
                      <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(120px,0.4fr)_minmax(0,1fr)_auto]">
                        <input
                          className="input mono"
                          placeholder="Authorization"
                          value={row.name}
                          disabled={disabled}
                          onChange={(e) => setHeaders((current) => current.map((item, i) => (i === index ? { ...item, name: e.target.value } : item)))}
                        />
                        <input
                          className="input mono"
                          placeholder={`Bearer ${"${GITHUB_TOKEN}"}`}
                          value={row.template}
                          disabled={disabled}
                          onChange={(e) => setHeaders((current) => current.map((item, i) => (i === index ? { ...item, template: e.target.value } : item)))}
                        />
                        <button
                          className="btn btn-ghost !p-2"
                          disabled={disabled || headers.length === 1}
                          onClick={() => setHeaders((current) => current.filter((_, i) => i !== index))}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                    <button
                      className="btn btn-ghost !px-2 !py-1 text-[11.5px]"
                      disabled={disabled}
                      onClick={() => setHeaders((current) => [...current, { name: "", template: "" }])}
                    >
                      <Plus size={12} /> Add header
                    </button>
                  </div>
                </div>
                <div className="self-end">
                  <button className="btn btn-primary" disabled={disabled || !!busy || !host.trim() || !headers.some((row) => row.name.trim() && row.template)} onClick={saveHost}>
                    {busy === "host" ? <Spinner /> : <Save size={13} />} Save host
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
        {err && <div className="border-t border-[var(--color-line)] px-4 py-3 text-[12px] text-[var(--color-bad)]">{err}</div>}
      </div>
    </section>
  );
}

function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center border-b border-[var(--color-line)] px-3 py-1.5">
        <span className="label">{label}</span>
        <span className="ml-auto">
          <CopyButton text={code} label="Copy" />
        </span>
      </div>
      <pre className="mono overflow-auto p-3 text-[11.5px] leading-relaxed text-[#cfd4dc]">{code}</pre>
    </div>
  );
}

export function ConnectionsPage() {
  const [servers, setServers] = useState<McpServerStatus[] | null>(null);
  const [expose, setExpose] = useState<Awaited<ReturnType<typeof api.mcpExpose>> | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    api
      .mcpServers()
      .then(setServers)
      .catch(() => setServers([]));
    api
      .mcpExpose()
      .then(setExpose)
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] px-4 py-6 sm:px-8 sm:py-8">
        <h1 className="text-[22px] font-bold tracking-tight">Connections</h1>
        <p className="max-w-[780px] text-[13px] text-[var(--color-muted)]">
          Anvil speaks the Model Context Protocol in both directions: plug any MCP server in and its tools become node classes the builder can use — and plug Anvil into Claude,
          Cursor or any MCP client so they can run and even <em>build</em> agents.
        </p>

        <section className="mt-8">
          <h2 className="mb-3 text-[14px] font-semibold">Python sandbox</h2>
          <SandboxStatusCard />
        </section>

        <SecretsSection />

        <section className="mt-8">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="shrink-0 whitespace-nowrap text-[14px] font-semibold">MCP servers → Anvil</h2>
            <span className="text-[12px] text-[var(--color-muted)]">
              tools become classes named x_mcp_&lt;server&gt;_&lt;tool&gt;; tools that may change data stay locked until you approve them
            </span>
            {!adding && (
              <button className="btn btn-primary ml-auto" onClick={() => setAdding(true)}>
                <Plus size={14} /> Connect server
              </button>
            )}
          </div>
          <div className="space-y-3">
            {adding && (
              <AddServer
                onCancel={() => setAdding(false)}
                onDone={() => {
                  load();
                }}
              />
            )}
            {servers?.map((s) => (
              <ServerCard key={s.config.name} s={s} onChange={load} />
            ))}
            {servers && !servers.length && !adding && <div className="card p-6 text-center text-[12.5px] text-[var(--color-faint)]">No MCP servers connected yet.</div>}
          </div>
        </section>

        <section className="mt-10">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="shrink-0 whitespace-nowrap text-[14px] font-semibold">Anvil → your AI tools</h2>
            <span className="text-[12px] text-[var(--color-muted)]">every agent is a tool, plus anvil_build / anvil_refine / anvil_run_agent / anvil_list_agents</span>
          </div>
          {expose && (
            <div className="space-y-3">
              <div className="card flex flex-wrap items-center gap-3 p-3 text-[12.5px]">
                <span className="label">Endpoint</span>
                <span className="mono min-w-0 max-w-full truncate" title={expose.url}>
                  {expose.url}
                </span>
                <CopyButton text={expose.url} />
                <span className="text-[var(--color-faint)]">Streamable HTTP{expose.tokenRequired ? " · Bearer token required (ANVIL_MCP_TOKEN)" : " · local only"}</span>
              </div>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                <Snippet label="Claude Code" code={expose.snippets.claudeCode} />
                <Snippet label="Claude Desktop (stdio)" code={expose.snippets.claudeDesktop} />
                <Snippet label="Cursor" code={expose.snippets.cursor} />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {expose.tools.map((t) => (
                  <span
                    key={t}
                    className="mono max-w-full truncate whitespace-nowrap rounded bg-[var(--color-panel-2)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-muted)]"
                    title={t}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
