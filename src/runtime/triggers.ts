import crypto from "node:crypto";
import { describeSchedule, nextCronTime, parseCron, parseEvery } from "../core/schedule.js";
import { getPath, parseDotPath, resolveDeep } from "../core/template.js";
import { parseFeed } from "../core/tools/feeds.js";
import { fetchUrl } from "../core/tools/web.js";
import type { TriggerQueueConfig, WebhookConfig } from "../core/config.js";
import type { AgentSpec, RunRecord, StoredAgent, Trigger } from "../core/types.js";
import type { FileStore } from "../store/fileStore.js";
import type { RunManager } from "./runManager.js";
import { liveFetch } from "../core/liveFetch.js";

/** Runtime state of one trigger (kept out of the versioned spec). */
export interface TriggerState {
  /** Overrides the spec's default `enabled` (the UI toggle). */
  enabled?: boolean;
  token?: string;
  nextAt?: number;
  lastCheckedAt?: number;
  lastFiredAt?: number;
  lastRunId?: string;
  lastStatus?: RunRecord["status"];
  lastError?: string;
  fireCount: number;
  skippedOverlap: number;
  /** Poll triggers: ids already seen (newest first, capped). */
  seen?: string[];
  pageHash?: string;
  /** Spec version the schedule was computed from. */
  specVersion?: number;
  /** The events that wait for the active run of this trigger, oldest first (docs/TRIGGERS.md). */
  queue?: QueuedEvent[];
  /** Webhooks: the delivery ids and the signatures of the last requests (dedupe and replay protection). */
  deliveries?: Record<string, { at: number; runId?: string; eventId?: string }>;
}

/** An event that waits in the queue of its trigger. */
export interface QueuedEvent {
  id: string;
  at: number;
  natural: unknown;
  scope?: Record<string, unknown>;
  label: string;
  chainDepth?: number;
}

/** The result of an event: a run started, the event waits in the queue, or the queue rejected it. */
export type FireResult = { run: RunRecord } | { queued: { eventId: string; position: number } } | { rejected: "queue_full" | "coalesced" };

/** The webhook headers of the signature (docs/TRIGGERS.md). */
export const SIGNATURE_HEADER = "x-anvil-signature";
export const TIMESTAMP_HEADER = "x-anvil-timestamp";

/** The signature of a webhook request: HMAC-SHA256 of "<timestamp>.<raw body>" with the webhook secret. */
export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

const sameText = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export interface TriggerView {
  agentId: string;
  agentName: string;
  version: number;
  trigger: Trigger;
  enabled: boolean;
  state: Omit<TriggerState, "token" | "seen" | "queue" | "deliveries"> & { queued: number };
  schedule?: string;
  webhookPath?: string;
}

export interface TriggerDeps {
  store: FileStore;
  runs: RunManager;
  now?: () => number;
  /** Poll/timer resolution. */
  tickMs?: number;
  log?: (msg: string) => void;
  /** The queue and webhook settings. Default: the config of the brain. */
  config?: { triggers: TriggerQueueConfig; webhook: WebhookConfig };
}

const DEFAULT_QUEUE: TriggerQueueConfig = { queueMax: 100, queueTtlMs: 86_400_000 };
const DEFAULT_WEBHOOK: WebhookConfig = {
  auth: "either",
  toleranceMs: 300_000,
  maxBodyBytes: 1_000_000,
  dedupeTtlMs: 86_400_000,
  idHeaders: ["idempotency-key", "x-anvil-delivery", "x-request-id", "x-github-delivery", "webhook-id", "x-webhook-id"],
  dedupeMax: 1000,
};

const NS = "triggers";
const MAX_CHAIN_DEPTH = 5;
const MIN_SCHEDULE_MS = 30_000;
const MIN_POLL_MS = 60_000;

const keyOf = (agentId: string, triggerId: string) => `${agentId}:${triggerId}`;

/**
 * Makes agents autonomous: schedules (cron / interval), webhooks, polling
 * (RSS/Atom, JSON feeds, page changes) and agent-to-agent chains. Every firing
 * becomes an ordinary recorded run (kind "trigger"), so it is traced, costed
 * and visible like any other run.
 */
export class TriggerManager {
  private state = new Map<string, TriggerState>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private unsub?: () => void;
  private loaded = false;
  private now: () => number;

