import type { AgentSpec, NodeInstance } from "@core/types";
import { ancestorsOf } from "@core/workflow";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { Inspection, NodeClassInfo, PinData } from "../lib/api";
import { ConfigForm, JsonValue } from "./ConfigForm";
import { DataView } from "./DataView";
import { protectedNode } from "./store";
import { iconFor } from "../lib/categories";
export interface PanelTab {
  id: string;
  label: string;
  content: ReactNode;
}
interface Props {
  spec: AgentSpec;
  node: NodeInstance;
  classes: NodeClassInfo[];
  inspection?: Inspection;
  pinData: PinData;
  data: PinData;
  input: unknown;
  readOnly: boolean;
  secrets: string[];
  agents: { id: string; name: string }[];
  onUpdate: (patch: Partial<NodeInstance>) => void;
  onRename: () => void;
  onDelete: () => void;
  onPin: (value: unknown, remove?: boolean) => void;
  onClose: () => void;
  extraTabs?: PanelTab[];
  focusPath?: string;
  runContent?: ReactNode;
  runError?: string;
  truncated?: boolean;
  outputRequest?: number;
  onExecute?: (mode: "node_only" | "to_node") => void;
  /** Opens the AI assistant with the error of this step. */
  onFixWithAI?: () => void;
}
export function NodePanel(p: Props) {
  const [tab, setTab] = useState("parameters");
  const [config, setConfig] = useState(p.node.config);
  const [editPin, setEditPin] = useState(false);
  useEffect(() => {
    if (p.outputRequest) setTab("output");
  }, [p.outputRequest]);
  const pending = useRef<Record<string, unknown> | null>(null);
  const callback = useRef(p.onUpdate);
  callback.current = p.onUpdate;
  useEffect(() => {
    if (!pending.current) setConfig(p.node.config);
  }, [p.node.config]);
  useEffect(() => {
    const flush = () => {
      if (pending.current) {
        const v = pending.current;
        pending.current = null;
        window.dispatchEvent(new CustomEvent("workflow:pending", { detail: false }));
        callback.current({ config: v });
      }
    };
    window.addEventListener("workflow:flush", flush);
    return () => {
      flush();
      window.removeEventListener("workflow:flush", flush);
    };
  }, []);
  useEffect(() => {
    if (!pending.current) return;
    const t = setTimeout(() => {
      if (pending.current) {
        const v = pending.current;
        pending.current = null;
        window.dispatchEvent(new CustomEvent("workflow:pending", { detail: false }));
        callback.current({ config: v });
      }
    }, 180);
    return () => clearTimeout(t);
  }, [config]);
  useEffect(() => {
    if (p.focusPath) {
      setTab("parameters");
      setTimeout(() => {
        const el = [...document.querySelectorAll<HTMLElement>("[data-field-path]")]
          .filter((e) => p.focusPath?.startsWith(e.dataset.fieldPath!))
          .sort((a, b) => b.dataset.fieldPath!.length - a.dataset.fieldPath!.length)[0];
        el?.scrollIntoView({ block: "center" });
        el?.querySelector<HTMLElement>("input,textarea,.cm-content")?.focus();
      }, 30);
    }
  }, [p.focusPath]);
  const ancestors = useMemo(() => ancestorsOf(p.spec, p.node.id), [p.spec.edges, p.node.id]);
  const context = useMemo(
    () => ({
      ancestors,
      scope: { input: p.input, nodes: p.data },
      schemas: { input: p.spec.inputSchema, ...Object.fromEntries(Object.entries(p.inspection?.nodes ?? {}).map(([id, n]) => [id, n.outputSchema ?? {}])) },
    }),
    [ancestors, p.input, p.data, p.spec.inputSchema, p.inspection],
  );
  const c = p.classes.find((c) => c.type === p.node.type);
  const Icon = iconFor(p.node.type);
  const input = (
    <>
      <h3>Input</h3>
      {p.truncated && <p className="wf-hint">This data can be cut. Run the step in the editor for the full data.</p>}
      <DataView root="input" value={p.input} schema={p.spec.inputSchema} />
      {[...ancestors]
        .filter((id) => p.spec.nodes.find((n) => n.id === id)?.type !== "input")
        .map((id) => (
          <section key={id}>
            <h4>{id}</h4>
            <DataView root={`nodes.${id}.output`} value={p.data[id]?.output} schema={p.inspection?.nodes[id]?.outputSchema} />
          </section>
        ))}
    </>
  );
  const output = (
    <>
      <h3>Output</h3>
      {p.runError && <p className="wf-error">{p.runError}</p>}
      {p.runError && p.onFixWithAI && !p.readOnly && (
        <button className="btn" onClick={p.onFixWithAI}>
          Fix with AI
        </button>
      )}
      {p.truncated && <p className="wf-hint">This data can be cut. Run the step in the editor for the full data.</p>}
      <DataView root={`nodes.${p.node.id}.output`} value={p.data[p.node.id]?.output} schema={p.inspection?.nodes[p.node.id]?.outputSchema} />
      {!p.readOnly && (
        <>
          <button className="btn" disabled={!p.data[p.node.id]} onClick={() => p.onPin(p.data[p.node.id].output)}>
            Pin this output
          </button>
          <button className="btn" onClick={() => setEditPin(!editPin)}>
            Edit pinned data
          </button>
          {p.pinData[p.node.id] && (
            <button className="btn" onClick={() => p.onPin(undefined, true)}>
              Remove pin
            </button>
          )}
          {editPin && <JsonValue value={p.pinData[p.node.id]?.output ?? p.data[p.node.id]?.output ?? {}} onChange={p.onPin} />}
        </>
      )}
    </>
  );
  const parameters = (
    <fieldset disabled={p.readOnly} inert={p.readOnly}>
      <h3>Parameters</h3>
      <ConfigForm
        schema={c?.configSchema ?? {}}
        value={config}
        onChange={(v) => {
          pending.current = v;
          window.dispatchEvent(new CustomEvent("workflow:pending", { detail: true }));
          setConfig(v);
        }}
        context={context}
        type={p.node.type}
        diagnostics={p.inspection?.diagnostics ?? []}
        path={`/nodes/${p.spec.nodes.findIndex((n) => n.id === p.node.id)}/config`}
        secrets={p.secrets}
        agents={p.agents}
      />
      <details className="mt-5">
        <summary>Settings</summary>
        {(["description", "notes"] as const).map((k) => (
          <label className="wf-field" key={k}>
            {k}
            <textarea className="input" value={p.node[k] ?? ""} onChange={(e) => p.onUpdate({ [k]: e.target.value })} />
          </label>
        ))}
        {(["maxAttempts", "backoffMs"] as const).map((k) => (
          <label className="wf-field" key={k}>
            {k}
            <input
              className="input"
              type="number"
              min={k === "maxAttempts" ? 1 : 0}
              max={k === "maxAttempts" ? 5 : 30000}
              value={p.node.retry?.[k] ?? (k === "maxAttempts" ? 1 : 500)}
              onChange={(e) => p.onUpdate({ retry: { ...p.node.retry, [k]: Number(e.target.value) } })}
            />
          </label>
        ))}
        <label className="wf-field">
          Timeout (ms)
          <input
            className="input"
            type="number"
            min={1}
            max={900000}
            value={p.node.timeoutMs ?? ""}
            onChange={(e) => p.onUpdate({ timeoutMs: e.target.value ? Number(e.target.value) : undefined })}
          />
        </label>
        <p className="wf-hint">The AI builder does not change a locked step.</p>
      </details>
    </fieldset>
  );
  return (
    <aside className="wf-node-panel">
      <header>
        <div className="wf-row">
          <Icon size={18} />
          <input aria-label="Step name" className="input" disabled={p.readOnly} value={p.node.name ?? ""} onChange={(e) => p.onUpdate({ name: e.target.value })} />
          <button className="btn" title="Close panel" onClick={p.onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="wf-row mono mt-2">
          {p.node.type} ·{" "}
          <button disabled={p.readOnly} title="Rename step id" onClick={p.onRename}>
            {p.node.id}
          </button>
        </div>
        {!p.readOnly && (
          <div className="wf-row mt-2">
            <button className="btn" disabled={protectedNode(p.node)} onClick={() => p.onUpdate({ disabled: !p.node.disabled })}>
              {p.node.disabled ? "Enable" : "Disable"}
            </button>
            <button className="btn" onClick={() => p.onUpdate({ locked: !p.node.locked })}>
              {p.node.locked ? "Unlock" : "Lock"}
            </button>
            <button className="btn" disabled={protectedNode(p.node)} onClick={p.onDelete}>
              Delete
            </button>
          </div>
        )}
      </header>
      {p.runContent}
      {p.onExecute && !p.readOnly && (
        <div className="wf-row p-3">
          <button className="btn" onClick={() => p.onExecute?.("node_only")}>
            Execute step
          </button>
          <button className="btn" onClick={() => p.onExecute?.("to_node")}>
            Run to here
          </button>
          <button className="btn" disabled={!p.data[p.node.id]} onClick={() => p.onPin(p.data[p.node.id].output)}>
            Pin output
          </button>
          {p.pinData[p.node.id] && (
            <button className="btn" onClick={() => p.onPin(undefined, true)}>
              Unpin
            </button>
          )}
          <button
            className="btn"
            onClick={() => {
              setTab("output");
              setEditPin(true);
            }}
          >
            Edit pinned data
          </button>
        </div>
      )}
      <nav className="wf-row wf-panel-tabs" role="tablist" aria-label="Step data">
        {[{ id: "input", label: "Input" }, { id: "parameters", label: "Parameters" }, { id: "output", label: "Output" }, ...(p.extraTabs ?? [])].map((t) => (
          <button key={t.id} className="tab" data-active={tab === t.id ? "true" : undefined} aria-selected={tab === t.id} role="tab" onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="wf-panel-columns">
        {[{ id: "input", content: input }, { id: "parameters", content: parameters }, { id: "output", content: output }, ...(p.extraTabs ?? [])].map((t) => (
          <section key={t.id} className={`wf-panel-column ${tab === t.id ? "active" : ""}`}>
            {t.content}
          </section>
        ))}
      </div>
    </aside>
  );
}
