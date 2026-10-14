import type { AgentSpec, Edge, NodeInstance } from "@core/types";
import { diffSpecs, edgeKey, type SpecDiff } from "@core/workflow";
import { autoLayout } from "./layout";

export type DiffMark = "added" | "removed" | "changed" | "same";

export interface DiffNode {
  node: NodeInstance;
  mark: DiffMark;
  /** For a changed step: its changed fields. */
  fields: string[];
}

export interface DiffEdge {
  edge: Edge;
  mark: "added" | "removed" | "same";
}

export interface DiffView {
  diff: SpecDiff;
  nodes: DiffNode[];
  edges: DiffEdge[];
}

/**
 * Gives a position to each step without one: next to the first neighbor that has a position
 * (right of a step before it, or left of a step after it). Dagre places the rest.
 */
export function placeNew(spec: AgentSpec): AgentSpec {
  if (spec.nodes.every((n) => n.position)) return spec;
  const pos = new Map(spec.nodes.filter((n) => n.position).map((n) => [n.id, n.position!]));
  const used = new Set([...pos.values()].map((p) => `${Math.round(p.x / 40)}:${Math.round(p.y / 40)}`));
  const free = (p: { x: number; y: number }) => {
    let q = p;
    while (used.has(`${Math.round(q.x / 40)}:${Math.round(q.y / 40)}`)) q = { x: q.x, y: q.y + 120 };
    used.add(`${Math.round(q.x / 40)}:${Math.round(q.y / 40)}`);
    return q;
  };
  // Steps in edge order, so a chain of new steps grows from its placed start.
  for (let pass = 0; pass < spec.nodes.length; pass++) {
    let placed = false;
    for (const n of spec.nodes) {
      if (pos.has(n.id)) continue;
      const before = spec.edges.find((e) => e.to === n.id && pos.has(e.from));
      const after = spec.edges.find((e) => e.from === n.id && pos.has(e.to));
      if (before) pos.set(n.id, free({ x: pos.get(before.from)!.x + 300, y: pos.get(before.from)!.y }));
      else if (after) pos.set(n.id, free({ x: pos.get(after.to)!.x - 300, y: pos.get(after.to)!.y }));
      else continue;
      placed = true;
    }
    if (!placed) break;
  }
  const next = { ...spec, nodes: spec.nodes.map((n) => (pos.has(n.id) ? { ...n, position: pos.get(n.id) } : n)) };
  return next.nodes.every((n) => n.position) ? next : autoLayout(next, true);
}

/** The steps and edges of next, with the removed steps and edges of base as ghosts at their old place. */
export function diffView(base: AgentSpec, next: AgentSpec): DiffView {
  const diff = diffSpecs(base, next);
  const changed = new Map(diff.changed.map((c) => [c.id, c.fields]));
  const added = new Set(diff.added);
  const removed = new Set(diff.removed);
  const nodes: DiffNode[] = next.nodes.map((n) => ({
    node: n,
    mark: added.has(n.id) ? "added" : changed.has(n.id) ? "changed" : "same",
    fields: changed.get(n.id) ?? [],
  }));
  for (const n of base.nodes) if (removed.has(n.id)) nodes.push({ node: n, mark: "removed", fields: [] });
  const addedEdges = new Set(diff.edgesAdded.map(edgeKey));
  const edges: DiffEdge[] = [
    ...next.edges.map((e) => ({ edge: e, mark: addedEdges.has(edgeKey(e)) ? ("added" as const) : ("same" as const) })),
    ...diff.edgesRemoved.map((e) => ({ edge: e, mark: "removed" as const })),
  ];
  return { diff, nodes, edges };
}

/** A short count of a diff, for a banner: "2 added · 1 removed · 3 changed". */
export function diffSummary(d: SpecDiff): string {
  const parts = [
    d.added.length && `${d.added.length} added`,
    d.removed.length && `${d.removed.length} removed`,
    d.changed.length && `${d.changed.length} changed`,
    d.edgesAdded.length + d.edgesRemoved.length && `${d.edgesAdded.length + d.edgesRemoved.length} connection change(s)`,
    d.fields.length && `settings: ${d.fields.join(", ")}`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No change";
}

/** The parts of two specs that differ, for the JSON view: the changed steps and the changed fields. */
export function changedParts(base: AgentSpec, next: AgentSpec): { before: unknown; after: unknown } {
  const d = diffSpecs(base, next);
  const ids = new Set([...d.added, ...d.removed, ...d.changed.map((c) => c.id)]);
  const pick = (s: AgentSpec) => ({
    nodes: s.nodes.filter((n) => ids.has(n.id)),
    edges: s.edges.filter((e) => [...d.edgesAdded, ...d.edgesRemoved].some((x) => edgeKey(x) === edgeKey(e))),
    ...Object.fromEntries(d.fields.map((f) => [f, s[f as keyof AgentSpec]])),
  });
  return { before: pick(base), after: pick(next) };
}

/** A plain description of a workflow in execution order, made in the browser (no AI call). */
export function explainWorkflow(spec: AgentSpec, titles: Record<string, string> = {}): string {
  const inc = new Map<string, number>();
  for (const n of spec.nodes) inc.set(n.id, 0);
  for (const e of spec.edges) inc.set(e.to, (inc.get(e.to) ?? 0) + 1);
  const order: string[] = [];
  const queue = spec.nodes.filter((n) => !inc.get(n.id)).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of spec.edges.filter((x) => x.from === id)) {
      inc.set(e.to, (inc.get(e.to) ?? 1) - 1);
      if (inc.get(e.to) === 0) queue.push(e.to);
    }
  }
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  const fields = Object.keys(spec.inputSchema?.properties ?? {});
  lines.push(`${spec.name}${spec.description ? `: ${spec.description}` : ""}`);
  lines.push(fields.length ? `It takes the input fields ${fields.join(", ")}.` : "It takes no input fields.");
  for (const t of spec.triggers ?? [])
    lines.push(
      `Trigger ${t.id} (${t.type}${t.type === "schedule" ? `, ${t.cron ?? `every ${t.every}`}` : ""}) starts it${t.enabled === false ? " when a person turns it on" : ""}.`,
    );
  let i = 1;
  for (const id of order) {
    const n = byId.get(id);
    if (!n || n.type === "input") continue;
    const outs = spec.edges.filter((e) => e.from === id);
    const branches = outs.filter((e) => e.port && e.port !== "out");
    const what = n.description || titles[n.type] || n.type;
    let line = `${i++}. ${n.name || n.id} (${n.type}): ${what.replace(/[.!?]?\s*$/, ".")}`;
    if (n.disabled) line += " This step is off.";
    if (n.locked) line += " A person locked this step.";
    if (branches.length) line += ` Then: ${branches.map((e) => `${e.port} → ${byId.get(e.to)?.name || e.to}`).join(", ")}.`;
    lines.push(line);
  }
  return lines.join("\n");
}
