import { useEffect, useMemo, useRef, useState, type Dispatch } from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useNodesInitialized,
  applyNodeChanges,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  NodeResizer,
  type EdgeProps,
  type NodeProps,
  type Node,
  type Edge as FlowEdge,
} from "@xyflow/react";
import type { AgentSpec, Edge, StickyNote } from "@core/types";
import { edgeKey, stable } from "@core/workflow";
import type { NodeClassInfo } from "../lib/api";
import { EditorNode, type EditorNodeData } from "./EditorNode";
import {
  addNode,
  canvasMeta,
  connect,
  copyNodes,
  deleteSticky,
  disconnect,
  duplicateNodes,
  editSticky,
  moveNodes,
  pasteNodes,
  protectedNode,
  removeNodes,
  setCanvas,
  updateNode,
  type Action,
  type EditorState,
} from "./store";
import { categoryOf } from "../lib/categories";
import type { RunState } from "../lib/useRun";
import { nodeOverlay } from "./runData";
import { firedPorts } from "../components/RunViewer";
import { TriggerNode } from "./TriggerNode";
import { autoLayout } from "./layout";
interface EdgeData extends Record<string, unknown> {
  remove: () => void;
  insert: () => void;
  readOnly: boolean;
}
function EditorEdge(p: EdgeProps<FlowEdge<EdgeData>>) {
  const [path, x, y] = getBezierPath(p);
  const [hover, setHover] = useState(false);
  return (
    <>
      <g onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <BaseEdge {...p} path={path} />
      </g>
      <EdgeLabelRenderer>
        <div className={`wf-edge-actions nodrag nopan ${hover ? "visible" : ""}`} style={{ transform: `translate(-50%, -50%) translate(${x}px,${y}px)` }} data-edge-key={p.id}>
          {!p.data?.readOnly && (
            <>
              <button title="Insert step" onClick={p.data?.insert}>
                +
              </button>
              <button title="Delete connection" onClick={p.data?.remove}>
                ×
              </button>
            </>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
interface NoteData extends Record<string, unknown> {
  note: StickyNote;
  edit: (n: StickyNote) => void;
  remove: () => void;
  readOnly: boolean;
}
function Sticky({ data, selected }: NodeProps<Node<NoteData>>) {
  const [editing, setEditing] = useState(false);
  const n = data.note;
  return (
    <div className="wf-sticky" style={{ background: n.color ?? "#39351f", width: "100%", height: "100%" }}>
      <NodeResizer
        isVisible={selected && !data.readOnly}
        minWidth={160}
        minHeight={100}
        onResizeEnd={(_, p) => data.edit({ ...n, position: { x: p.x, y: p.y }, size: { width: p.width, height: p.height } })}
      />
      {editing && !data.readOnly ? (
        <textarea autoFocus className="nodrag input" value={n.text} onChange={(e) => data.edit({ ...n, text: e.target.value })} onBlur={() => setEditing(false)} />
      ) : (
        <div onDoubleClick={() => setEditing(true)} style={{ whiteSpace: "pre-wrap", minHeight: 50 }}>
          {n.text || "Double-click to edit"}
        </div>
      )}
      {selected && !data.readOnly && (
        <div className="nodrag wf-row">
          {["#39351f", "#203b32", "#29334a", "#412b3b"].map((c) => (
            <button key={c} title={`Note color ${c}`} style={{ background: c, width: 18, height: 18, border: "1px solid #777" }} onClick={() => data.edit({ ...n, color: c })} />
          ))}
          <button title="Edit note" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button title="Delete note" onClick={data.remove}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
/** The last steps that this tab copied (see copy in Inner). */
let appClipboard: string | undefined;

const nodeTypes = { editor: EditorNode, sticky: Sticky, trigger: TriggerNode };
const edgeTypes = { editor: EditorEdge };
interface Props {
  state: EditorState;
  run?: RunState;
  onTest: () => void;
  onTrigger: (id: string) => void;
  onAddTrigger: () => void;
  onStepAction: (id: string, action: "node_only" | "to_node" | "pin" | "unpin" | "edit_pin") => void;
  dispatch: Dispatch<Action>;
  readOnly: boolean;
  classes: NodeClassInfo[];
  onPalette: (edge?: Edge) => void;
  onOpen: (id: string) => void;
  onRename: (id: string) => void;
  onSave: () => void;
  onClose: () => void;
  toast: (s: string) => void;
  addRef: React.MutableRefObject<((c: NodeClassInfo, edge?: Edge) => void) | null>;
}
function Inner(p: Props) {
  const { state: s, dispatch } = p;
  const flow = useReactFlow();
  const measured = useNodesInitialized();
  const fitted = useRef(!!canvasMeta(s.spec).viewport);
  useEffect(() => {
    if (measured && !fitted.current) {
      fitted.current = true;
      void flow.fitView({ padding: 0.15, maxZoom: 1 });
    }
  }, [measured, flow]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; id?: string } | null>(null);
  useEffect(() => {
    if (menu) document.querySelector<HTMLButtonElement>(".wf-menu button")?.focus();
  }, [menu]);
  const mouse = useRef({ x: 100, y: 100 });
  const pasteTimer = useRef<number | undefined>(undefined);
  const cache = useRef(new Map<string, { key: string; node: Node }>());
  const edit = (spec: AgentSpec, group?: string) => {
    if (!p.readOnly) dispatch({ type: "edit", spec, group });
  };
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      p.toast((e as Error).message);
    }
  };
  const add = (c: NodeClassInfo, edge?: Edge, point?: { x: number; y: number }) =>
    safe(() => {
      const selected = s.spec.nodes.find((n) => s.selection.includes(n.id));
      let next = addNode(s.spec, c, point ?? (selected ? { x: (selected.position?.x ?? 0) + 300, y: selected.position?.y ?? 0 } : mouse.current), edge);
      const n = next.nodes.at(-1)!;
      if (!edge && selected && s.inspection?.nodes[selected.id]?.ports.includes("out")) next = connect(next, { from: selected.id, to: n.id, port: "out" });
      edit(next);
      dispatch({ type: "select", ids: [n.id] });
      p.onOpen(n.id);
      void flow.setCenter((n.position?.x ?? 0) + 110, (n.position?.y ?? 0) + 50, { zoom: flow.getZoom(), duration: 200 });
    });
  p.addRef.current = add;
  useEffect(() => {
    const next: Node[] = s.spec.nodes.map((n) => {
      const diagnostics = s.inspection?.diagnostics.filter((d) => d.nodeId === n.id) ?? [];
      const data: EditorNodeData = {
        node: n,
        ...nodeOverlay(p.run, n.id),
        addTrigger: !p.readOnly && n.type === "input" ? p.onAddTrigger : undefined,
        ports: s.inspection?.nodes[n.id]?.ports ?? ["out", "error"],
        messages: diagnostics.map((d) => d.message).join("\n"),
        severity: diagnostics.some((d) => d.severity === "error") ? "error" : "warning",
        pinned: !!s.pinData[n.id],
        sideEffects: s.inspection?.nodes[n.id]?.sideEffects ?? false,
        errorUsed: s.spec.edges.some((e) => e.from === n.id && e.port === "error"),
      };
      const key = stable([data, s.selection.includes(n.id), p.readOnly]);
      const prev = cache.current.get(n.id);
      if (prev?.key === key) return prev.node;
      const node: Node = { id: n.id, type: "editor", position: n.position ?? { x: 0, y: 0 }, data, selected: s.selection.includes(n.id), draggable: !p.readOnly };
      cache.current.set(n.id, { key, node });
      return node;
    });
    for (const note of canvasMeta(s.spec).notes ?? [])
      next.push({
        id: `sticky:${note.id}`,
        type: "sticky",
        selected: s.selection.includes(`sticky:${note.id}`),
        position: note.position,
        style: { width: note.size?.width ?? 240, height: note.size?.height ?? 160 },
        data: { note, readOnly: p.readOnly, edit: (n: StickyNote) => edit(editSticky(s.spec, n), "sticky:" + n.id), remove: () => edit(deleteSticky(s.spec, note.id)) },
        draggable: !p.readOnly,
      });
    const input = s.spec.nodes.find((n) => n.type === "input");
    if (input)
      for (const [i, trigger] of [undefined, ...(s.spec.triggers ?? [])].entries()) {
        const id = trigger?.id ?? "$manual";
        next.push({
          id: `trigger:${id}`,
          type: "trigger",
          data: { trigger, agentId: s.spec.id },
          position: canvasMeta(s.spec).triggers?.[id] ?? { x: (input.position?.x ?? 0) - 320, y: (input.position?.y ?? 0) + i * 110 },
          draggable: !p.readOnly,
        });
      }
    setNodes(next);
  }, [s.spec, s.selection, s.inspection, s.pinData, p.readOnly, p.run]);
  const edges = useMemo(() => {
    const ports = firedPorts(p.run?.events ?? []);
    const result: FlowEdge[] = s.spec.edges.map((e) => {
      const port = e.port ?? "out";
      const fired = ports[e.from];
      const active = p.run?.nodeStates[e.from] === "done" && (!fired || fired.includes(port)) && p.run?.nodeStates[e.to] !== "skipped";
      const dead = p.run?.nodeStates[e.to] === "skipped" || (p.run?.nodeStates[e.from] === "done" && fired && !fired.includes(port));
      return {
        id: edgeKey(e),
        source: e.from,
        target: e.to,
        sourceHandle: port,
        type: "editor",
        animated: active && p.run?.nodeStates[e.to] === "running",
        style: {
          stroke: active ? "var(--color-ember)" : port === "error" ? "var(--color-bad)" : "var(--color-line-2)",
          opacity: dead ? 0.25 : 1,
          strokeDasharray: port === "error" ? "4 3" : undefined,
        },
        data: { readOnly: p.readOnly, remove: () => edit(disconnect(s.spec, edgeKey(e))), insert: () => p.onPalette(e) },
      };
    });
    const input = s.spec.nodes.find((n) => n.type === "input");
    if (input)
      for (const id of ["$manual", ...(s.spec.triggers ?? []).map((t) => t.id)])
        result.push({ id: `trigger-edge:${id}`, source: `trigger:${id}`, target: input.id, selectable: false, style: { stroke: "var(--color-line-2)", strokeDasharray: "5 5" } });
    return result;
  }, [s.spec, p.readOnly, p.run]);
  // The app keeps its own copy of the clipboard: a browser can refuse to read the system clipboard.
  const copy = async () => {
    const text = JSON.stringify(copyNodes(s.spec, s.selection));
    appClipboard = text;
    await navigator.clipboard?.writeText(text).catch(() => undefined);
  };
  const pasteText = (text: string | undefined) => {
    if (!text) return p.toast("Copy a step first");
    try {
      edit(pasteNodes(s.spec, JSON.parse(text), mouse.current));
    } catch {
      p.toast("The clipboard has no Anvil steps");
    }
  };
  const paste = async () => pasteText(appClipboard ?? (await navigator.clipboard?.readText().catch(() => undefined)));
  const deleteSelection = () => {
    let next = removeNodes(s.spec, s.selection);
    for (const id of s.selection) if (id.startsWith("sticky:")) next = deleteSticky(next, id.slice(7));
    edit(next);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input,textarea,select,[contenteditable="true"],.cm-editor,.wf-palette,.wf-menu,[role="dialog"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (k === "escape") {
        setMenu(null);
        p.onClose();
        dispatch({ type: "select", ids: [] });
        return;
      }
      if (p.readOnly) return;
      // Ctrl/Cmd+V is not stopped: the paste event gives the clipboard text without a permission.
      if ((mod && ["s", "a", "c", "d", "z", "y"].includes(k)) || ["delete", "backspace", "tab", "f2"].includes(k) || k === "d") e.preventDefault();
      if (mod && k === "v") {
        // The paste event comes next when the browser does a paste. Without it, the app clipboard gives the steps.
        pasteTimer.current = window.setTimeout(() => void paste(), 80);
        return;
      }
      if (mod && k === "s") {
        window.dispatchEvent(new Event("workflow:flush"));
        p.onSave();
      } else if (mod && k === "a") dispatch({ type: "select", ids: s.spec.nodes.map((n) => n.id) });
      else if (mod && k === "c") void copy().catch((e) => p.toast(e.message));
      else if (mod && k === "d") safe(() => edit(duplicateNodes(s.spec, s.selection)));
      else if (mod && (k === "z" || k === "y")) dispatch({ type: k === "y" || e.shiftKey ? "redo" : "undo" });
      else if (k === "delete" || k === "backspace") deleteSelection();
      else if (k === "tab") p.onPalette();
      else if (k === "f2" && s.selection[0]) p.onRename(s.selection[0]);
      else if (k === "d") {
        let next = s.spec;
        for (const n of next.nodes.filter((n) => s.selection.includes(n.id) && !protectedNode(n))) next = updateNode(next, n.id, { disabled: !n.disabled });
        edit(next);
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      if (p.readOnly || (e.target as HTMLElement | null)?.closest?.('input,textarea,select,[contenteditable="true"],.cm-editor,[role="dialog"]')) return;
      const text = e.clipboardData?.getData("text/plain");
      window.clearTimeout(pasteTimer.current);
      e.preventDefault();
      pasteText(text?.includes("anvilNodes") ? text : (appClipboard ?? text));
    };
    window.addEventListener("keydown", key);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("paste", onPaste);
    };
  }, [s, p]);
  const action = (label: string, fn: () => void) => (
    <button
      role="menuitem"
      key={label}
      className="wf-menu-item"
      onClick={() => {
        safe(fn);
        setMenu(null);
      }}
    >
      {label}
    </button>
  );
  const selectedNode = s.spec.nodes.find((n) => n.id === menu?.id);
  return (
    <div
      className="wf-canvas"
      onMouseMove={(e) => {
        mouse.current = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (p.readOnly) return;
        const c = p.classes.find((c) => c.type === e.dataTransfer.getData("application/anvil-class"));
        if (!c) return;
        const el = (e.target as Element).closest("[data-edge-key],.react-flow__edge");
        const key = el?.getAttribute("data-edge-key") ?? el?.getAttribute("data-id");
        add(
          c,
          s.spec.edges.find((x) => edgeKey(x) === key),
          flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
        );
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultViewport={canvasMeta(s.spec).viewport}
        minZoom={0.15}
        maxZoom={2}
        // A left drag on the empty canvas pans (as in n8n). Shift + drag draws a selection box.
        panOnDrag={[0, 1]}
        panActivationKeyCode="Space"
        selectionKeyCode="Shift"
        multiSelectionKeyCode={["Meta", "Control", "Shift"]}
        deleteKeyCode={null}
        nodesConnectable={!p.readOnly}
        onNodesChange={(changes) => {
          setNodes((ns) => applyNodeChanges(changes, ns));
          const selections = changes.filter((c) => c.type === "select");
          if (selections.length) {
            const ids = new Set(s.selection);
            for (const c of selections)
              if (c.type === "select") {
                if (c.selected) ids.add(c.id);
                else ids.delete(c.id);
              }
            dispatch({ type: "select", ids: [...ids] });
          }
        }}
        onNodeDragStop={(_, node, moved) => {
          let next = moveNodes(s.spec, Object.fromEntries(moved.filter((n) => n.type === "editor").map((n) => [n.id, n.position])));
          for (const n of moved.filter((n) => n.type === "sticky")) next = editSticky(next, { ...(n.data as NoteData).note, position: n.position });
          const triggers = { ...canvasMeta(next).triggers };
          for (const n of moved.filter((n) => n.type === "trigger")) triggers[n.id.slice(8)] = n.position;
          if (moved.some((n) => n.type === "trigger")) next = setCanvas(next, { triggers });
          edit(next, "drag");
        }}
        onConnect={(c) =>
          safe(() => {
            if (c.source && c.target) edit(connect(s.spec, { from: c.source, to: c.target, port: c.sourceHandle ?? "out" }));
          })
        }
        onNodeClick={(e, n) => {
          // The click selects the step (Shift adds it to the selection), so copy, duplicate and the keys act on it.
          if (n.type === "editor" || n.type === "sticky") dispatch({ type: "select", ids: e.shiftKey || e.metaKey || e.ctrlKey ? [...new Set([...s.selection, n.id])] : [n.id] });
          if (n.type === "editor") p.onOpen(n.id);
          if (n.type === "trigger") {
            if (n.id === "trigger:$manual") p.onTest();
            else p.onTrigger(n.id.slice(8));
          }
        }}
        onPaneClick={() => setMenu(null)}
        onNodeContextMenu={(e, n) => {
          e.preventDefault();
          dispatch({ type: "select", ids: [n.id] });
          setMenu({ x: e.clientX, y: e.clientY, id: n.id });
        }}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        onMoveEnd={(e, viewport) => {
          if (e && !p.readOnly) edit(setCanvas(s.spec, { viewport }), "viewport");
        }}
      >
        <Background gap={20} />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          bgColor="var(--color-panel)"
          maskColor="color-mix(in srgb, var(--color-bg) 75%, transparent)"
          nodeColor={(n) => (n.type === "editor" ? categoryOf((n.data as EditorNodeData).node.type).color : "var(--color-muted)")}
          position="bottom-right"
          style={{ width: 150, height: 100 }}
          pannable
          zoomable
        />
      </ReactFlow>
      {menu && (
        <div
          role="menu"
          className="wf-menu card"
          style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 340) }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setMenu(null);
            const buttons = [...e.currentTarget.querySelectorAll("button")];
            const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              buttons[(i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
            }
          }}
        >
          {selectedNode ? (
            <>
              {action("Open", () => p.onOpen(selectedNode.id))}
              {!p.readOnly && (
                <>
                  {action("Execute step", () => p.onStepAction(selectedNode.id, "node_only"))}
                  {action("Run to here", () => p.onStepAction(selectedNode.id, "to_node"))}
                  {action("Pin output", () => p.onStepAction(selectedNode.id, "pin"))}
                  {action("Unpin", () => p.onStepAction(selectedNode.id, "unpin"))}
                  {action("Edit pinned data", () => p.onStepAction(selectedNode.id, "edit_pin"))}
                  {action("Rename (F2)", () => p.onRename(selectedNode.id))}
                  {!protectedNode(selectedNode) && (
                    <>
                      {action("Duplicate (Ctrl+D)", () => edit(duplicateNodes(s.spec, [selectedNode.id])))}
                      {action("Copy", () => void copy().catch((e) => p.toast(e.message)))}
                      {action(selectedNode.disabled ? "Enable" : "Disable (D)", () => edit(updateNode(s.spec, selectedNode.id, { disabled: !selectedNode.disabled })))}
                      {action("Delete", () => edit(removeNodes(s.spec, [selectedNode.id])))}
                    </>
                  )}
                  {action(selectedNode.locked ? "Unlock" : "Lock", () => edit(updateNode(s.spec, selectedNode.id, { locked: !selectedNode.locked })))}
                  {action("Add note", () => {
                    const notes = prompt("Step note", selectedNode.notes ?? "");
                    if (notes !== null) edit(updateNode(s.spec, selectedNode.id, { notes }));
                  })}
                </>
              )}
            </>
          ) : (
            <>
              {!p.readOnly && (
                <>
                  {action("Paste", () => void paste())}
                  {action("Add step (Tab)", () => p.onPalette())}
                  {action("Add sticky note", () => edit(editSticky(s.spec, { id: crypto.randomUUID(), text: "Note", position: mouse.current })))}
                  {action("Auto-layout", () => edit(autoLayout(s.spec)))}
                </>
              )}
              {action("Fit view", () => void flow.fitView())}
            </>
          )}
        </div>
      )}
    </div>
  );
}
export function Canvas(p: Props) {
  return (
    <ReactFlowProvider>
      <Inner {...p} />
    </ReactFlowProvider>
  );
}