  constructor(private deps: TriggerDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get queueConfig(): TriggerQueueConfig {
    return this.deps.config?.triggers ?? this.deps.runs.brain.config.triggers ?? DEFAULT_QUEUE;
  }

  get webhookConfig(): WebhookConfig {
    return this.deps.config?.webhook ?? this.deps.runs.brain.config.webhook ?? DEFAULT_WEBHOOK;
  }

  /* ------------------------------- lifecycle ------------------------------ */

  async load() {
    if (this.loaded) return;
    const saved = (await this.deps.store.list(NS)) as Record<string, TriggerState>;
    for (const [k, v] of Object.entries(saved)) this.state.set(k, { ...v, fireCount: v.fireCount ?? 0, skippedOverlap: v.skippedOverlap ?? 0 });
    this.loaded = true;
  }

  async start() {
    await this.load();
    this.unsub = this.deps.runs.onFinished((r) => void this.onRunFinished(r));
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? 10_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.unsub?.();
  }

  /* -------------------------------- queries ------------------------------- */

  private agents(): { agent: StoredAgent; spec: AgentSpec }[] {
    return this.deps.store
      .listAgents()
      .filter((a) => !a.system)
      .map((agent) => ({ agent, spec: agent.versions.find((v) => v.version === agent.currentVersion)?.spec }))
      .filter((x): x is { agent: StoredAgent; spec: AgentSpec } => !!x.spec);
  }

  private get(agentId: string, triggerId: string): TriggerState {
    const k = keyOf(agentId, triggerId);
    let s = this.state.get(k);
    if (!s) {
      s = { fireCount: 0, skippedOverlap: 0 };
      this.state.set(k, s);
    }
    return s;
  }

  private async save(agentId: string, triggerId: string) {
    await this.deps.store.set(NS, keyOf(agentId, triggerId), this.get(agentId, triggerId));
  }

  isEnabled(agentId: string, t: Trigger): boolean {
    return this.state.get(keyOf(agentId, t.id))?.enabled ?? t.enabled;
  }

  list(agentId?: string): TriggerView[] {
    const out: TriggerView[] = [];
    for (const { agent, spec } of this.agents()) {
      if (agentId && agent.id !== agentId) continue;
      for (const t of spec.triggers ?? []) {
        out.push({
          agentId: agent.id,
          agentName: agent.name,
          version: spec.version,
          trigger: t,
          enabled: this.isEnabled(agent.id, t),
          state: (({ token: _t, seen: _s, queue, deliveries: _d, ...rest }) => ({ ...rest, queued: queue?.length ?? 0 }))(this.get(agent.id, t.id)),
          schedule: t.type === "schedule" ? describeSchedule(t) : t.type === "poll" ? `check every ${t.every}` : undefined,
          webhookPath: t.type === "webhook" ? `/api/hooks/${agent.id}/${t.id}` : undefined,
        });
      }
    }
    return out;
  }

  /** The secret token of a webhook trigger (created on first request). */
  async webhookToken(agentId: string, triggerId: string, rotate = false): Promise<string> {
    const s = this.get(agentId, triggerId);
    if (!s.token || rotate) {
      s.token = crypto.randomBytes(18).toString("base64url");
      await this.save(agentId, triggerId);
    }
    return s.token;
  }

  async setEnabled(agentId: string, triggerId: string, enabled: boolean) {
    const s = this.get(agentId, triggerId);
    s.enabled = enabled;
    s.nextAt = undefined; // recompute from now
    s.specVersion = undefined;
    await this.save(agentId, triggerId);
    await this.tick();
  }

  /* -------------------------------- firing -------------------------------- */

  private mapInput(t: Trigger, scope: Record<string, unknown>, natural: unknown): unknown {
    if (t.input === undefined) return natural;
    return resolveDeep(t.input, scope);
  }

  private trigger(agentId: string, triggerId: string): Trigger {
    const found = this.agents().find((x) => x.agent.id === agentId);
    const t = found?.spec.triggers?.find((x) => x.id === triggerId);
    if (!found || !t) throw new Error(`trigger ${agentId}/${triggerId} not found`);
    return t;
  }

  private busy(agentId: string, triggerId: string): boolean {
    return this.deps.runs.activeRunsOf(agentId, (r) => r.trigger?.triggerId === triggerId).length > 0;
  }

  /**
   * An event of a trigger (docs/TRIGGERS.md). One run of a trigger is active at a time. An event that comes
   * while the run is active waits in the queue of the trigger, and starts when the run ends. The queue is on
   * disk, so a restart does not lose it. A full queue rejects the event. A schedule keeps one waiting event.
   */
  async fire(agentId: string, triggerId: string, event: { natural: unknown; scope?: Record<string, unknown>; label: string; chainDepth?: number }): Promise<FireResult> {
    const t = this.trigger(agentId, triggerId);
    const s = this.get(agentId, triggerId);
    if (!this.busy(agentId, triggerId) && !s.queue?.length) return { run: await this.startRun(agentId, t, event) };
    const queue = (s.queue ??= []);
    if (t.type === "schedule" && queue.length) {
      s.skippedOverlap++;
      await this.save(agentId, triggerId);
      this.deps.log?.(`[triggers] ${agentId}/${triggerId}: a scheduled event already waits — skipped`);
      return { rejected: "coalesced" };
    }
    if (queue.length >= this.queueConfig.queueMax) {
      s.skippedOverlap++;
      await this.save(agentId, triggerId);
      this.deps.log?.(`[triggers] ${agentId}/${triggerId}: the queue is full (${queue.length}) — rejected`);
      return { rejected: "queue_full" };
    }
    const queued: QueuedEvent = {
      id: `evt_${crypto.randomBytes(8).toString("hex")}`,
      at: this.now(),
      natural: event.natural,
      scope: event.scope,
      label: event.label,
      chainDepth: event.chainDepth,
    };
    queue.push(queued);
    await this.save(agentId, triggerId);
    void this.drain(agentId, triggerId);
    return { queued: { eventId: queued.id, position: queue.length } };
  }

  private draining = new Set<string>();

  /** Starts the oldest waiting event of a trigger when no run of the trigger is active. */
  async drain(agentId: string, triggerId: string): Promise<RunRecord | undefined> {
    const key = keyOf(agentId, triggerId);
    if (this.draining.has(key)) return;
    this.draining.add(key);
    try {
      const s = this.get(agentId, triggerId);
      if (!s.queue?.length || this.busy(agentId, triggerId)) return;
      let t: Trigger;
      try {
        t = this.trigger(agentId, triggerId);
      } catch {
        return; // The agent or the trigger is gone: the queue waits for a new version.
      }
      if (!this.isEnabled(agentId, t)) return;
      const old = this.now() - this.queueConfig.queueTtlMs;
      const expired = s.queue.filter((e) => e.at < old).length;
      if (expired) this.deps.log?.(`[triggers] ${agentId}/${triggerId}: ${expired} queued event(s) expired`);
      s.queue = s.queue.filter((e) => e.at >= old);
      const next = s.queue.shift();
      if (!next) {
        await this.save(agentId, triggerId);
        return;
      }
      return await this.startRun(agentId, t, next);
    } finally {
      this.draining.delete(key);
    }
  }

  private async startRun(agentId: string, t: Trigger, event: { natural: unknown; scope?: Record<string, unknown>; label: string; chainDepth?: number }): Promise<RunRecord> {
    const s = this.get(agentId, t.id);
    const scope = { trigger: { id: t.id, type: t.type, agentId, firedAt: new Date(this.now()).toISOString() }, ...(event.scope ?? {}) };
    const input = this.mapInput(t, scope, event.natural);
    const rec = this.deps.runs.start({ agentId }, input, {
      kind: "trigger",
      trigger: { agentId, triggerId: t.id, type: t.type, chainDepth: event.chainDepth ?? 0, event: event.label.slice(0, 200) },
    });
    s.lastFiredAt = this.now();
    s.lastRunId = rec.id;
    s.lastStatus = "running";
    s.lastError = undefined;
    s.fireCount++;
    await this.save(agentId, t.id);
    void this.deps.runs.waitForRun(rec.id).then(async (done) => {
      // The next waiting event starts at once.
      await this.drain(agentId, t.id).catch((e) => this.deps.log?.(`[triggers] queue start failed: ${(e as Error).message}`));
      if (!done) return;
      if (s.lastRunId === rec.id) {
        s.lastStatus = done.status;
        s.lastError = done.status === "failed" ? done.error : undefined;
      }
      await this.save(agentId, t.id);
    });
    return rec;
  }

  /** Manual "fire now" from the UI/API (ignores enabled/schedule). */
  async fireNow(agentId: string, triggerId: string, input?: unknown): Promise<FireResult> {
    return this.fire(agentId, triggerId, { natural: input ?? {}, scope: { payload: input ?? {} }, label: "manual" });
  }

  /** Checks the signature or the token of a webhook request (docs/TRIGGERS.md). Returns an error, or nothing. */
  private authenticate(s: TriggerState, headers: Record<string, string>, rawBody: string): { status: number; error: string; signature?: string } | { signature?: string } {
    const cfg = this.webhookConfig;
    if (!s.token) return { status: 401, error: "this webhook has no secret yet: get the URL and the secret first" };
    const signature = headers[SIGNATURE_HEADER];
    if (signature && cfg.auth !== "token") {
      const ts = headers[TIMESTAMP_HEADER] ?? "";
      if (!/^\d{9,11}$/.test(ts)) return { status: 401, error: `give ${TIMESTAMP_HEADER} (Unix seconds) with the signature` };
      if (Math.abs(this.now() - Number(ts) * 1000) > cfg.toleranceMs) return { status: 401, error: "the timestamp is outside the time window: a replay or a wrong clock" };
      if (!sameText(signature, signWebhook(s.token, ts, rawBody))) return { status: 401, error: "invalid signature" };
      if (s.deliveries?.[`sig:${signature}`]) return { status: 409, error: "replay: this signed request came before" };
      return { signature };
    }
    if (cfg.auth === "hmac") return { status: 401, error: `give the ${SIGNATURE_HEADER} and ${TIMESTAMP_HEADER} headers: this server accepts only signed webhooks` };
    const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? "")?.[1];
    const token = headers["x-anvil-token"] ?? bearer;
    if (!token || !sameText(token, s.token)) return { status: 401, error: "invalid token" };
    return {};
  }

