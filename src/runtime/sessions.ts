import { nanoid } from "nanoid";
import type { KVStore } from "../core/registry.js";
import { toolCallsOfEvents, type ToolCallRecord } from "../core/toolCalls.js";
import { REPLY_FIELDS, type AgentSpec } from "../core/types.js";

/**
 * Conversations with a conversation agent. A session keeps
 * the turns. Each user message runs the agent once with all turns, and its
 * reply becomes the next turn. Mock tools keep their state for the session.
 */
export interface Turn {
  role: "user" | "assistant";
  content: string;
  at: number;
  /** For a reply: the run that made it. */
  runId?: string;
  /** For a reply: the tool calls of the turn. The next turns get them, so the agent keeps their ids and values. */
  toolCalls?: ToolCallRecord[];
}

export interface Session {
  id: string;
  agentId: string;
  version: number;
  turns: Turn[];
  /** The agent said that the conversation is finished. */
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

const NS = "sessions";

/** A conversation agent: its input has "messages", and its meta says "conversation". */
export function isConversational(spec: AgentSpec | undefined): boolean {
  if (!spec) return false;
  return spec.meta?.interaction === "conversation" || !!(spec.inputSchema as { properties?: Record<string, unknown> })?.properties?.messages;
}

/** The input of one turn: the turns so far (user and assistant), and the session id. */
export function turnInput(s: Pick<Session, "id" | "turns">): { messages: { role: string; content: string; toolCalls?: ToolCallRecord[] }[]; session_id: string } {
  return { messages: s.turns.map((t) => ({ role: t.role, content: t.content, ...(t.toolCalls?.length ? { toolCalls: t.toolCalls } : {}) })), session_id: s.id };
}

/** The reply of a turn that failed. */
export const FAILED_REPLY = "Sorry, I could not finish this request. Please try again.";

/** The reply in an agent output: {reply}, {answer}, {text}, or a text output. */
export function replyOf(output: unknown): { reply: string; done: boolean } {
  if (typeof output === "string") return { reply: output, done: false };
  const o = (output ?? {}) as Record<string, unknown>;
  // A partial result of the harness has the output of the agent in "result".
  const r = (o.status === "partial" && o.result && typeof o.result === "object" ? o.result : o) as Record<string, unknown>;
  const reply = REPLY_FIELDS.map((k) => r[k]).find((x) => typeof x === "string") as string | undefined;
  // A partial result without a result is a failure of the agent: the user does not see its JSON.
  if (reply === undefined && o.status === "partial") return { reply: FAILED_REPLY, done: false };
  return { reply: reply ?? JSON.stringify(r), done: r.done === true };
}

export class SessionService {
  constructor(private kv: KVStore) {}

  async create(agentId: string, version: number): Promise<Session> {
    const now = Date.now();
    const s: Session = { id: `s_${nanoid(12)}`, agentId, version, turns: [], done: false, createdAt: now, updatedAt: now };
    await this.kv.set(NS, s.id, s);
    return s;
  }

  async get(id: string): Promise<Session | undefined> {
    return (await this.kv.get(NS, id)) as Session | undefined;
  }

  async save(s: Session): Promise<void> {
    s.updatedAt = Date.now();
    await this.kv.set(NS, s.id, s);
  }

  async list(agentId?: string): Promise<Session[]> {
    const all = Object.values((await this.kv.list(NS)) as Record<string, Session>);
    return all.filter((s) => !agentId || s.agentId === agentId).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async remove(id: string): Promise<void> {
    await this.kv.delete(NS, id);
  }
}

/** One user message: the agent runs with all turns and its reply becomes the next turn. */
export async function converse(
  deps: { sessions: SessionService; runs: import("./runManager.js").RunManager },
  sessionId: string,
  content: string,
): Promise<{ session: Session; reply: string; done: boolean; runId: string; status: string; error?: string }> {
  const s = await deps.sessions.get(sessionId);
  if (!s) throw new Error(`Session "${sessionId}" does not exist`);
  if (!content.trim()) throw new Error("The message is empty");
  s.turns.push({ role: "user", content, at: Date.now() });
  const rec = deps.runs.start({ agentId: s.agentId }, turnInput(s), { kind: "run", version: s.version });
  const done = await deps.runs.waitForRun(rec.id);
  const status = done?.status ?? "failed";
  const r = done && status === "completed" ? replyOf(done.output) : { reply: "", done: false };
  const spec = done ? deps.runs.store.getSpec(s.agentId, s.version) : undefined;
  const toolCalls = done && spec ? toolCallsOfEvents(spec, done.events) : [];
  if (r.reply) s.turns.push({ role: "assistant", content: r.reply, at: Date.now(), runId: rec.id, ...(toolCalls.length ? { toolCalls } : {}) });
  s.done = r.done;
  await deps.sessions.save(s);
  return { session: s, reply: r.reply, done: r.done, runId: rec.id, status, ...(done?.error ? { error: done.error } : {}) };
}
