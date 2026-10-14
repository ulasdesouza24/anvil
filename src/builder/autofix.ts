import { NODE_ID, NodeInstanceZ } from "../core/types.js";

/** The fields of a step in the IR. Each other top-level field of a model step is a config field or a leak. */
const NODE_FIELDS = new Set(Object.keys(NodeInstanceZ.shape));
import { wrapBareRefs } from "../core/nodes/codeAgent.js";

export interface AutoFix {
  spec: Record<string, unknown>;
  fixes: string[];
}

function slug(s: string, sep: "-" | "_"): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`^\\${sep}+|\\${sep}+$`, "g"), "");
}

/**
 * Deterministic normalizations applied before validation. They fix common,
 * unambiguous model slips so the (expensive) repair loop only sees real issues.
 */
export interface AutoFixOptions {
  id?: string;
  name?: string;
  /** Valid config keys for a node type (from the registry). Enables precise hoisting. */
  configKeys?: (type: string) => string[] | undefined;
}

export function autoFix(raw: unknown, defaults: AutoFixOptions = {}): AutoFix {
  const fixes: string[] = [];
  const spec = (raw && typeof raw === "object" ? structuredClone(raw) : {}) as Record<string, any>;

  // Unwrap {"spec": {...}} / {"agent": {...}}
  for (const key of ["spec", "agent", "agentSpec", "workflow"]) {
    if (spec[key] && typeof spec[key] === "object" && Array.isArray(spec[key].nodes) && !Array.isArray(spec.nodes)) {
      fixes.push(`unwrapped "${key}"`);
      return autoFix(spec[key], defaults);
    }
  }

  if (spec.specVersion !== "anvil/v1") {
    spec.specVersion = "anvil/v1";
    fixes.push("set specVersion");
  }
  if (typeof spec.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(spec.id)) {
    const next = slug(String(spec.id ?? defaults.id ?? spec.name ?? defaults.name ?? "agent"), "-").slice(0, 60) || "agent";
    fixes.push(`normalized agent id → ${next}`);
    spec.id = next;
  }
  if (!spec.name && defaults.name) spec.name = defaults.name;
  if (typeof spec.version !== "number") spec.version = 1;
  if (!spec.inputSchema || typeof spec.inputSchema !== "object") {
    spec.inputSchema = { type: "object", properties: {} };
    fixes.push("added empty inputSchema");
  } else if (!spec.inputSchema.type && spec.inputSchema.properties) {
    spec.inputSchema.type = "object";
  }

  const nodes: any[] = Array.isArray(spec.nodes) ? spec.nodes : [];
  spec.nodes = nodes;

  // Normalize node ids and remember renames to rewrite references.
  const renames = new Map<string, string>();
  const taken = new Set<string>();
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (n.config === undefined || n.config === null) n.config = {};
    if (typeof n.type === "string") n.type = n.type.trim();
    // Some models put config fields at the top level of the node, or leak
    // planning fields (dependsOn, branch, purpose…) into it.
    const allowed = defaults.configKeys?.(String(n.type));
    for (const k of Object.keys(n)) {
      if (NODE_FIELDS.has(k)) continue;
      if (allowed ? allowed.includes(k) : true) {
        if (n.config[k] === undefined) {
          n.config[k] = n[k];
          fixes.push(`moved "${k}" into config of ${n.id}`);
        }
      } else fixes.push(`dropped non-config field "${k}" from ${n.id}`);
      delete n[k];
    }
    if (allowed) {
      for (const k of ["dependsOn", "branch", "purpose", "inputsFrom", "next"]) {
        if (k in n.config && !allowed.includes(k)) {
          delete n.config[k];
          fixes.push(`dropped planning field "${k}" from ${n.id}.config`);
        }
      }
    }
    const old = String(n.id ?? "");
    let next = old;
    if (!NODE_ID.test(old))
      next =
        slug(old || n.type || "node", "_")
          .replace(/^(\d)/, "n_$1")
          .slice(0, 48) || "node";
    let unique = next;
    for (let i = 2; taken.has(unique); i++) unique = `${next}_${i}`;
    if (unique !== old) {
      renames.set(old, unique);
      fixes.push(`renamed node "${old}" → "${unique}"`);
      n.id = unique;
    }
    taken.add(unique);
  }

  // Edges: accept source/target aliases, "node.port" notation, and drop exact duplicates.
  const edges: any[] = Array.isArray(spec.edges) ? spec.edges : [];
  const seen = new Set<string>();
  spec.edges = [];
  for (const e of edges) {
    if (!e || typeof e !== "object") continue;
    let from = e.from ?? e.source ?? e.fromNode;
    let to = e.to ?? e.target ?? e.toNode;
    let port = e.port ?? e.sourceHandle ?? e.fromPort ?? e.branch ?? e.label ?? undefined;
    if (typeof from === "string" && from.includes(".") && !port) {
      const [f, p] = from.split(".");
      from = f;
      port = p;
    }
    from = renames.get(from) ?? from;
    to = renames.get(to) ?? to;
    if (port === "out" || port === "") port = undefined;
    const edge: Record<string, unknown> = { from, to };
    if (port !== undefined) edge.port = String(port);
    const key = `${from}:${port ?? "out"}->${to}`;
    if (seen.has(key)) {
      fixes.push(`removed duplicate edge ${key}`);
      continue;
    }
    seen.add(key);
    if (e.source || e.target) fixes.push("converted source/target edge keys");
    spec.edges.push(edge);
  }

  if (renames.size) {
    let text = JSON.stringify(spec.nodes);
    for (const [old, next] of renames) {
      const esc = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(new RegExp(`nodes\\.${esc}\\.`, "g"), `nodes.${next}.`);
    }
    spec.nodes = JSON.parse(text);
  }

  // A code_agent task that names data by a plain path gives its program no data. The path becomes a template.
  const ids = new Set(spec.nodes.map((n: { id?: unknown }) => n?.id).filter((x: unknown): x is string => typeof x === "string"));
  for (const n of spec.nodes) {
    if (n?.type !== "code_agent" || typeof n.config?.task !== "string") continue;
    const r = wrapBareRefs(n.config.task, (_path, id) => ids.has(id));
    if (r.wrapped.length) {
      n.config.task = r.text;
      fixes.push(`made the data paths of ${n.id} into templates: ${r.wrapped.join(", ")}`);
    }
  }

  // A template that reads a node through a merge (nodes.<merge>.output.<node>) gets an empty value: a merge with the
  // strategy "first" gives the output of one branch, and "object" has only the nodes with an edge into the merge.
  // The template reads the node itself, so the compiler can also check the rest of the path against its output.
  const mergeIds = spec.nodes.filter((n: { type?: string; id?: unknown }) => n?.type === "merge" && typeof n.id === "string").map((n: { id: string }) => n.id);
  if (mergeIds.length) {
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let text = JSON.stringify(spec.nodes);
    for (const m of mergeIds)
      for (const id of ids as Set<string>) {
        if (id === m) continue;
        const re = new RegExp(`nodes\\.${esc(m)}\\.output\\.${esc(id)}(?![A-Za-z0-9_])`, "g");
        if (re.test(text)) {
          text = text.replace(re, `nodes.${id}.output`);
          fixes.push(`templates read ${id} directly, not through merge ${m}`);
        }
      }
    spec.nodes = JSON.parse(text);
  }

  if (!Array.isArray(spec.tests)) spec.tests = [];
  if (!spec.meta || typeof spec.meta !== "object") spec.meta = {};
  return { spec, fixes: [...new Set(fixes)] };
}