  private remember(s: TriggerState, key: string, value: { runId?: string; eventId?: string }) {
    const cfg = this.webhookConfig;
    const now = this.now();
    const kept = Object.entries(s.deliveries ?? {}).filter(([k, v]) => now - v.at < (k.startsWith("sig:") ? cfg.toleranceMs * 2 : cfg.dedupeTtlMs));
    kept.push([key, { at: now, ...value }]);
    s.deliveries = Object.fromEntries(kept.sort((a, b) => a[1].at - b[1].at).slice(-cfg.dedupeMax));
  }

  /**
   * Incoming webhook (docs/TRIGGERS.md): the signature or the token, the replay window, and the dedupe of a
   * delivery id. Returns the started run (and its result when `respond`), or the place in the queue.
   */
  async handleWebhook(
    agentId: string,
    triggerId: string,
    req: { rawBody: string; payload: unknown; headers: Record<string, string>; query: Record<string, string> },
  ): Promise<{ status: number; body: unknown }> {
    const found = this.agents().find((x) => x.agent.id === agentId);
    const t = found?.spec.triggers?.find((x) => x.id === triggerId);
    if (!t || t.type !== "webhook") return { status: 404, body: { error: "no such webhook" } };
    const s = this.get(agentId, triggerId);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const auth = this.authenticate(s, headers, req.rawBody);
    if ("error" in auth) return { status: auth.status, body: { error: auth.error } };
    if (!this.isEnabled(agentId, t)) return { status: 409, body: { error: "trigger is disabled" } };
    const deliveryId = this.webhookConfig.idHeaders.map((h) => headers[h]).find((v) => !!v);
    const prior = deliveryId ? s.deliveries?.[`id:${deliveryId}`] : undefined;
    if (prior && this.now() - prior.at < this.webhookConfig.dedupeTtlMs) return { status: 200, body: { duplicate: true, runId: prior.runId, eventId: prior.eventId } };
    const natural = req.payload && typeof req.payload === "object" && !Array.isArray(req.payload) ? req.payload : { payload: req.payload };
    // The scope of the input mapping never holds a secret header.
    const scopeHeaders = Object.fromEntries(Object.entries(headers).filter(([k]) => !/token|authorization|cookie|signature/i.test(k)));
    const r = await this.fire(agentId, triggerId, { natural, scope: { payload: req.payload, headers: scopeHeaders, query: req.query }, label: "webhook" });
    if ("rejected" in r) return { status: 429, body: { error: "the queue of this trigger is full: send the event again later" } };
    const ids = "run" in r ? { runId: r.run.id } : { eventId: r.queued.eventId };
    if (auth.signature) this.remember(s, `sig:${auth.signature}`, ids);
    if (deliveryId) this.remember(s, `id:${deliveryId}`, ids);
    if (auth.signature || deliveryId) await this.save(agentId, triggerId);
    if ("queued" in r) return { status: 202, body: { queued: true, eventId: r.queued.eventId, position: r.queued.position } };
    if (!t.respond) return { status: 202, body: { runId: r.run.id } };
    const done = await this.deps.runs.waitForRun(r.run.id);
    return { status: done?.status === "completed" ? 200 : 422, body: { runId: r.run.id, status: done?.status, output: done?.output, error: done?.error } };
  }

