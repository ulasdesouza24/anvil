import { canonicalArgs } from "../context.js";
import { checkEgress, domainAllowed, findSecret, hostOf, hostSecretValues, type EgressPolicy } from "../egress.js";
import type { NodeContext } from "../registry.js";
import type { AgentSpec } from "../types.js";
import { namedUrls } from "../urls.js";
import { getTool } from "./agentTools.js";
import type { Doc } from "./text.js";
import type { SandboxCall, SandboxExecResult } from "../../runtime/sandbox.js";

/**
 * The tool bridge of the sandbox (docs/SANDBOX.md, sections 2.6 and 2.7).
 *
 * A program in the sandbox calls tools with the anvil SDK. Each call comes
 * here, and it goes through the same rules as a call from an agent loop:
 * the tool allowlist, the budgets, robots.txt, the repeat guard, and the
 * approval for side effects. Outbound requests also go through the egress policy.
 */

export interface ProgramOptions {
  /** The agent tools that the program can call. */
  tools: string[];
  docs?: Doc[];
  timeoutMs?: number;
  /** Input data for the program. It is the DATA variable in the program. */
  data?: Record<string, unknown>;
}

export interface EgressRecord {
  tool: string;
  host: string;
  method: string;
  bytes: number;
  decision: "allowed" | "approved" | "blocked" | "rejected";
  reason?: string;
}

export interface ProgramResult extends SandboxExecResult {
  egress: EgressRecord[];
}

/** Tools that send a request to a URL. The egress policy checks them. */
const URL_TOOLS = new Set(["fetch_url", "browse", "http_request"]);

/** The domains that a run can contact: found in search results of this run. They grow while the run works. */
const searchDomains = new Map<string, Set<string>>();
/** The results of the tool calls of each run, for the repeat guard when the harness is off. */
const runCaches = new Map<string, Map<string, string>>();
/** The sandbox time that each run used (milliseconds). */
const runTime = new Map<string, number>();

/**
 * The allowlist of a run: the domains of the source plan, the URLs of the
 * request, the domains that a person approved, and the domains of search
 * results in this run (a page that the agent found is not a place to which it sends data).
 */
/** The fixed part of the allowlist of an agent, in groups: the source plan, the request, and the domains that a person approved. */
export function staticAllowlist(spec: AgentSpec): { plan: string[]; request: string[]; approved: string[] } {
  type Candidate = { candidate: { url?: string } };
  const meta = (spec.meta ?? {}) as { request?: unknown; plan?: { sourcePlan?: { needs?: { primary?: Candidate | null; fallbacks?: Candidate[]; complements?: { source: Candidate }[] }[] } } };
  const plan = new Set<string>();
  for (const n of meta.plan?.sourcePlan?.needs ?? [])
    for (const p of [n.primary, ...(n.fallbacks ?? []), ...(n.complements ?? []).map((c) => c.source)]) if (p?.candidate.url) plan.add(hostOf(p.candidate.url));
  const request = new Set(namedUrls(meta.request, spec.description).map(hostOf));
  const approved = new Set((spec.policy.sandbox?.allowDomains ?? []).map((d) => d.toLowerCase().trim().replace(/^www\./, "")));
  const clean = (x: Set<string>) => [...x].filter(Boolean).sort();
  return { plan: clean(plan), request: clean(request), approved: clean(approved) };
}

export function egressPolicyFor(ctx: NodeContext<any>): EgressPolicy {
  const fixed = staticAllowlist(ctx.spec);
  const allow = new Set<string>([...fixed.plan, ...fixed.request, ...fixed.approved]);
  for (const d of searchDomains.get(ctx.runId) ?? []) allow.add(d);
  allow.delete("");
  return { allowDomains: allow, maxBody: ctx.brain.config.sandbox.egressMaxBody, evaluation: ctx.services.runKind === "eval", secretValues: hostSecretValues() };
}

