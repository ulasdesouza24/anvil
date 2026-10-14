import type { AgentSpec } from "@core/types";
import { edgeKey } from "@core/workflow";
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, type Edge as FlowEdge, type Node } from "@xyflow/react";
import { useEffect, useMemo } from "react";
import { categoryOf } from "../lib/categories";
import { diffView } from "./diff";
import { EditorNode, type EditorNodeData } from "./EditorNode";

const nodeTypes = { editor: EditorNode };

const EDGE_COLOR = { added: "var(--color-ok)", removed: "var(--color-bad)", same: "var(--color-line-2)" } as const;

/** The ports of a step for the diff view: the known ports, or the ports that its edges use. */
function portsFor(spec: AgentSpec, id: string, known?: string[]): string[] {
  if (known?.length) return known;
  const used = spec.edges.filter((e) => e.from === id).map((e) => e.port ?? "out");
  return [...new Set(["out", ...used.filter((p) => p !== "error")]), "error"];
}

interface Props {
  base: AgentSpec;
  next: AgentSpec;
  /** The known ports of each step (from the inspection), so the handles match the editor. */
  ports?: Record<string, string[]>;
  onOpen?: (id: string) => void;
}

function Inner({ base, next, ports, onOpen }: Props) {
  const flow = useReactFlow();
  const measured = useNodesInitialized();
  const view = useMemo(() => diffView(base, next), [base, next]);
  const nodes: Node<EditorNodeData>[] = useMemo(
    () =>
      view.nodes.map(({ node, mark, fields }) => {
        const owner = mark === "removed" ? base : next;
        return {
          id: mark === "removed" ? `removed:${node.id}` : node.id,
          type: "editor",
          position: node.position ?? { x: 0, y: 0 },
          draggable: false,
          selectable: false,
          data: {
            node,
            ports: portsFor(owner, node.id, ports?.[node.id]),
            messages: "",
            pinned: false,
            sideEffects: false,
            errorUsed: owner.edges.some((e) => e.from === node.id && e.port === "error"),
            diff: mark,
            diffFields: fields,
          },
        };
      }),
    [view, base, next, ports],
  );
  const edges: FlowEdge[] = useMemo(
    () =>
      view.edges.map(({ edge, mark }) => {
        const removedFrom = mark === "removed" && view.diff.removed.includes(edge.from);
        const removedTo = mark === "removed" && view.diff.removed.includes(edge.to);
        return {
          id: `${mark}:${edgeKey(edge)}`,
          source: removedFrom ? `removed:${edge.from}` : edge.from,
          target: removedTo ? `removed:${edge.to}` : edge.to,
          sourceHandle: edge.port ?? "out",
          style: {
            stroke: EDGE_COLOR[mark],
            strokeWidth: mark === "same" ? 1.2 : 2,
            strokeDasharray: mark === "removed" ? "5 4" : undefined,
            opacity: mark === "removed" ? 0.8 : 1,
          },
          label: edge.port && edge.port !== "out" ? edge.port : undefined,
        };
      }),
    [view],
  );
  useEffect(() => {
    if (measured) void flow.fitView({ padding: 0.15, maxZoom: 1 });
  }, [measured, flow]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      nodesConnectable={false}
      nodesDraggable={false}
      minZoom={0.15}
      maxZoom={2}
      onNodeClick={(_, n) => !n.id.startsWith("removed:") && onOpen?.(n.id)}
    >
      <Background gap={20} />
      <Controls position="bottom-left" showInteractive={false} />
      <MiniMap
        bgColor="var(--color-panel)"
        maskColor="color-mix(in srgb, var(--color-bg) 75%, transparent)"
        nodeColor={(n) => {
          const d = n.data as EditorNodeData;
          if (d.diff === "added") return "var(--color-ok)";
          if (d.diff === "removed") return "var(--color-bad)";
          if (d.diff === "changed") return "var(--color-warn)";
          return categoryOf(d.node.type).color;
        }}
        position="bottom-right"
        style={{ width: 150, height: 100 }}
      />
    </ReactFlow>
  );
}

/** A read-only canvas that shows next with the changes against base: added, changed, and removed steps and edges. */
export function DiffCanvas(p: Props) {
  return (
    <div className="wf-canvas wf-diff">
      <ReactFlowProvider>
        <Inner {...p} />
      </ReactFlowProvider>
    </div>
  );
}
