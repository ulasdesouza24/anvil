import type { AgentSpec, Edge } from "./types.js";

export interface Graph {
  ids: string[];
  incoming: Map<string, Edge[]>;
  outgoing: Map<string, Edge[]>;
}

export function buildGraph(spec: Pick<AgentSpec, "nodes" | "edges">): Graph {
  const ids = spec.nodes.map((n) => n.id);
  const incoming = new Map<string, Edge[]>(ids.map((id) => [id, []]));
  const outgoing = new Map<string, Edge[]>(ids.map((id) => [id, []]));
  for (const e of spec.edges) {
    if (!incoming.has(e.to) || !outgoing.has(e.from)) continue;
    incoming.get(e.to)!.push(e);
    outgoing.get(e.from)!.push(e);
  }
  return { ids, incoming, outgoing };
}

/** Kahn's algorithm. Returns the order and any nodes stuck in cycles. */
export function topoSort(g: Graph): { order: string[]; cyclic: string[] } {
  const indeg = new Map(g.ids.map((id) => [id, g.incoming.get(id)!.length]));
  const queue = g.ids.filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of g.outgoing.get(id)!) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  return { order, cyclic: g.ids.filter((id) => !order.includes(id)) };
}

export function ancestors(g: Graph): Map<string, Set<string>> {
  const memo = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const visit = (id: string): Set<string> => {
    const hit = memo.get(id);
    if (hit) return hit;
    if (visiting.has(id)) return new Set();
    visiting.add(id);
    const set = new Set<string>();
    for (const e of g.incoming.get(id) ?? []) {
      set.add(e.from);
      for (const a of visit(e.from)) set.add(a);
    }
    visiting.delete(id);
    memo.set(id, set);
    return set;
  };
  for (const id of g.ids) visit(id);
  return memo;
}

export function reachableFrom(g: Graph, start: string[]): Set<string> {
  const seen = new Set<string>(start);
  const stack = [...start];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of g.outgoing.get(id) ?? []) {
      if (!seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return seen;
}

export function canReach(g: Graph, targets: string[]): Set<string> {
  const seen = new Set<string>(targets);
  const stack = [...targets];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of g.incoming.get(id) ?? []) {
      if (!seen.has(e.from)) {
        seen.add(e.from);
        stack.push(e.from);
      }
    }
  }
  return seen;
}