/** Runs one program of an agent in the sandbox of its run. */
export async function runProgram(ctx: NodeContext<any>, code: string, opts: ProgramOptions): Promise<ProgramResult> {
  const sandbox = ctx.services.sandbox;
  if (!sandbox) throw new Error("The Python sandbox is not available in this Anvil instance");
  const st = await sandbox.status();
  if (!st.available) throw new Error(`The Python sandbox is not available: ${st.reason}`);
  // The time budget of the run: all programs together.
  const budgetMs = Math.min(ctx.spec.policy.sandbox?.maxSeconds ?? Infinity, ctx.brain.config.sandbox.maxSecondsPerRun) * 1000;
  const used = runTime.get(ctx.runId) ?? 0;
  if (used >= budgetMs) throw new Error(`The sandbox time budget of this run is used (${Math.round(budgetMs / 1000)} s)`);
  const egress: EgressRecord[] = [];
  const audit = (r: EgressRecord) => {
    egress.push(r);
    ctx.emit({ type: "artifact", kind: "egress", data: { node: ctx.node.id, ...r } });
  };

  const onCall = async (call: SandboxCall): Promise<unknown> => {
    // Classes of the library: tested, and their endpoints are fixed. The arguments must not hold a secret.
    if (call.tool.startsWith("class:")) {
      const type = call.tool.slice("class:".length);
      const cls = ctx.services.registry.get(type);
      if (!cls?.custom) throw new Error(`"${type}" is not a class of the library. Use one of the x_ classes.`);
      const secret = findSecret(JSON.stringify(call.args), hostSecretValues());
      if (secret) throw new Error(`The arguments contain ${secret}`);
      const parsed = cls.configSchema.safeParse(call.args);
      if (!parsed.success) throw new Error(`Invalid arguments for ${type}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
      const out = await cls.execute({ ...ctx, config: parsed.data as Record<string, unknown>, node: { ...ctx.node, id: `${ctx.node.id}:${type}`, type } });
      ctx.log(`tool ${call.tool}`, { args: call.args, via: "sandbox" });
      return out.output;
    }

    const tool = getTool(call.tool);
    if (!tool || !opts.tools.includes(tool.name)) throw new Error(`The tool "${call.tool}" is not available to this program. Available tools: ${opts.tools.join(", ") || "(none)"}.`);

    if (URL_TOOLS.has(tool.name)) {
      const method = String(call.args.method ?? "GET").toUpperCase();
      const decision = checkEgress({ tool: tool.name, url: String(call.args.url ?? ""), method, body: call.args.body, headers: call.args.headers as Record<string, string> | undefined }, egressPolicyFor(ctx));
      if (!decision.allowed) {
        audit({ tool: tool.name, host: decision.host, method, bytes: decision.bytes, decision: "blocked", reason: decision.reason });
        throw new Error(`Blocked by the egress policy: ${decision.reason}`);
      }
      if (decision.needsApproval) {
        const answer = (await ctx.waitForHuman({
          kind: "approval",
          title: "A program wants to send data",
          message: `${method} ${String(call.args.url)} (${decision.bytes} bytes). Approve only when this request is expected.`,
          payload: { method, url: call.args.url, body: call.args.body },
        })) as { approved?: boolean } | undefined;
        if (!answer?.approved) {
          audit({ tool: tool.name, host: decision.host, method, bytes: decision.bytes, decision: "rejected", reason: "a person rejected the request" });
          throw new Error("A person rejected the request");
        }
        audit({ tool: tool.name, host: decision.host, method, bytes: decision.bytes, decision: "approved" });
      } else audit({ tool: tool.name, host: decision.host, method, bytes: decision.bytes, decision: "allowed" });
    } else {
      // A search query also leaves the host. It must not hold a secret.
      const secret = findSecret(JSON.stringify(call.args), hostSecretValues());
      if (secret) throw new Error(`The arguments contain ${secret}`);
    }

    // The repeat guard: the same call in this run gives the recorded result.
    const key = `${tool.name}|${canonicalArgs(call.args)}`;
    let cache = ctx.harness?.toolCache ?? runCaches.get(ctx.runId);
    if (!cache) runCaches.set(ctx.runId, (cache = new Map()));
    const seen = cache?.get(key);
    if (seen !== undefined) {
      ctx.emit({ type: "artifact", kind: "harness", data: { event: "repeat_blocked", node: ctx.node.id, tool: tool.name } });
      return JSON.parse(seen);
    }
    const value = await tool.run(call.args, ctx, { docs: opts.docs });
    cache.set(key, JSON.stringify(value ?? null));
    ctx.log(`tool ${tool.name}`, { args: call.args, result: JSON.stringify(value ?? null).slice(0, 300), via: "sandbox" });
    if (tool.name === "web_search" && Array.isArray(value)) {
      const set = searchDomains.get(ctx.runId) ?? new Set<string>();
      for (const r of value as { url?: string }[]) if (r?.url) set.add(hostOf(r.url));
      searchDomains.set(ctx.runId, set);
    }
    return value;
  };

  // The allowlist mode: the direct requests of the program get the domain rule of the run.
  sandbox.setEgress(ctx.runId, (host) => {
    const policy = egressPolicyFor(ctx);
    const ok = domainAllowed(host, policy.allowDomains);
    audit({ tool: "direct", host, method: "CONNECT", bytes: 0, decision: ok ? "allowed" : "blocked", reason: ok ? undefined : `the domain ${host} is not on the allowlist of this run` });
    return ok ? { allowed: true } : { allowed: false, reason: `the domain ${host} is not on the allowlist of this run. A person can add it on the Sandbox tab of the agent.` };
  });
  const t0 = Date.now();
  const r = await sandbox.exec(ctx.runId, code, onCall, { timeoutMs: Math.min(opts.timeoutMs ?? ctx.brain.config.sandbox.timeoutMs, budgetMs - used), data: opts.data });
  runTime.set(ctx.runId, used + r.durationMs);
  ctx.brain.recordUsage({ sandboxMs: r.durationMs });
  for (const i of r.installs)
    ctx.emit({ type: "artifact", kind: "package", data: { node: ctx.node.id, packages: i.packages, ok: i.ok, error: i.error, decisions: i.decisions, durationMs: i.durationMs } });
  ctx.emit({
    type: "artifact",
    kind: "code",
    data: {
      node: ctx.node.id,
      code,
      ok: r.ok,
      result: JSON.stringify(r.result ?? null).slice(0, 2000),
      stdout: r.stdout.slice(0, 2000),
      error: r.error,
      timedOut: r.timedOut,
      calls: r.calls.map((c) => ({ tool: c.tool, ok: c.ok, error: c.error, durationMs: c.durationMs })),
      egress,
      installs: r.installs.map((i) => ({ packages: i.packages, ok: i.ok, error: i.error })),
      container: r.container,
      durationMs: Date.now() - t0,
    },
  });
  return { ...r, egress };
}

/** Forgets the search domains of a finished run. */
export function forgetRun(runId: string) {
  searchDomains.delete(runId);
  runCaches.delete(runId);
  runTime.delete(runId);
}
