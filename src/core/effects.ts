import crypto from "node:crypto";
import { canonicalArgs } from "./context.js";
import type { NodeContext } from "./registry.js";

/**
 * The effect record (docs/EFFECTS.md). An action with a side effect (an email, a Slack message, a webhook,
 * a POST of a class) runs one time for each run:
 *  - The key of an action is the root run, the step, the class, the resolved arguments, and the place of the
 *    call among the same calls of this execution (the first, the second, ...). A run that starts again after a
 *    restart makes its calls in the same order, so it finds the keys of its earlier calls. An agent that does
 *    the same action two times on purpose makes two keys.
 *  - A done action gives its recorded result again and does not go out a second time.
 *  - An action that started but has no clear result (a crash, a timeout, an HTTP 5xx) does not go out again.
 *    The step fails with a clear message, so a person can check the receiver.
 *  - An action that did not go out (NotSentError) leaves no record, and a retry can send it.
 * An evaluation run keeps no record, because its tests use mock tools and dry runs. A call outside the engine
 * (no ctx.effects) keeps no record.
 */

export const EFFECTS_NS = "effects";

interface EffectEntry {
  status: "started" | "done";
  at: number;
  type: string;
  nodeId: string;
  runId: string;
  output?: unknown;
}

/** An error that shows that the action did not go out: a retry cannot send it two times. */
export class NotSentError extends Error {
  readonly notSent = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NotSentError";
  }
}

export const isNotSent = (e: unknown): boolean => !!e && typeof e === "object" && (e as { notSent?: unknown }).notSent === true;

/** Network errors that come before a request goes out. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ECONNECTION", "EDNS", "UND_ERR_CONNECT_TIMEOUT"]);

/** True when the error shows that the request did not reach the receiver. */
export function sentNothing(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && typeof x === "object" && i < 4; x = (x as { cause?: unknown }).cause, i++) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === "string" && NOT_SENT_CODES.has(code)) return true;
  }
  return false;
}

export function effectKey(rootRunId: string, nodeId: string, type: string, args: unknown, occurrence = 0): string {
  return crypto
    .createHash("sha256")
    .update(`${rootRunId}\n${nodeId}\n${type}\n${canonicalArgs(args ?? null)}\n${occurrence}`)
    .digest("hex");
}

let writes = 0;

async function prune(ctx: NodeContext<unknown>, ttlMs: number) {
  const all = (await ctx.services.kv.list(EFFECTS_NS)) as Record<string, EffectEntry>;
  const old = Date.now() - ttlMs;
  for (const [k, v] of Object.entries(all)) if (!v?.at || v.at < old) await ctx.services.kv.delete(EFFECTS_NS, k);
}

/**
 * Runs one action with a side effect under the effect record. The engine reads ctx.effects:
 * a step that did an action does not run again after an error.
 */
export async function runEffect<T>(ctx: NodeContext<unknown>, type: string, args: unknown, fn: () => Promise<T>): Promise<T> {
  const counter = ctx.effects;
  if (!counter?.seq || !ctx.node) return fn();
  const eval_ = ctx.services.runKind === "eval";
  const base = `${ctx.node.id}\n${type}\n${canonicalArgs(args ?? null)}`;
  const occurrence = counter.seq.get(base) ?? 0;
  counter.seq.set(base, occurrence + 1);
  const key = effectKey(ctx.services.rootRunId ?? ctx.runId, ctx.node.id, type, args, occurrence);
  if (!eval_) {
    const prior = (await ctx.services.kv.get(EFFECTS_NS, key)) as EffectEntry | undefined;
    if (prior?.status === "done") {
      ctx.log(`${type}: this action is already done in this run. Anvil gives the recorded result and does not do it again.`, { key: key.slice(0, 12) }, "warn");
      return prior.output as T;
    }
    if (prior?.status === "started") {
      counter.ran++;
      throw new Error(
        `${type}: an earlier call of this action in this run started but did not give a clear result. Anvil does not do it again, because the receiver can have it already. Check the receiver, then start a new run.`,
      );
    }
    await ctx.services.kv.set(EFFECTS_NS, key, { status: "started", at: Date.now(), type, nodeId: ctx.node.id, runId: ctx.runId } satisfies EffectEntry);
  }
  counter.ran++;
  try {
    const out = await fn();
    if (!eval_) {
      await ctx.services.kv.set(EFFECTS_NS, key, { status: "done", at: Date.now(), type, nodeId: ctx.node.id, runId: ctx.runId, output: out } satisfies EffectEntry);
      const ttlMs = ctx.brain?.config?.effects?.ttlMs;
      if (ttlMs && ++writes % 50 === 0) await prune(ctx, ttlMs).catch(() => undefined);
    }
    return out;
  } catch (e) {
    if (isNotSent(e) || sentNothing(e)) {
      counter.ran--;
      if (!eval_) await ctx.services.kv.delete(EFFECTS_NS, key);
      throw isNotSent(e) ? e : new NotSentError((e as Error).message, { cause: e });
    }
    throw e;
  }
}
