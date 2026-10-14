import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from "@xyflow/react";
import type { NodeInstance } from "@core/types";
import { memo, useEffect } from "react";
import { Lock, Pin, StickyNote, Zap, AlertTriangle } from "lucide-react";
import { categoryOf, iconFor } from "../lib/categories";
export interface EditorNodeData extends Record<string, unknown> {
  node: NodeInstance;
  ports: string[];
  messages: string;
  severity?: string;
  pinned: boolean;
  sideEffects: boolean;
  errorUsed: boolean;
  status?: string;
  error?: string;
  durationMs?: number;
  cost?: number;
  dryRun?: boolean;
  runPinned?: boolean;
  addTrigger?: () => void;
  /** Set in a diff view (the assistant, versions, merges): how the step changed. */
  diff?: "added" | "removed" | "changed" | "same";
  diffFields?: string[];
}
export const EditorNode = memo(function EditorNode({ id, data, selected }: NodeProps<Node<EditorNodeData>>) {
  const n = data.node;
  const cat = categoryOf(n.type);
  const Icon = iconFor(n.type);
  const update = useUpdateNodeInternals();
  useEffect(() => {
    update(id);
  }, [id, data.ports.join("|"), update]);
  const success = data.ports.filter((p) => p !== "error");
  return (
    <div
      className={`wf-node ${selected ? "selected" : ""} ${data.diff ? `wf-diff-${data.diff}` : ""}`}
      title={data.diff === "changed" ? `Changed: ${data.diffFields?.join(", ")}` : undefined}
      data-status={data.status}
      style={{ opacity: n.disabled || data.status === "skipped" ? 0.45 : 1, minHeight: Math.max(76, success.length * 24 + 25) }}
    >
      <Handle type="target" position={Position.Left} isConnectable={n.type !== "input"} />
      <div className="flex gap-2.5 p-2.5">
        <div className="rounded-md p-1.5 h-fit" style={{ background: cat.bg, color: cat.color }}>
          <Icon size={16} />
        </div>
        <div className="min-w-0">
          <strong className="block truncate">{n.name || n.id}</strong>
          <div className="mono text-[10px]" style={{ color: cat.color }}>
            {n.type}
          </div>
          <div className="wf-hint truncate">{String(n.config.model ?? n.config.route ?? n.config.mode ?? "")}</div>
        </div>
      </div>
      <div className="flex gap-2 px-3 pb-2">
        {data.diff === "added" && <small className="wf-chip wf-chip-ok">new</small>}
        {data.diff === "removed" && <small className="wf-chip wf-chip-bad">removed</small>}
        {data.diff === "changed" && <small className="wf-chip wf-chip-warn">changed: {data.diffFields?.join(", ")}</small>}
        {n.disabled && <small>disabled</small>}
        {data.dryRun && <small>dry run</small>}
        {data.runPinned && <small>pinned</small>}
        {data.durationMs !== undefined && <small>{(data.durationMs / 1000).toFixed(1)}s</small>}
        {!!data.cost && <small>${data.cost.toFixed(4)}</small>}
        {n.locked && (
          <span title="Locked">
            <Lock size={12} />
          </span>
        )}
        {n.notes && (
          <span title={n.notes}>
            <StickyNote size={12} />
          </span>
        )}
        {data.pinned && (
          <span title="Pinned output">
            <Pin size={12} />
          </span>
        )}
        {data.sideEffects && (
          <span title="changes the outside world">
            <Zap size={12} />
          </span>
        )}
        {data.messages && (
          <span title={data.messages} style={{ color: data.severity === "error" ? "var(--color-bad)" : "var(--color-warn)" }}>
            <AlertTriangle size={13} />
          </span>
        )}
      </div>
      {data.error && (
        <div className="wf-error px-3 wf-clamp" title={data.error}>
          {data.error}
        </div>
      )}
      {n.type === "input" && data.addTrigger && (
        <button className="btn nodrag m-2" onClick={data.addTrigger}>
          + Trigger
        </button>
      )}
      {success.map((p, i) => (
        <Handle key={p} id={p} type="source" position={Position.Right} style={{ top: 20 + i * 24 }}>
          {success.length > 1 && <span className="wf-port">{p}</span>}
        </Handle>
      ))}
      {data.ports.includes("error") && (
        <Handle
          id="error"
          type="source"
          position={Position.Right}
          className={`wf-error-port ${selected || data.errorUsed ? "visible" : ""}`}
          style={{ top: "auto", bottom: 7, background: "var(--color-bad)" }}
        />
      )}
    </div>
  );
});
