import { AlertTriangle, Cable, Check, Code2, FileJson, FlaskConical, Globe, KeyRound, MessageSquareText, Puzzle, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type CustomClass, type Diagnostic } from "../lib/api";
import { ago } from "../lib/format";
import { JsonBlock, JsonEditor, Spinner } from "./ui";

const KIND = {
  http: { icon: Globe, label: "HTTP integration" },
  code: { icon: Code2, label: "Code" },
  llm: { icon: MessageSquareText, label: "LLM skill" },
  mcp: { icon: Cable, label: "MCP tool" },
} as const;

const STATUS: Record<CustomClass["status"], { color: string; label: string }> = {
  passed: { color: "#34d399", label: "tests pass" },
  failed: { color: "#f87171", label: "tests fail" },
  untested: { color: "#9097a4", label: "untested" },
};

const TEMPLATE = {
  type: "x_my_class",
  title: "My class",
  category: "tool",
  description: "What this class does.",
  whenToUse: "When an agent should use it.",
  configSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"] },
  example: { text: "hello" },
  sideEffects: false,
  secrets: [],
  impl: { kind: "code", code: "return { result: config.text.toUpperCase() };" },
  tests: [{ name: "basic", config: { text: "hi" }, checks: [{ path: "result", op: "equals", value: "HI" }] }],
};

