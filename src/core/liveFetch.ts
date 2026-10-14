import { currentEnv, currentScope, type WorkspaceScope } from "./scope.js";
import type { LiveConfig } from "./config.js";

/**
 * One way for agents to call live data sources (docs/LIVE_DATA.md). Every http
 * class, http node, http_request tool, page fetch, and source probe uses it.
 *
 * - Transient failures (a network error, a timeout, HTTP 408/425/429/5xx) get
 *   a new attempt after a backoff. A 429 or 503 with a short Retry-After waits
 *   for it. A long Retry-After is a rate limit: the answer goes back at once.
 * - Configured headers for a host (for example a token for a higher rate
 *   limit) go only to that exact host. Request headers win.
 * - In evaluation runs, GET answers are cached for a short time: evolve runs
 *   the same tests again in each round, and a source must not see the same
 *   requests again and again.
 */

export interface LiveAnswer {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text: string;
  url: string;
  attempts: number;
  fromCache?: boolean;
}

export interface LiveOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  redirect?: "follow" | "manual" | "error";
  /** The kind of the run: the cache applies to evaluation runs (or to all runs, by the config). */
  runKind?: string;
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Host headers from the UI (docs/SECRETS.md). They come after ANVIL_HOST_HEADERS: a header of the UI wins. */
let extraHostHeaders: Record<string, Record<string, string>> = {};
/** The host headers from the UI. In a workspace scope (docs/HOSTING.md), they belong to that workspace only. */
const globalHostHeaders = () => extraHostHeaders;
export function setExtraHostHeaders(h: Record<string, Record<string, string>>, scope?: WorkspaceScope): void {
  const next = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), { ...v }]));
  if (scope) scope.hostHeaders = next;
  else extraHostHeaders = next;
}

/** Header values can name environment variables: ${GITHUB_TOKEN}. A header with a missing variable is not sent. */
export function hostHeadersFor(host: string, cfg: Pick<LiveConfig, "hostHeaders">, env: Record<string, string | undefined> = currentEnv()): Record<string, string> {
  const h = host.toLowerCase();
  const extraHostHeaders = currentScope()?.hostHeaders ?? globalHostHeaders();
  const raw = cfg.hostHeaders[h] || extraHostHeaders[h] ? { ...(cfg.hostHeaders[h] ?? {}), ...(extraHostHeaders[h] ?? {}) } : undefined;
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    let missing = false;
    const value = v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
      const x = env[name];
      if (!x) missing = true;
      return x ?? "";
    });
    if (!missing) out[k] = value;
  }
  return out;
}

/** The wait that a Retry-After header asks for (seconds or an HTTP date), in ms. */
export function retryAfterMs(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.round(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

interface CacheEntry {
  at: number;
  answer: LiveAnswer;
}
const cache = new Map<string, CacheEntry>();

/** The run kind for the cache. A run that reads fresh data (a health check) has none, so it uses no cache. */
export const liveCacheKind = (s: { runKind?: string; freshData?: boolean }): string | undefined => (s.freshData ? undefined : s.runKind);

export function clearLiveCache() {
  cache.clear();
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });

export async function liveFetch(raw: string | URL, opts: LiveOptions, cfg: LiveConfig): Promise<LiveAnswer> {
  const url = new URL(String(raw));
  const method = (opts.method ?? "GET").toUpperCase();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const headers = { ...hostHeadersFor(url.host, cfg), ...(opts.headers ?? {}) };
  const cacheOn = method === "GET" && cfg.cacheTtlMs > 0 && (cfg.cache === "all" || (cfg.cache === "eval" && opts.runKind === "eval"));
  // The key has the URL and the header names, not the header values: a token must not be in memory twice.
  const key = `${method} ${url} ${Object.keys(headers).sort().join(",")}`;
  if (cacheOn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at <= cfg.cacheTtlMs) return { ...hit.answer, fromCache: true };
  }

  let attempt = 0;
  for (;;) {
    attempt++;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onAbort);
    let failure: Error | null = null;
    let answer: LiveAnswer | null = null;
    let wait = cfg.backoffMs * 2 ** (attempt - 1) + Math.random() * 200;
    try {
      const res = await fetch(url, { method, headers, body: opts.body, redirect: opts.redirect ?? "follow", signal: ctrl.signal });
      const text = await res.text();
      answer = { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()), text, url: res.url || url.toString(), attempts: attempt };
      if (RETRY_STATUS.has(res.status)) {
        const after = retryAfterMs(res.headers.get("retry-after"));
        // A long wait is a rate limit for this hour or this day: the agent and the harness decide what to do.
        if (after !== null && after > cfg.maxRetryAfterMs) return answer;
        if (after !== null) wait = Math.max(wait, after);
        failure = new Error(`HTTP ${res.status} from ${url.host}`);
      }
    } catch (e) {
      if (opts.signal?.aborted) throw new Error("aborted");
      failure = timedOut ? new Error(`timed out after ${Math.round(timeoutMs / 1000)} s: ${url.host} did not answer`) : new Error(`${(e as Error).message} (${url.host})`);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    // Only a request without side effects is sent again. A POST can have changed something before it failed.
    const safe = method === "GET" || method === "HEAD";
    if (!failure || !safe || attempt > cfg.retries) {
      if (answer) {
        if (cacheOn && answer.ok) {
          cache.set(key, { at: Date.now(), answer });
          if (cache.size > cfg.cacheMax) cache.delete(cache.keys().next().value!);
        }
        return answer;
      }
      throw failure!;
    }
    await sleep(wait, opts.signal);
  }
}
