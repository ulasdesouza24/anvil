import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LiveConfig } from "../src/core/config.js";
import { clearLiveCache, hostHeadersFor, liveFetch, retryAfterMs } from "../src/core/liveFetch.js";

let server: http.Server;
let base = "";
let host = "";
const hits: Record<string, number> = {};
const seenHeaders: Record<string, string | undefined>[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits[url.pathname] = (hits[url.pathname] ?? 0) + 1;
    seenHeaders.push({ authorization: req.headers.authorization });
    const n = hits[url.pathname];
    const json = (code: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(code, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
    if (url.pathname === "/flaky") return n < 3 ? json(503, { error: "busy" }) : json(200, { ok: n });
    if (url.pathname === "/retry-after") return n === 1 ? json(429, { error: "slow down" }, { "Retry-After": "0.2" }) : json(200, { ok: n });
    if (url.pathname === "/rate-limited") return json(429, { error: "limit" }, { "Retry-After": "3600" });
    if (url.pathname === "/post") return json(503, { error: "busy" });
    if (url.pathname === "/hang") return;
    if (url.pathname === "/missing") return json(404, { error: "no" });
    return json(200, { n });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  base = `http://${host}`;
});
afterAll(() => server.close());
beforeEach(() => {
  for (const k of Object.keys(hits)) delete hits[k];
  seenHeaders.length = 0;
  clearLiveCache();
});

const cfg = (over: Partial<LiveConfig> = {}): LiveConfig => ({ retries: 2, backoffMs: 20, maxRetryAfterMs: 1000, cache: "eval", cacheTtlMs: 60_000, cacheMax: 100, hostHeaders: {}, ...over });

describe("live fetch", () => {
  it("tries a GET again after a transient failure", async () => {
    const r = await liveFetch(`${base}/flaky`, {}, cfg());
    expect(r).toMatchObject({ status: 200, ok: true, attempts: 3 });
    expect(hits["/flaky"]).toBe(3);
  });

  it("waits for a short Retry-After, and gives back a long one at once as a rate limit", async () => {
    const t0 = Date.now();
    const r = await liveFetch(`${base}/retry-after`, {}, cfg());
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    const limited = await liveFetch(`${base}/rate-limited`, {}, cfg());
    expect(limited).toMatchObject({ status: 429, attempts: 1 });
    expect(retryAfterMs("120")).toBe(120_000);
  });

  it("does not send a request with side effects again", async () => {
    const r = await liveFetch(`${base}/post`, { method: "POST", body: "{}" }, cfg());
    expect(r).toMatchObject({ status: 503, attempts: 1 });
  });

  it("a request that does not get an answer in time says that it timed out, after the retries", async () => {
    await expect(liveFetch(`${base}/hang`, { timeoutMs: 100 }, cfg({ retries: 1 }))).rejects.toThrow(`timed out after 0 s: ${host} did not answer`);
    expect(hits["/hang"]).toBe(2);
  });

  it("sends the configured headers only to their exact host, with values from the environment", async () => {
    const c = cfg({ hostHeaders: { [host]: { Authorization: "Bearer ${ANVIL_TEST_TOKEN}" }, "api.example.com": { Authorization: "Bearer other" } } });
    expect(hostHeadersFor(host, c, {})).toEqual({});
    process.env.ANVIL_TEST_TOKEN = "t-123";
    try {
      await liveFetch(`${base}/ok`, {}, c);
      expect(seenHeaders[0].authorization).toBe("Bearer t-123");
      // A header of the request wins.
      await liveFetch(`${base}/ok2`, { headers: { Authorization: "Bearer mine" } }, c);
      expect(seenHeaders[1].authorization).toBe("Bearer mine");
      expect(hostHeadersFor("other.test", c)).toEqual({});
    } finally {
      delete process.env.ANVIL_TEST_TOKEN;
    }
  });

  it("caches a good GET answer in evaluation runs only", async () => {
    const a = await liveFetch(`${base}/data`, { runKind: "eval" }, cfg());
    const b = await liveFetch(`${base}/data`, { runKind: "eval" }, cfg());
    expect(b).toMatchObject({ text: a.text, fromCache: true });
    expect(hits["/data"]).toBe(1);
    await liveFetch(`${base}/data`, { runKind: "run" }, cfg());
    expect(hits["/data"]).toBe(2);
    await liveFetch(`${base}/missing`, { runKind: "eval" }, cfg());
    await liveFetch(`${base}/missing`, { runKind: "eval" }, cfg());
    expect(hits["/missing"]).toBe(2);
    await liveFetch(`${base}/data2`, { runKind: "eval" }, cfg({ cache: "off" }));
    await liveFetch(`${base}/data2`, { runKind: "eval" }, cfg({ cache: "off" }));
    expect(hits["/data2"]).toBe(2);
  });
});
