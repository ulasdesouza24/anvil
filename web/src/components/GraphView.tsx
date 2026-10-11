import dagre from "@dagrejs/dagre";
import type { AgentSpec, NodeStatus } from "@core/types";
import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
} from "@xyflow/react";
import { memo, useEffect, useMemo } from "react";
import { categoryOf, iconFor } from "../lib/categories";

export interface AnvilNodeData extends Record<string, unknown> {
  id: string;
  type: string;
  name?: string;
  description?: string;
  status?: NodeStatus;
  badge?: string;
  selected?: boolean;
  compact?: boolean;
}

const STATUS_RING: Record<string, string> = {
  running: "0 0 0 2px #f97316, 0 0 24px -4px rgba(249,115,22,0.6)",
  waiting: "0 0 0 2px #fb7185, 0 0 24px -4px rgba(251,113,133,0.6)",
  done: "0 0 0 1px rgba(52,211,153,0.55)",
  failed: "0 0 0 2px #f87171",
};

const AnvilNode = memo(function AnvilNode({ data }: NodeProps<Node<AnvilNodeData>>) {
  const cat = categoryOf(data.type);
  const Icon = iconFor(data.type);
  const skipped = data.status === "skipped";
  return (
    <div
      className="relative rounded-[10px] border bg-[var(--color-panel)] transition-all duration-300"
      style={{
        width: data.compact ? 190 : 220,
        borderColor: data.selected ? "#f97316" : "var(--color-line-2)",
        boxShadow: data.status ? STATUS_RING[data.status] : undefined,
        opacity: skipped ? 0.35 : 1,
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="flex items-start gap-2.5 p-2.5">
        <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md" style={{ background: cat.bg, color: cat.color }}>
          <Icon size={15} strokeWidth={2.2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold leading-tight">{data.name || data.id}</div>
          <div className="mono mt-0.5 flex items-center gap-1.5 truncate text-[10.5px] text-[var(--color-faint)]">
            <span style={{ color: cat.color }}>{data.type}</span>
            {data.badge && <span className="rounded bg-[var(--color-panel-2)] px-1 text-[var(--color-muted)]">{data.badge}</span>}
          </div>
        </div>
        {data.status && data.status !== "pending" && (
          <span
            className={`mt-1 h-2 w-2 shrink-0 rounded-full ${data.status === "running" || data.status === "waiting" ? "pulse-dot" : ""}`}
            style={{ background: { running: "#f97316", waiting: "#fb7185", done: "#34d399", failed: "#f87171", skipped: "#5d6472" }[data.status] }}
            title={data.status}
          />
        )}
      </div>
      {!data.compact && data.description && (
        <div className="line-clamp-2 border-t border-[var(--color-line)] px-2.5 py-1.5 text-[11px] leading-snug text-[var(--color-muted)]">{data.description}</div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
});

const nodeTypes = { anvil: AnvilNode };

function modelBadge(n: AgentSpec["nodes"][number]): string | undefined {
  const c = n.config as Record<string, unknown>;
  if (n.type === "decision") return c.route ? `route:${String(c.route)}` : `${Object.keys((c.questions as object) ?? {}).length}q`;
  if (typeof c.model === "string") return c.model;
  if (n.type === "map") return String(c.mode ?? "llm");
  return undefined;
}

export function layout(spec: Pick<AgentSpec, "nodes" | "edges">, opts: { direction?: "TB" | "LR"; compact?: boolean } = {}) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: opts.direction ?? "TB", nodesep: 36, ranksep: 58, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  const w = opts.compact ? 190 : 220;
  for (const n of spec.nodes) g.setNode(n.id, { width: w, height: opts.compact || !n.description ? 58 : 92 });
  for (const e of spec.edges) if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
  dagre.layout(g);
  return Object.fromEntries(
    spec.nodes.map((n) => {
      const p = g.node(n.id);
      return [n.id, { x: (p?.x ?? 0) - w / 2, y: (p?.y ?? 0) - (p?.height ?? 58) / 2 }];
    }),
  );
}

interface Props {
  spec: Pick<AgentSpec, "nodes" | "edges">;
  states?: Record<string, NodeStatus>;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  compact?: boolean;
  direction?: "TB" | "LR";
  firedPorts?: Record<string, string[]>;
  className?: string;
}

function Inner({ spec, states, selected, onSelect, compact, direction, firedPorts, className }: Props) {
  const { fitView } = useReactFlow();
  const positions = useMemo(() => layout(spec, { direction, compact }), [spec, direction, compact]);

  const nodes: Node<AnvilNodeData>[] = useMemo(
    () =>
      spec.nodes.map((n) => ({
        id: n.id,
        type: "anvil",
        position: positions[n.id] ?? { x: 0, y: 0 },
        data: { id: n.id, type: n.type, name: n.name, description: n.description, status: states?.[n.id], badge: modelBadge(n), selected: selected === n.id, compact },
        draggable: false,
      })),
    [spec, positions, states, selected, compact],
  );

  const edges: Edge[] = useMemo(
    () =>
      spec.edges.map((e, i) => {
        const port = e.port ?? "out";
        const fromState = states?.[e.from];
        const fired = firedPorts?.[e.from];
        const active = fromState === "done" && (!fired || fired.includes(port)) && states?.[e.to] !== "skipped";
        const dead = states?.[e.to] === "skipped" || (fromState === "done" && fired && !fired.includes(port));
        const color = port === "error" ? "#f87171" : active ? "#f97316" : "#3b4252";
        return {
          id: `${e.from}-${port}-${e.to}-${i}`,
          source: e.from,
          target: e.to,
          label: e.port && e.port !== "out" ? e.port : undefined,
          animated: active && states?.[e.to] === "running",
          style: { stroke: color, strokeWidth: active ? 1.8 : 1.2, opacity: dead ? 0.25 : 1, strokeDasharray: port === "error" ? "4 3" : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        };
      }),
    [spec, states, firedPorts],
  );

  // Fit once React Flow has measured the nodes, and again whenever the graph's shape changes.
  const shape = spec.nodes.map((n) => n.id).join(",") + "|" + spec.edges.length;
  const measured = useNodesInitialized();
  useEffect(() => {
    if (!measured) return;
    const t = setTimeout(() => fitView({ padding: 0.12, duration: 200, maxZoom: 1.1 }), 20);
    return () => clearTimeout(t);
  }, [shape, measured, fitView]);

  return (
    <ReactFlow
      className={className}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      minZoom={0.2}
      maxZoom={1.6}
      nodesConnectable={false}
      onNodeClick={(_, n) => onSelect?.(n.id === selected ? null : n.id)}
      onPaneClick={() => onSelect?.(null)}
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#262a33" />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}

export const GraphView = memo(function GraphView(props: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
});
