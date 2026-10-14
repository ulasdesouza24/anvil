import { NodeInstanceZ, EdgeZ } from "@core/types";
import type { AgentSpec, CanvasMeta, Edge, NodeInstance, StickyNote } from "@core/types";
import { edgeKey, makesCycle, renameNodeId, stable, uniqueNodeId, diffSpecs } from "@core/workflow";
import type { Inspection, PinData, NodeClassInfo } from "../lib/api";
export const protectedNode = (n: NodeInstance) => n.type === "input" || n.type === "output";
export interface EditorCanvasMeta extends CanvasMeta {
  triggers?: Record<string, { x: number; y: number }>;
}
export const canvasMeta = (s: AgentSpec): EditorCanvasMeta => (s.meta.canvas ?? {}) as EditorCanvasMeta;
export const setCanvas = (s: AgentSpec, patch: Partial<EditorCanvasMeta>): AgentSpec => ({ ...s, meta: { ...s.meta, canvas: { ...canvasMeta(s), ...patch } } });
export function connect(s: AgentSpec, e: Edge): AgentSpec {
  if (!s.nodes.some((n) => n.id === e.from) || !s.nodes.some((n) => n.id === e.to)) throw Error("Step not found");
  if (s.nodes.find((n) => n.id === e.to)?.type === "input") throw Error("Cannot connect into input");
  if (s.edges.some((x) => edgeKey(x) === edgeKey(e))) throw Error("This connection exists");
  if (makesCycle(s, e.from, e.to)) throw Error("This connection makes a cycle");
  return { ...s, edges: [...s.edges, e] };
}
export const disconnect = (s: AgentSpec, key: string): AgentSpec => ({ ...s, edges: s.edges.filter((e) => edgeKey(e) !== key) });
export function addNode(s: AgentSpec, c: NodeClassInfo, position: { x: number; y: number }, edge?: Edge): AgentSpec {
  if (c.type === "input" && s.nodes.some((n) => n.type === "input")) throw Error("Input already exists");
  const n: NodeInstance = { id: uniqueNodeId(s, c.type), type: c.type, name: c.title, config: structuredClone(c.example), position };
  let next = { ...s, nodes: [...s.nodes, n] };
  if (edge) {
    next = disconnect(next, edgeKey(edge));
    next = connect(next, { ...edge, to: n.id });
    next = connect(next, { from: n.id, to: edge.to, port: "out" });
  }
  return next;
}
export function removeNodes(s: AgentSpec, ids: string[]): AgentSpec {
  let next = s;
  for (const id of ids) {
    const n = next.nodes.find((n) => n.id === id);
    if (!n || protectedNode(n)) continue;
    const incoming = next.edges.filter((e) => e.to === id);
    const outgoing = next.edges.filter((e) => e.from === id);
    next = { ...next, nodes: next.nodes.filter((n) => n.id !== id), edges: next.edges.filter((e) => e.from !== id && e.to !== id) };
    if (incoming.length === 1 && outgoing.length === 1 && (incoming[0].port ?? "out") === (outgoing[0].port ?? "out")) {
      try {
        next = connect(next, { from: incoming[0].from, to: outgoing[0].to, port: incoming[0].port });
      } catch {
        /* An existing edge already connects the neighbors. */
      }
    }
  }
  return next;
}
export const updateNode = (s: AgentSpec, id: string, patch: Partial<Omit<NodeInstance, "id" | "type">>): AgentSpec => ({
  ...s,
  nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...patch, ...(protectedNode(n) ? { disabled: false } : {}) } : n)),
});
export const renameNode = renameNodeId;
export const moveNodes = (s: AgentSpec, positions: Record<string, { x: number; y: number }>): AgentSpec => ({
  ...s,
  nodes: s.nodes.map((n) => (positions[n.id] ? { ...n, position: positions[n.id] } : n)),
});
export function setSpecField<K extends keyof AgentSpec>(s: AgentSpec, key: K, value: AgentSpec[K]): AgentSpec {
  return { ...s, [key]: value };
}
export const editSticky = (s: AgentSpec, note: StickyNote): AgentSpec => setCanvas(s, { notes: [...(canvasMeta(s).notes ?? []).filter((n) => n.id !== note.id), note] });
export const deleteSticky = (s: AgentSpec, id: string): AgentSpec => setCanvas(s, { notes: (canvasMeta(s).notes ?? []).filter((n) => n.id !== id) });
export interface ClipboardGraph {
  anvilNodes: NodeInstance[];
  edges: Edge[];
}
export function copyNodes(s: AgentSpec, ids: string[]): ClipboardGraph {
  const nodes = s.nodes.filter((n) => ids.includes(n.id) && !protectedNode(n));
  return { anvilNodes: nodes, edges: s.edges.filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to)) };
}
export function pasteNodes(s: AgentSpec, data: ClipboardGraph, point: { x: number; y: number }): AgentSpec {
  if (!Array.isArray(data.anvilNodes) || !Array.isArray(data.edges)) throw Error("Clipboard has no Anvil steps");
  const nodes = data.anvilNodes.map((n) => NodeInstanceZ.parse(n)).filter((n) => !protectedNode(n));
  const edges = data.edges.map((e) => EdgeZ.parse(e));
  let temp: AgentSpec = { ...s, nodes: structuredClone(nodes), edges: structuredClone(edges) };
  const reserved = [...s.nodes, ...nodes];
  const mapping = nodes.map((n) => {
    const id = uniqueNodeId({ nodes: reserved }, n.id);
    reserved.push({ ...n, id });
    return [n.id, id];
  });
  for (const [old, id] of mapping) temp = renameNodeId(temp, old, id);
  const minX = Math.min(...nodes.map((n) => n.position?.x ?? 0));
  const minY = Math.min(...nodes.map((n) => n.position?.y ?? 0));
  return {
    ...s,
    nodes: [...s.nodes, ...temp.nodes.map((n) => ({ ...n, position: { x: point.x + (n.position?.x ?? 0) - minX, y: point.y + (n.position?.y ?? 0) - minY } }))],
    edges: [...s.edges, ...temp.edges.filter((e) => temp.nodes.some((n) => n.id === e.from) && temp.nodes.some((n) => n.id === e.to))],
  };
}
export const duplicateNodes = (s: AgentSpec, ids: string[]) => {
  const first = s.nodes.find((n) => ids.includes(n.id));
  return pasteNodes(s, copyNodes(s, ids), { x: (first?.position?.x ?? 0) + 40, y: (first?.position?.y ?? 0) + 100 });
};
export interface Snapshot {
  spec: AgentSpec;
  pinData: PinData;
}
export interface EditorState extends Snapshot {
  selection: string[];
  past: Snapshot[];
  future: Snapshot[];
  revision: number;
  savedRevision: number;
  inspection?: Inspection;
  group?: string;
  at: number;
}
export const initialState = (spec: AgentSpec, pinData: PinData = {}): EditorState => ({ spec, pinData, selection: [], past: [], future: [], revision: 0, savedRevision: 0, at: 0 });
export type Action =
  | { type: "edit"; spec: AgentSpec; pinData?: PinData; group?: string; now?: number }
  | { type: "select"; ids: string[] }
  | { type: "undo" | "redo" }
  | { type: "inspect"; value: Inspection }
  | { type: "saved"; revision: number }
  | { type: "rebase"; spec: AgentSpec }
  | { type: "reset"; spec: AgentSpec; pinData?: PinData };
