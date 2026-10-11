import type { LiveConfig } from "./config.js";
import { liveFetch } from "./liveFetch.js";
import { runSandboxed } from "./tools/text.js";

/**
 * Call adapters for given tools (docs/TOOLS.md). A tool from a function definition has
 * no URL of its own: an adapter does the real call. Only this layer depends on the
 * platform that gives the tools, so a new platform needs only a new adapter.
 */
export interface ToolCall {
  /** The name of the tool, as the definition gives it. */
  name: string;
  args: Record<string, unknown>;
  /** The URL for the http adapter (the endpoint of the tool, or the base URL of the config). */
  endpoint?: string;
  /** For the mock adapter: a JS body with `args` and `state`. It returns the result. */
  mock?: string;
  runId?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  live: LiveConfig;
}

export type ToolAdapter = (call: ToolCall) => Promise<unknown>;

const adapters = new Map<string, ToolAdapter>();

export function registerToolAdapter(name: string, adapter: ToolAdapter) {
  adapters.set(name, adapter);
}

export function toolAdapter(name: string): ToolAdapter {
  const a = adapters.get(name);
  if (!a) throw new Error(`No tool adapter "${name}". Known adapters: ${[...adapters.keys()].join(", ")}`);
  return a;
}

/** http: POST <endpoint> with the arguments as JSON. Without an endpoint of its own, the tool uses <base>/<name>. */
registerToolAdapter("http", async (call) => {
  if (!call.endpoint) throw new Error(`The tool "${call.name}" has no endpoint. Set ANVIL_TOOL_ENDPOINT or give the tool an endpoint.`);
  const res = await liveFetch(
    call.endpoint,
    { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(call.args), timeoutMs: call.timeoutMs, signal: call.signal },
    call.live,
  );
  let body: unknown = res.text;
  try {
    body = JSON.parse(res.text);
  } catch {
    /* keep the text */
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from the tool "${call.name}": ${res.text.slice(0, 300)}`);
  return body;
});

/** The state of the mock tools of each run: a mock tool can change it (for example a booking). */
const mockState = new Map<string, Record<string, unknown>>();

export function mockStateOf(runId: string): Record<string, unknown> {
  let s = mockState.get(runId);
  if (!s) {
    s = {};
    mockState.set(runId, s);
    // Old runs do not keep their state for ever.
    if (mockState.size > 500) mockState.delete(mockState.keys().next().value!);
  }
  return s;
}

/** mock: runs the JS body of the tool with `args` and the `state` of the run. Without a body, it gives back the arguments. */
registerToolAdapter("mock", async (call) => {
  if (!call.mock) return { ok: true, tool: call.name, args: call.args };
  const state = mockStateOf(call.runId ?? "default");
  // The sandbox gets a copy of the state. The result has the new state in __state when the mock changes it.
  const out = runSandboxed(`const state = __state; const result = (function(){ ${call.mock}\n})(); return { result, state };`, { args: call.args, __state: state }, call.timeoutMs) as { result: unknown; state: Record<string, unknown> };
  Object.assign(state, out.state);
  for (const k of Object.keys(state)) if (!(k in out.state)) delete state[k];
  return out.result ?? null;
});
