import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSWASMModule } from "quickjs-emscripten";

/** The QuickJS engine (WebAssembly). It loads one time, and each code run gets a new runtime. */
let quickjs: QuickJSWASMModule | undefined;
/** Resolves when the code sandbox is ready. createAnvil waits for it, so each run can use runSandboxed at once. */
export const sandboxReady: Promise<void> = getQuickJS().then((q) => {
  quickjs = q;
});

/* ------------------------------ BM25 search ------------------------------ */

export interface Doc {
  id: string;
  title?: string;
  text: string;
}

const STOP = new Set(
  "a an and are as at be by for from has have in is it its of on or that the to was were will with this these those what which who how why when where do does did can could should would i you we they he she not no yes ve ile bir bu şu da de mi mı için gibi".split(
    " ",
  ),
);

export function tokenize(s: string): string[] {
  return s
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

/** Light suffix stripping so "refunds"/"refunded"/"refunding" match "refund". */
function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 4 && /(sh|ch|x|ss)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export function chunkDocs(docs: Doc[], chunkSize: number): Doc[] {
  const out: Doc[] = [];
  for (const d of docs) {
    if (d.text.length <= chunkSize) {
      out.push(d);
      continue;
    }
    const paras = d.text.split(/\n\s*\n/);
    let buf = "";
    let n = 0;
    const flush = () => {
      if (buf.trim()) out.push({ id: `${d.id}#${n++}`, title: d.title, text: buf.trim() });
      buf = "";
    };
    for (const p of paras) {
      if ((buf + "\n\n" + p).length > chunkSize && buf) flush();
      if (p.length > chunkSize) {
        for (let i = 0; i < p.length; i += chunkSize) {
          buf = p.slice(i, i + chunkSize);
          flush();
        }
      } else buf = buf ? `${buf}\n\n${p}` : p;
    }
    flush();
  }
  return out;
}

export function bm25(docs: Doc[], query: string, topK = 5): (Doc & { score: number })[] {
  const k1 = 1.4;
  const b = 0.75;
  const toks = docs.map((d) => tokenize(`${d.title ?? ""} ${d.text}`));
  const avgLen = toks.reduce((s, t) => s + t.length, 0) / Math.max(1, toks.length);
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const q = [...new Set(tokenize(query))];
  const N = docs.length;
  return docs
    .map((d, i) => {
      const tf = new Map<string, number>();
      for (const w of toks[i]) tf.set(w, (tf.get(w) ?? 0) + 1);
      let score = 0;
      for (const w of q) {
        const f = tf.get(w);
        if (!f) continue;
        const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
        score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * toks[i].length) / avgLen));
      }
      return { ...d, score: Math.round(score * 1000) / 1000 };
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function normalizeDocs(raw: unknown): Doc[] {
  if (raw === undefined || raw === null || raw === "") return [];
  if (typeof raw === "string") return [{ id: "doc0", text: raw }];
  if (!Array.isArray(raw)) {
    if (typeof raw === "object") {
      return Object.entries(raw as Record<string, unknown>).map(([k, v]) => ({ id: k, title: k, text: typeof v === "string" ? v : JSON.stringify(v) }));
    }
    return [{ id: "doc0", text: String(raw) }];
  }
  return raw.map((d, i) => {
    if (typeof d === "string") return { id: `doc${i}`, text: d };
    const o = (d ?? {}) as Record<string, unknown>;
    const text = String(o.text ?? o.content ?? o.body ?? JSON.stringify(o));
    return { id: String(o.id ?? `doc${i}`), title: o.title ? String(o.title) : undefined, text };
  });
}

/* ---------------------------- Safe calculator ---------------------------- */

/** Evaluates arithmetic without eval: numbers, + - * / % ^, parentheses, and a few functions. */
export function calculate(expr: string): number {
  const src = expr.replace(/\s+/g, "");
  let i = 0;
  const FUNCS: Record<string, (...a: number[]) => number> = {
    sqrt: Math.sqrt,
    abs: Math.abs,
    round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
    floor: Math.floor,
    ceil: Math.ceil,
    log: Math.log10,
    ln: Math.log,
    exp: Math.exp,
    min: Math.min,
    max: Math.max,
    pow: Math.pow,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
  };
  const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };
  const peek = () => src[i];
  const expect = (c: string) => {
    if (src[i] !== c) throw new Error(`Expected "${c}" at ${i} in "${expr}"`);
    i++;
  };
  const parseExpr = (): number => {
    let v = parseTerm();
    while (peek() === "+" || peek() === "-") v = src[i++] === "+" ? v + parseTerm() : v - parseTerm();
    return v;
  };
  const parseTerm = (): number => {
    let v = parseFactor();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = src[i++];
      const r = parseFactor();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const parseFactor = (): number => {
    const base = parseUnary();
    if (peek() === "^") {
      i++;
      return base ** parseFactor();
    }
    return base;
  };
  const parseUnary = (): number => {
    if (peek() === "-") {
      i++;
      return -parseUnary();
    }
    if (peek() === "+") {
      i++;
      return parseUnary();
    }
    return parseAtom();
  };
  const parseAtom = (): number => {
    if (peek() === "(") {
      i++;
      const v = parseExpr();
      expect(")");
      return v;
    }
    const num = /^\d+(\.\d+)?(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      if (peek() === "%") {
        // percentage literal like 15% → 0.15 only when followed by nothing numeric
        const next = src[i + 1];
        if (next === undefined || /[)+\-*/^,]/.test(next)) {
          i++;
          return Number(num[0]) / 100;
        }
      }
      return Number(num[0]);
    }
    const id = /^[a-z_]+/i.exec(src.slice(i));
    if (id) {
      const name = id[0].toLowerCase();
      i += id[0].length;
      if (name in CONSTS) return CONSTS[name];
      const fn = FUNCS[name];
      if (!fn) throw new Error(`Unknown function "${name}"`);
      expect("(");
      const args: number[] = [];
      if (peek() !== ")") {
        args.push(parseExpr());
        while (peek() === ",") {
          i++;
          args.push(parseExpr());
        }
      }
      expect(")");
      return fn(...args);
    }
    throw new Error(`Unexpected "${peek() ?? "end"}" at ${i} in "${expr}"`);
  };
  const v = parseExpr();
  if (i < src.length) throw new Error(`Unexpected "${src[i]}" at ${i} in "${expr}"`);
  return v;
}

