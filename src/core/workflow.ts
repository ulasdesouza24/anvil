import { NODE_ID, type AgentSpec, type Edge, type NodeInstance } from "./types.js";

/**
 * Pure helpers of the workflow editor (docs/WORKFLOW_EDITOR.md). The server and the web UI use the same code:
 * rename a step, compare two specs, merge a draft with a newer version, and keep locked steps.
 * This module imports only types, so the browser can load it.
 */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The fields of a step that a lock keeps. The position and the notes of a person can change. */
function lockedContent(n: NodeInstance): string {
  const { position: _p, notes: _n, locked: _l, ...rest } = n;
  return stable(rest);
}

/** JSON with sorted keys: two equal values give the same text. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export const edgeKey = (e: Edge) => `${e.from}:${e.port ?? "out"}->${e.to}`;

/**
 * Renames a step and changes each reference to it: edges, templates ({{nodes.old.…}}), and
 * references in code (nodes.old.output, nodes["old"]). Gives an error for a bad or a used id.
 */
export function renameNodeId(spec: AgentSpec, oldId: string, nextId: string): AgentSpec {
  if (oldId === nextId) return spec;
  if (!NODE_ID.test(nextId)) throw new Error(`"${nextId}" is not a valid step id: use snake_case, start with a letter, max 48 characters`);
  if (!spec.nodes.some((n) => n.id === oldId)) throw new Error(`No step "${oldId}"`);
  if (spec.nodes.some((n) => n.id === nextId)) throw new Error(`The id "${nextId}" is already used`);
  const dot = new RegExp(`(\\bnodes\\s*\\.\\s*)${esc(oldId)}(?![A-Za-z0-9_])`, "g");
  const bracket = new RegExp(`(\\bnodes\\s*\\[\\s*)(["'])${esc(oldId)}\\2`, "g");
  const rewrite = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(dot, `$1${nextId}`).replace(bracket, `$1$2${nextId}$2`);
    if (Array.isArray(v)) return v.map(rewrite);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x)]));
    return v;
  };
  return {
    ...spec,
    nodes: spec.nodes.map((n) => ({ ...(rewrite(n) as NodeInstance), id: n.id === oldId ? nextId : n.id, type: n.type })),
    edges: spec.edges.map((e) => ({ ...e, from: e.from === oldId ? nextId : e.from, to: e.to === oldId ? nextId : e.to })),
  };
}

/** A free step id from a base: "summary", "summary_2", … */
export function uniqueNodeId(spec: Pick<AgentSpec, "nodes">, base: string): string {
  let clean = base
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 40);
  if (!clean) clean = "step";
  const used = new Set(spec.nodes.map((n) => n.id));
  if (!used.has(clean)) return clean;
  for (let i = 2; ; i++) if (!used.has(`${clean}_${i}`)) return `${clean}_${i}`;
}

export interface SpecDiff {
  added: string[];
  removed: string[];
  /** Steps with a different content. fields: the changed top-level fields of the step. */
  changed: { id: string; fields: string[] }[];
  /** Steps that only moved on the canvas. */
  moved: string[];
  edgesAdded: Edge[];
  edgesRemoved: Edge[];
  /** Changed top-level fields of the spec (inputSchema, policy, triggers, …). */
  fields: string[];
}

const SPEC_FIELDS = ["name", "description", "inputSchema", "outputSchema", "policy", "triggers", "acceptance", "tests"] as const;

export function diffSpecs(a: AgentSpec, b: AgentSpec): SpecDiff {
  const am = new Map(a.nodes.map((n) => [n.id, n]));
  const bm = new Map(b.nodes.map((n) => [n.id, n]));
  const d: SpecDiff = { added: [], removed: [], changed: [], moved: [], edgesAdded: [], edgesRemoved: [], fields: [] };
  for (const n of b.nodes) if (!am.has(n.id)) d.added.push(n.id);
  for (const n of a.nodes) {
    const m = bm.get(n.id);
    if (!m) {
      d.removed.push(n.id);
      continue;
    }
    const keys = new Set([...Object.keys(n), ...Object.keys(m)]);
    const fields = [...keys].filter((k) => k !== "position" && stable((n as Record<string, unknown>)[k]) !== stable((m as Record<string, unknown>)[k]));
    if (fields.length) d.changed.push({ id: n.id, fields });
    else if (stable(n.position) !== stable(m.position)) d.moved.push(n.id);
  }
  const ak = new Set(a.edges.map(edgeKey));
  const bk = new Set(b.edges.map(edgeKey));
  d.edgesAdded = b.edges.filter((e) => !ak.has(edgeKey(e)));
  d.edgesRemoved = a.edges.filter((e) => !bk.has(edgeKey(e)));
  for (const f of SPEC_FIELDS) if (stable(a[f]) !== stable(b[f])) d.fields.push(f);
  return d;
}

export const diffIsEmpty = (d: SpecDiff) =>
  !d.added.length && !d.removed.length && !d.changed.length && !d.moved.length && !d.edgesAdded.length && !d.edgesRemoved.length && !d.fields.length;