  /** Agent-chain triggers: another agent finished. */
  private async onRunFinished(r: RunRecord) {
    if (r.kind === "eval" || r.parentRunId) return;
    // A run that started before a restart (docs/RECOVERY.md) has no wait of its trigger: its end starts the queue here.
    if (r.trigger) await this.drain(r.trigger.agentId, r.trigger.triggerId).catch(() => undefined);
    const depth = (r.trigger?.chainDepth ?? 0) + 1;
    for (const { agent, spec } of this.agents()) {
      for (const t of spec.triggers ?? []) {
        if (t.type !== "agent" || t.agentId !== r.agentId || !this.isEnabled(agent.id, t)) continue;
        const match = t.on === "any" || (t.on === "completed" ? r.status === "completed" : r.status === "failed");
        if (!match) continue;
        if (depth > MAX_CHAIN_DEPTH) {
          this.deps.log?.(`[triggers] chain depth ${depth} exceeds ${MAX_CHAIN_DEPTH} — ${agent.id}/${t.id} not fired`);
          continue;
        }
        const natural = r.output && typeof r.output === "object" && !Array.isArray(r.output) ? r.output : { output: r.output };
        await this.fire(agent.id, t.id, {
          natural,
          scope: { output: r.output, run: { id: r.id, status: r.status, agentId: r.agentId, error: r.error } },
          label: `after ${r.agentId} ${r.status}`,
          chainDepth: depth,
        }).catch((e) => this.deps.log?.(`[triggers] chain fire failed: ${(e as Error).message}`));
      }
    }
  }