export function reducer(s: EditorState, a: Action): EditorState {
  if (a.type === "select") return { ...s, selection: a.ids };
  if (a.type === "inspect") return { ...s, inspection: a.value };
  if (a.type === "saved") return { ...s, savedRevision: a.revision };
  if (a.type === "rebase") return { ...initialState(a.spec, s.pinData), revision: s.revision + 1, savedRevision: s.savedRevision };
  if (a.type === "reset") return initialState(a.spec, a.pinData);
  if (a.type === "edit") {
    const pinData = a.pinData ?? s.pinData;
    if (stable(s.spec) === stable(a.spec) && stable(pinData) === stable(s.pinData)) return s;
    const at = a.now ?? Date.now();
    const coalesce = !!a.group && a.group === s.group && at - s.at <= 400;
    return {
      ...s,
      spec: a.spec,
      pinData,
      past: coalesce ? s.past : [...s.past, { spec: s.spec, pinData: s.pinData }].slice(-50),
      future: [],
      revision: s.revision + 1,
      at,
      group: a.group,
    };
  }
  const source = a.type === "undo" ? s.past : s.future;
  const target = source.at(-1);
  if (!target) return s;
  return {
    ...s,
    ...target,
    past: a.type === "undo" ? s.past.slice(0, -1) : [...s.past, { spec: s.spec, pinData: s.pinData }].slice(-50),
    future: a.type === "redo" ? s.future.slice(0, -1) : [...s.future, { spec: s.spec, pinData: s.pinData }],
    revision: s.revision + 1,
    group: undefined,
  };
}
export const changesSince = diffSpecs;