export interface MergeResult {
  spec: AgentSpec;
  /** Steps and spec fields that both sides changed in different ways. The merge keeps "ours" for them. */
  conflicts: { kind: "node" | "field"; id: string }[];
}

/**
 * A three-way merge by step id: base is the version that the draft started from, ours is the draft,
 * theirs is the newer saved version. A change of one side wins. When both sides change the same step
 * or field in different ways, the merge keeps ours and reports a conflict.
 */
export function mergeSpecs(base: AgentSpec, ours: AgentSpec, theirs: AgentSpec): MergeResult {
  const conflicts: MergeResult["conflicts"] = [];
  const pick = <T>(kind: "node" | "field", id: string, b: T | undefined, o: T | undefined, t: T | undefined): T | undefined => {
    const sb = stable(b);
    const so = stable(o);
    const st = stable(t);
    if (so === st) return o;
    if (so === sb) return t;
    if (st === sb) return o;
    conflicts.push({ kind, id });
    return o;
  };
  const bm = new Map(base.nodes.map((n) => [n.id, n]));
  const om = new Map(ours.nodes.map((n) => [n.id, n]));
  const tm = new Map(theirs.nodes.map((n) => [n.id, n]));
  const order = [...ours.nodes.map((n) => n.id), ...theirs.nodes.map((n) => n.id).filter((id) => !om.has(id))];
  const nodes: NodeInstance[] = [];
  for (const id of order) {
    const n = pick("node", id, bm.get(id), om.get(id), tm.get(id));
    if (n) nodes.push(n);
  }
  const keep = new Set(nodes.map((n) => n.id));
  const bk = new Set(base.edges.map(edgeKey));
  const ok = new Map(ours.edges.map((e) => [edgeKey(e), e]));
  const tk = new Map(theirs.edges.map((e) => [edgeKey(e), e]));
  const edges: Edge[] = [];
  for (const [k, e] of new Map([...ok, ...tk])) {
    const inO = ok.has(k);
    const inT = tk.has(k);
    // An edge stays when both sides have it, or when one side added it. A removal of one side wins.
    const stays = (inO && inT) || (!bk.has(k) && (inO || inT));
    if (stays && keep.has(e.from) && keep.has(e.to)) edges.push(e);
  }
  const spec: AgentSpec = { ...ours, nodes, edges, version: theirs.version };
  for (const f of SPEC_FIELDS) (spec as Record<string, unknown>)[f] = pick("field", f, base[f], ours[f], theirs[f]);
  return { spec, conflicts };
}

/** The locked steps of before that after removed or changed (the position and the notes do not count). */
export function lockedViolations(before: AgentSpec, after: AgentSpec): string[] {
  const am = new Map(after.nodes.map((n) => [n.id, n]));
  return before.nodes.filter((n) => n.locked && (!am.get(n.id) || lockedContent(am.get(n.id)!) !== lockedContent(n))).map((n) => n.id);
}

/** Puts each locked step of before back into after, as it was. Edges do not change. */
export function restoreLocked(before: AgentSpec, after: AgentSpec): AgentSpec {
  const locked = new Map(before.nodes.filter((n) => n.locked).map((n) => [n.id, n]));
  if (!locked.size) return after;
  const present = new Set(after.nodes.map((n) => n.id));
  return {
    ...after,
    nodes: [...after.nodes.map((n) => locked.get(n.id) ?? n), ...[...locked.values()].filter((n) => !present.has(n.id))],
  };
}

/** Gives each step of after that has no position the position of the same step in before (the builder does not keep the layout). */
export function carryLayout(before: Pick<AgentSpec, "nodes">, after: AgentSpec): AgentSpec {
  const pos = new Map(before.nodes.filter((n) => n.position).map((n) => [n.id, n.position]));
  if (!pos.size) return after;
  return { ...after, nodes: after.nodes.map((n) => (n.position || !pos.has(n.id) ? n : { ...n, position: pos.get(n.id) })) };
}

/** The spec without canvas positions: the model does not need them, and they cost tokens. */
export function withoutLayout(spec: AgentSpec): AgentSpec {
  return { ...spec, nodes: spec.nodes.map(({ position: _p, ...n }) => n) };
}

/** The ancestors of a step (the steps with a path of edges to it). */
export function ancestorsOf(spec: Pick<AgentSpec, "edges">, id: string): Set<string> {
  const inc = new Map<string, string[]>();
  for (const e of spec.edges) inc.set(e.to, [...(inc.get(e.to) ?? []), e.from]);
  const out = new Set<string>();
  const queue = [id];
  while (queue.length)
    for (const p of inc.get(queue.shift()!) ?? []) {
      if (out.has(p)) continue;
      out.add(p);
      queue.push(p);
    }
  return out;
}

/** True when a new edge from → to makes a cycle. */
export function makesCycle(spec: Pick<AgentSpec, "edges">, from: string, to: string): boolean {
  return from === to || ancestorsOf(spec, from).has(to);
}
