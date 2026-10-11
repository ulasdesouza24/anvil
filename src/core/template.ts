/**
 * Anvil template language — safe, eval-free data mapping.
 *
 *   {{ input.question }}
 *   {{ nodes.search.output.results[0].title }}
 *   {{ nodes.a.output.text ?? nodes.b.output.text ?? "n/a" }}
 *   {{ nodes.extract.output.items | length }}
 *   {{ nodes.extract.output | json }}
 *   {{ item.name | upper }}             (inside map / per-item fields)
 *
 * A string that is exactly one `{{ }}` expression resolves to the raw value
 * (object, array, number…); otherwise expressions are interpolated as text.
 */

export const TEMPLATE_ROOTS = ["input", "nodes", "item", "index", "vars", "run"] as const;
export type TemplateRoot = (typeof TEMPLATE_ROOTS)[number];

const FILTERS = ["json", "length", "join", "upper", "lower", "first", "last", "trim", "keys", "string", "number"] as const;
type FilterName = (typeof FILTERS)[number];

type Segment = string | number;

interface PathTerm {
  kind: "path";
  root: string;
  segments: Segment[];
}
interface LiteralTerm {
  kind: "literal";
  value: unknown;
}
type Term = PathTerm | LiteralTerm;

export interface ParsedExpr {
  source: string;
  alternatives: Term[];
  filters: { name: FilterName; arg?: string }[];
}

export class TemplateError extends Error {}

const EXPR_RE = /\{\{([\s\S]*?)\}\}/g;
const WHOLE_RE = /^\s*\{\{([\s\S]*?)\}\}\s*$/;