  /* --------------------------------- timer -------------------------------- */

  private polling = new Set<string>();

  /**
   * One scheduler pass: fire due schedules, start due polls. Safe to call
   * anytime. Each poll runs independently (a slow feed never delays schedules);
   * the returned promise settles when the polls started by this pass finish.
   */
  async tick() {
    const polls: Promise<void>[] = [];
    const fail = async (agentId: string, t: Trigger, e: unknown) => {
      const s = this.get(agentId, t.id);
      s.lastError = (e as Error).message;
      await this.save(agentId, t.id);
    };
    if (!this.ticking) {
      this.ticking = true;
      try {
        const now = this.now();
        for (const { agent, spec } of this.agents()) {
          for (const t of spec.triggers ?? []) {
            if (!this.isEnabled(agent.id, t)) continue;
            // Events that waited in the queue (for example over a restart) start when the trigger is free.
            if (this.state.get(keyOf(agent.id, t.id))?.queue?.length) void this.drain(agent.id, t.id).catch((e) => fail(agent.id, t, e));
            if (t.type === "schedule") await this.tickSchedule(agent.id, spec.version, t, now).catch((e) => fail(agent.id, t, e));
            else if (t.type === "poll") {
              const key = keyOf(agent.id, t.id);
              if (this.polling.has(key)) continue;
              this.polling.add(key);
              polls.push(
                this.tickPoll(agent.id, t, now)
                  .catch((e) => fail(agent.id, t, e))
                  .finally(() => this.polling.delete(key)),
              );
            }
          }
        }
      } finally {
        this.ticking = false;
      }
    }
    await Promise.all(polls);
  }

  nextScheduleTime(t: Extract<Trigger, { type: "schedule" }>, after: number): number {
    if (t.every) return after + Math.max(MIN_SCHEDULE_MS, parseEvery(t.every));
    if (t.cron) return nextCronTime(parseCron(t.cron), after, t.timezone);
    throw new Error("schedule needs cron or every");
  }