/* ------------------------------ JS sandbox ------------------------------- */

/** The code of a code step runs synchronously, without the network. The reason when the code uses async features, else null. */
export function asyncCodeProblem(code: string): string | null {
  const features: [RegExp, string][] = [
    [/\basync\b/, "async"],
    [/\bawait\b/, "await"],
    [/\bfetch\s*\(/, "fetch"],
    [/\bnew\s+Promise\b/, "a promise"],
    [/\.then\s*\(/, "a promise"],
    [/\bsetTimeout\s*\(/, "a timer"],
  ];
  const found = features.find(([re]) => re.test(code));
  return found
    ? `The code uses ${found[1]}. Code runs synchronously and has no network: do not use async, await, promises, timers, or fetch. Get web data with an http node or an http class, and give it to the code.`
    : null;
}

/** The most memory that one code run can use. */
const CODE_MEMORY_BYTES = 64 * 1024 * 1024;
const PROMISE_MARK = "__anvil_promise__";

/**
 * Runs user or agent JS in QuickJS (WebAssembly): a separate engine with no access to Node, the file system,
 * the network, or the process. This is a real security boundary, so a hosted Anvil can run code of its users.
 * The bindings and the result cross the boundary as JSON. The run stops at the time limit and the memory limit.
 */
export function runSandboxed(code: string, bindings: Record<string, unknown>, timeoutMs = 2000): unknown {
  if (!quickjs) throw new Error("The code sandbox is not ready yet: wait for sandboxReady");
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(CODE_MEMORY_BYTES);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
  const vm = runtime.newContext();
  try {
    const data = vm.newString(JSON.stringify(bindings ?? {}));
    vm.setProp(vm.global, "__anvil_bindings", data);
    data.dispose();
    const program = `(() => {
      const __b = JSON.parse(globalThis.__anvil_bindings);
      delete globalThis.__anvil_bindings;
      for (const __k of Object.keys(__b)) globalThis[__k] = __b[__k];
      globalThis.console = { log() {}, warn() {}, error() {} };
      const __r = (function(){ "use strict"; ${code}\n})();
      if (__r && typeof __r.then === "function") return ${JSON.stringify(PROMISE_MARK)};
      return JSON.stringify(__r === undefined ? null : __r);
    })()`;
    const result = vm.evalCode(program, "code.js");
    if (result.error) {
      const err = vm.dump(result.error) as { message?: string; name?: string } | string;
      result.error.dispose();
      const message = typeof err === "string" ? err : `${err?.name && err.name !== "Error" ? `${err.name}: ` : ""}${err?.message ?? "the code failed"}`;
      if (/interrupted/i.test(message)) throw new Error(`Script execution timed out after ${timeoutMs}ms`);
      if (/out of memory/i.test(message)) throw new Error("The code used more than 64 MB of memory");
      throw new Error(message);
    }
    const text = vm.getString(result.value);
    result.value.dispose();
    if (text === PROMISE_MARK)
      throw new Error(asyncCodeProblem(code) ?? "The code returned a promise. Code runs synchronously: do not use async, await, promises, or fetch.");
    return text === undefined ? null : JSON.parse(text);
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