function splitTopLevel(src: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let buf = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      buf += ch;
      if (ch === "\\" && i + 1 < src.length) {
        buf += src[++i];
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (depth === 0 && src.startsWith(sep, i)) {
      out.push(buf);
      buf = "";
      i += sep.length - 1;
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function parseLiteral(s: string): LiteralTerm | null {
  if (/^-?\d+(\.\d+)?$/.test(s)) return { kind: "literal", value: Number(s) };
  if (s === "true") return { kind: "literal", value: true };
  if (s === "false") return { kind: "literal", value: false };
  if (s === "null") return { kind: "literal", value: null };
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const body = s
      .slice(1, -1)
      .replace(/\\(["'\\])/g, "$1")
      .replace(/\\n/g, "\n");
    return { kind: "literal", value: body };
  }
  return null;
}

function parsePath(s: string): PathTerm {
  const m = /^([A-Za-z_$][\w$]*)/.exec(s);
  if (!m) throw new TemplateError(`Invalid reference "${s}"`);
  const root = m[1];
  const segments: Segment[] = [];
  let i = m[0].length;
  while (i < s.length) {
    const ch = s[i];
    if (ch === ".") {
      const seg = /^[A-Za-z_$][\w$-]*/.exec(s.slice(i + 1));
      if (!seg) throw new TemplateError(`Invalid path segment in "${s}"`);
      segments.push(seg[0]);
      i += 1 + seg[0].length;
    } else if (ch === "[") {
      const end = s.indexOf("]", i);
      if (end < 0) throw new TemplateError(`Unclosed [ in "${s}"`);
      const inner = s.slice(i + 1, end).trim();
      if (/^-?\d+$/.test(inner)) segments.push(Number(inner));
      else {
        const lit = parseLiteral(inner);
        if (!lit || typeof lit.value !== "string") throw new TemplateError(`Invalid index [${inner}] in "${s}"`);
        segments.push(lit.value);
      }
      i = end + 1;
    } else {
      throw new TemplateError(`Unexpected "${ch}" in reference "${s}"`);
    }
  }
  return { kind: "path", root, segments };
}

const cache = new Map<string, ParsedExpr>();

export function parseExpr(source: string): ParsedExpr {
  const hit = cache.get(source);
  if (hit) return hit;
  const [head, ...filterParts] = splitTopLevel(source, "|");
  const alternatives = splitTopLevel(head, "??").map((part) => {
    const s = part.trim();
    if (!s) throw new TemplateError(`Empty expression in "{{${source}}}"`);
    return parseLiteral(s) ?? parsePath(s);
  });
  const filters = filterParts.map((raw) => {
    const [name, ...rest] = raw.trim().split(":");
    const fname = name.trim() as FilterName;
    if (!FILTERS.includes(fname)) {
      throw new TemplateError(`Unknown filter "${name.trim()}". Available: ${FILTERS.join(", ")}`);
    }
    const argRaw = rest.join(":").trim();
    const argLit = argRaw ? parseLiteral(argRaw) : null;
    return { name: fname, arg: argLit ? String(argLit.value) : argRaw || undefined };
  });
  const parsed = { source, alternatives, filters };
  cache.set(source, parsed);
  return parsed;
}

export function getPath(obj: unknown, segments: Segment[]): unknown {
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === "number" && Array.isArray(cur)) {
      cur = cur[seg < 0 ? cur.length + seg : seg];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[String(seg)];
    } else if (seg === "length" && typeof cur === "string") {
      cur = cur.length;
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Parse "a.b[0].c" (without root) into segments. */
export function parseDotPath(p: string): Segment[] {
  if (!p) return [];
  return parsePath(`_.${p.replace(/^\./, "")}`.replace("_.[", "_[")).segments;
}

function applyFilter(value: unknown, f: { name: FilterName; arg?: string }): unknown {
  switch (f.name) {
    case "json":
      return JSON.stringify(value ?? null, null, 2);
    case "length":
      if (Array.isArray(value) || typeof value === "string") return value.length;
      if (value && typeof value === "object") return Object.keys(value).length;
      return 0;
    case "join":
      return Array.isArray(value) ? value.map((v) => stringify(v)).join(f.arg ?? ", ") : stringify(value);
    case "upper":
      return stringify(value).toUpperCase();
    case "lower":
      return stringify(value).toLowerCase();
    case "trim":
      return stringify(value).trim();
    case "first":
      return Array.isArray(value) ? value[0] : value;
    case "last":
      return Array.isArray(value) ? value[value.length - 1] : value;
    case "keys":
      return value && typeof value === "object" ? Object.keys(value) : [];
    case "string":
      return stringify(value);
    case "number": {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
  }
}

export function stringify(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, null, 2);
}

export type Scope = Partial<Record<TemplateRoot, unknown>> & Record<string, unknown>;

export function evalExpr(expr: ParsedExpr, scope: Scope): unknown {
  let value: unknown = undefined;
  for (const alt of expr.alternatives) {
    value = alt.kind === "literal" ? alt.value : getPath((scope as Record<string, unknown>)[alt.root], alt.segments);
    if (value !== undefined && value !== null && value !== "") break;
  }
  for (const f of expr.filters) value = applyFilter(value, f);
  return value;
}

export function isTemplate(v: unknown): v is string {
  return typeof v === "string" && v.includes("{{");
}

/** Resolve a template string. Whole-expression strings keep their raw type. */
export function resolveString(template: string, scope: Scope): unknown {
  const whole = WHOLE_RE.exec(template);
  if (whole && !whole[1].includes("{{")) return evalExpr(parseExpr(whole[1].trim()), scope);
  return template.replace(EXPR_RE, (_, inner: string) => stringify(evalExpr(parseExpr(inner.trim()), scope)));
}

/** Deeply resolve templates inside any JSON value. `skipKeys` are left raw at the top level. */
export function resolveDeep(value: unknown, scope: Scope, skipKeys: readonly string[] = []): unknown {
  if (typeof value === "string") return isTemplate(value) ? resolveString(value, scope) : value;
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, scope));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = skipKeys.includes(k) ? v : resolveDeep(v, scope);
    }
    return out;
  }
  return value;
}

export interface TemplateRef {
  /** JSON pointer (relative to the scanned value) where the template lives. */
  pointer: string;
  source: string;
  root: string;
  segments: Segment[];
  /** For root=nodes: the referenced node id. */
  nodeId?: string;
  /** For root=nodes: path after `.output`, e.g. ["items", 0]. */
  fieldPath?: Segment[];
}

export interface TemplateIssue {
  pointer: string;
  source: string;
  message: string;
}

/** Statically extract every reference from a JSON value. */
export function extractRefs(value: unknown, pointer = ""): { refs: TemplateRef[]; issues: TemplateIssue[] } {
  const refs: TemplateRef[] = [];
  const issues: TemplateIssue[] = [];
  const visit = (v: unknown, ptr: string) => {
    if (typeof v === "string") {
      if (!v.includes("{{")) return;
      const open = (v.match(/\{\{/g) ?? []).length;
      const close = (v.match(/\}\}/g) ?? []).length;
      if (open !== close) issues.push({ pointer: ptr, source: v, message: "Unbalanced {{ }} in template" });
      for (const m of v.matchAll(EXPR_RE)) {
        const inner = m[1].trim();
        try {
          const parsed = parseExpr(inner);
          for (const alt of parsed.alternatives) {
            if (alt.kind !== "path") continue;
            const ref: TemplateRef = { pointer: ptr, source: inner, root: alt.root, segments: alt.segments };
            if (alt.root === "nodes") {
              ref.nodeId = typeof alt.segments[0] === "string" ? alt.segments[0] : undefined;
              if (alt.segments[1] === "output") ref.fieldPath = alt.segments.slice(2);
            }
            refs.push(ref);
          }
        } catch (e) {
          issues.push({ pointer: ptr, source: inner, message: (e as Error).message });
        }
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => visit(x, `${ptr}/${i}`));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) visit(x, `${ptr}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`);
    }
  };
  visit(value, pointer);
  return { refs, issues };
}