function ClassCard({ c, onChange }: { c: CustomClass; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const K = KIND[c.impl.kind];
  const st = STATUS[c.status];
  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await fn();
      onChange();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="card p-4">
      <button className="flex w-full items-start gap-3 text-left" onClick={() => setOpen(!open)}>
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg" style={{ background: "rgba(232,121,249,0.12)", color: "#e879f9" }}>
          <K.icon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-semibold">{c.title}</span>
            <span className="mono text-[11px] text-[var(--color-faint)]">{c.type}</span>
            <span className="rounded px-1.5 py-0.5 text-[10.5px]" style={{ color: st.color, background: `${st.color}18` }}>
              {st.label}
            </span>
            {c.sideEffects && (
              <span className="rounded bg-[rgba(251,113,133,0.12)] px-1.5 py-0.5 text-[10.5px] text-[#fb7185]">
                {c.approved ? "side effects · approved" : "side effects · needs approval"}
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] leading-snug text-[var(--color-muted)]">{c.description}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-[var(--color-faint)]">
            <span>{K.label}</span>
            <span>v{c.version}</span>
            <span>by {c.createdBy}</span>
            <span>{ago(c.createdAt)}</span>
            {c.usedBy.length > 0 && <span>used by {c.usedBy.join(", ")}</span>}
            {c.secrets.map((s) => (
              <span key={s} className="mono inline-flex items-center gap-1" style={{ color: c.missingSecrets.includes(s) ? "#fbbf24" : undefined }}>
                <KeyRound size={10} /> {s}
                {c.missingSecrets.includes(s) ? " (missing in .env)" : ""}
              </span>
            ))}
          </div>
        </div>
      </button>
      {open && (
        <div className="mt-3 space-y-3 border-t border-[var(--color-line)] pt-3">
          <div className="flex flex-wrap gap-2">
            {c.sideEffects && (
              <button className="btn !py-1 text-[12px]" disabled={!!busy} onClick={() => act("approve", () => api.approveClass(c.type, !c.approved))}>
                {busy === "approve" ? <Spinner /> : <ShieldCheck size={13} />} {c.approved ? "Revoke approval" : "Approve for use"}
              </button>
            )}
            <button className="btn !py-1 text-[12px]" disabled={!!busy} onClick={() => act("test", () => api.retestClass(c.type))}>
              {busy === "test" ? <Spinner /> : <FlaskConical size={13} />} Re-run tests
            </button>
            <button
              className="btn btn-danger !py-1 text-[12px]"
              disabled={!!busy}
              onClick={() => {
                const msg = c.usedBy.length ? `"${c.type}" is used by ${c.usedBy.join(", ")}. Delete anyway? Those agents will stop compiling.` : `Delete "${c.type}"?`;
                if (confirm(msg)) act("delete", () => api.deleteClass(c.type, c.usedBy.length > 0));
              }}
            >
              <Trash2 size={13} /> Delete
            </button>
          </div>
          {c.testReport.length > 0 && (
            <div>
              <div className="label mb-1.5">Last test run (executed for real)</div>
              <div className="space-y-1.5">
                {c.testReport.map((r) => (
                  <details key={r.name} className="rounded-md border border-[var(--color-line)] px-2.5 py-1.5">
                    <summary className="flex cursor-pointer items-center gap-2 text-[12px]">
                      {r.passed ? <Check size={13} className="text-[var(--color-ok)]" /> : <X size={13} className="text-[var(--color-bad)]" />} {r.name}
                      {r.error && <span className="truncate text-[11px] text-[var(--color-bad)]">{r.error}</span>}
                    </summary>
                    <JsonBlock value={r.output ?? null} className="mt-1.5 max-h-48" />
                  </details>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <div className="label mb-1">Config schema</div>
              <JsonBlock value={c.configSchema} className="max-h-56" />
            </div>
            <div>
              <div className="label mb-1">Output schema</div>
              <JsonBlock value={c.outputSchema} className="max-h-56" />
            </div>
          </div>
          <div>
            <div className="label mb-1">Implementation</div>
            <JsonBlock value={c.impl} className="max-h-72" />
          </div>
        </div>
      )}
    </div>
  );
}

function JsonClassEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState(JSON.stringify(TEMPLATE, null, 2));
  const [busy, setBusy] = useState(false);
  const [diags, setDiags] = useState<Diagnostic[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    setDiags([]);
    try {
      const r = await api.saveClass(JSON.parse(text));
      setDiags(r.diagnostics);
      onSaved();
      if (!r.diagnostics.some((d) => d.severity === "error")) onClose();
    } catch (e) {
      setErr((e as Error).message);
      setDiags(((e as { data?: { diagnostics?: Diagnostic[] } }).data?.diagnostics ?? []) as Diagnostic[]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card mt-3 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--color-line)] px-3 py-2">
        <FileJson size={14} className="text-[#e879f9]" />
        <span className="text-[12.5px] font-medium">Class definition (JSON)</span>
        <span className="text-[11px] text-[var(--color-faint)]">validated and tested for real on save</span>
        <div className="ml-auto flex gap-2">
          <button className="btn btn-ghost !py-1 text-[12px]" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary !py-1 text-[12px]" disabled={busy} onClick={save}>
            {busy && <Spinner />} Save & test
          </button>
        </div>
      </div>
      <div className="h-[380px] overflow-auto">
        <JsonEditor value={text} onChange={setText} />
      </div>
      {(err || diags.length > 0) && (
        <div className="space-y-1 border-t border-[var(--color-line)] px-3 py-2 text-[12px]">
          {err && <div className="text-[var(--color-bad)]">{err}</div>}
          {diags.map((d, i) => (
            <div key={i} style={{ color: d.severity === "error" ? "var(--color-bad)" : "var(--color-muted)" }}>
              {d.path && <span className="mono text-[var(--color-faint)]">{d.path} </span>}
              {d.message}
              {d.hint && <span className="text-[var(--color-faint)]"> — {d.hint}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Library section for runtime-generated classes. */
export function CustomClassesSection({ onChanged }: { onChanged?: () => void }) {
  const nav = useNavigate();
  const [items, setItems] = useState<CustomClass[] | null>(null);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState(false);
  const load = useCallback(() => {
    api
      .classes()
      .then(setItems)
      .catch(() => setItems([]));
    onChanged?.();
  }, [onChanged]);
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async () => {
    if (!request.trim()) return;
    setBusy(true);
    try {
      const { runId } = await api.generateClass(request);
      nav(`/builds/${runId}`);
    } finally {
      setBusy(false);
    }
  };

  const pending = items?.filter((c) => c.sideEffects && !c.approved) ?? [];
  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-[#e879f9]" />
        <h2 className="text-[13px] font-semibold">Custom classes</h2>
        <span className="text-[12px] text-[var(--color-muted)]">— the library extends itself: the builder writes these when a task needs a missing capability.</span>
      </div>
      <div className="card flex flex-wrap items-center gap-2 p-3">
        <Sparkles size={15} className="ml-1 text-[#e879f9]" />
        <input
          className="input min-w-[280px] flex-1 !border-transparent !bg-transparent !shadow-none"
          placeholder="Describe a capability to add… e.g. “convert an amount between currencies with live ECB rates”"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && generate()}
        />
        <button className="btn" onClick={() => setEditor(!editor)}>
          <FileJson size={14} /> Write JSON
        </button>
        <button className="btn btn-primary" disabled={busy || !request.trim()} onClick={generate}>
          {busy ? <Spinner /> : <Puzzle size={14} />} Generate class
        </button>
      </div>
      {editor && <JsonClassEditor onClose={() => setEditor(false)} onSaved={load} />}
      {pending.length > 0 && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-[rgba(251,113,133,0.4)] bg-[rgba(251,113,133,0.06)] px-3 py-2 text-[12px] text-[#fda4af]">
          <AlertTriangle size={14} /> {pending.length} generated class{pending.length > 1 ? "es" : ""} with side effects need{pending.length > 1 ? "" : "s"} your approval before
          agents can run {pending.length > 1 ? "them" : "it"}: {pending.map((c) => c.type).join(", ")}
        </div>
      )}
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {items?.map((c) => (
          <ClassCard key={c.type} c={c} onChange={load} />
        ))}
      </div>
      {items && !items.length && (
        <div className="mt-3 text-[12px] text-[var(--color-faint)]">
          No custom classes yet. Generate one above, or build an agent that needs a capability the library doesn’t have.
        </div>
      )}
    </section>
  );
}