  private async tickSchedule(agentId: string, version: number, t: Extract<Trigger, { type: "schedule" }>, now: number) {
    const s = this.get(agentId, t.id);
    if (s.nextAt === undefined || s.specVersion !== version) {
      s.nextAt = this.nextScheduleTime(t, now);
      s.specVersion = version;
      await this.save(agentId, t.id);
      return;
    }
    if (s.nextAt > now) return;
    // Missed several slots (e.g. the server was down)? Fire once, then realign.
    s.nextAt = this.nextScheduleTime(t, now);
    await this.fire(agentId, t.id, { natural: {}, label: "schedule" });
  }

  private async tickPoll(agentId: string, t: Extract<Trigger, { type: "poll" }>, now: number) {
    const s = this.get(agentId, t.id);
    const every = Math.max(MIN_POLL_MS, parseEvery(t.every));
    if (s.lastCheckedAt && now - s.lastCheckedAt < every) return;
    s.lastCheckedAt = now;
    const firstCheck = s.seen === undefined && s.pageHash === undefined;
    const { items, idOf } = await this.fetchItems(t, s);
    if (firstCheck && t.skipExisting) {
      s.seen = items.map(idOf).slice(0, 500);
      await this.save(agentId, t.id);
      return;
    }
    await this.save(agentId, t.id);
    // Oldest first and one at a time, so no item is lost to overlap. An item counts as seen when its run
    // started or when it waits in the queue. A full queue leaves the remaining items for the next check.
    for (const item of items.slice(0, t.maxPerCheck).reverse()) {
      const label = `new item: ${String((item as { title?: string }).title ?? idOf(item))}`;
      const r = await this.fire(agentId, t.id, { natural: item, scope: { item }, label });
      if ("rejected" in r) break;
      s.seen = [idOf(item), ...(s.seen ?? [])].slice(0, 500);
      await this.save(agentId, t.id);
      if ("run" in r) await this.deps.runs.waitForRun(r.run.id);
    }
  }

  /** Returns the items not seen yet (newest first) without marking them. */
  private async fetchItems(t: Extract<Trigger, { type: "poll" }>, s: TriggerState): Promise<{ items: Record<string, unknown>[]; idOf: (x: Record<string, unknown>) => string }> {
    const src = t.source;
    if (src.kind === "page") {
      const page = await fetchUrl(src.url, { maxChars: 60_000, live: this.deps.runs.brain.config.live });
      const hash = crypto.createHash("sha256").update(page.text).digest("hex");
      const idOf = (x: Record<string, unknown>) => String(x.id);
      if (hash === s.pageHash) return { items: [], idOf };
      const firstSeen = s.pageHash === undefined;
      s.pageHash = hash;
      const item = { id: hash, url: page.url, title: page.title, text: page.text.slice(0, 20_000), changedAt: new Date(this.now()).toISOString() };
      return { items: firstSeen && t.skipExisting ? [] : [item], idOf };
    }
    const res = await liveFetch(
      src.url,
      { headers: { "User-Agent": "AnvilAgent/1.0", Accept: "application/rss+xml, application/atom+xml, application/json, */*" } },
      this.deps.runs.brain.config.live,
    );
    if (!res.ok) throw new Error(`poll ${src.url}: HTTP ${res.status}`);
    const text = res.text;
    let items: Record<string, unknown>[];
    if (src.kind === "rss") items = parseFeed(text).items as unknown as Record<string, unknown>[];
    else {
      const data = JSON.parse(text) as unknown;
      const list = src.itemsPath ? getPath(data, parseDotPath(src.itemsPath)) : data;
      if (!Array.isArray(list)) throw new Error(`poll ${src.url}: itemsPath "${src.itemsPath}" is not an array`);
      items = list.map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : { value: x }));
    }
    const idOf = (x: Record<string, unknown>) => String(src.kind === "json" ? (getPath(x, parseDotPath(src.idPath)) ?? JSON.stringify(x)) : x.id);
    const seen = new Set(s.seen ?? []);
    return { items: items.filter((x) => !seen.has(idOf(x))).map((x) => (src.kind === "json" ? { ...x, id: idOf(x) } : x)), idOf };
  }
}
