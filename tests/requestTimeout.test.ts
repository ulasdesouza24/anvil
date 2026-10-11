import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { OpenRouterClient } from "../src/llm/openrouter.js";

/** A server that counts the requests and never answers. */
let server: Server;
let requests = 0;
let baseUrl = "";
beforeAll(async () => {
  server = createServer(() => {
    requests++;
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const client = (over: Partial<ReturnType<typeof loadConfig>> = {}) => new OpenRouterClient({ ...loadConfig(), apiKey: "test", baseUrl, ...over });

describe("time limit of a model request", () => {
  it("grows with the token budget, and is never below the configured minimum", () => {
    const c = client({ requestTimeoutMs: 90_000, timeoutTokensPerSec: 40 });
    expect(c.timeoutFor(1000)).toBe(90_000);
    expect(c.timeoutFor(10_000)).toBe(250_000);
    expect(c.timeoutFor(undefined)).toBe(90_000);
    expect(client({ requestTimeoutMs: 90_000, timeoutTokensPerSec: 0 }).timeoutFor(10_000)).toBe(90_000);
  });

  it("runs a request that hit the time limit again only timeoutRetries times, with a clear error", async () => {
    requests = 0;
    const c = client({ requestTimeoutMs: 150, timeoutTokensPerSec: 0, timeoutRetries: 1 });
    await expect(c.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 50 })).rejects.toThrow(/did not answer in .* s \(time limit of the request\)/);
    expect(requests).toBe(2);
  });
});

describe("an answer that used its budget for reasoning", () => {
  it("runs again with a larger budget and a hard limit on the reasoning", async () => {
    const bodies: { max_tokens: number; reasoning: Record<string, unknown> }[] = [];
    const empty = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        const ok = bodies.length === 3;
        res.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            provider: `P${bodies.length}`,
            choices: [{ message: { content: ok ? '{"a":1}' : "" }, finish_reason: ok ? "stop" : "length" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 },
          }),
        );
      });
    });
    await new Promise<void>((r) => empty.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(empty.address() as AddressInfo).port}`;
    const c = new OpenRouterClient({ ...loadConfig(), apiKey: "test", baseUrl: url, maxRetryTokens: 32_000, retryReasoningShare: 0.4 });
    const r = await c.chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 10_000, reasoning: "high", json: true });
    expect(r.content).toBe('{"a":1}');
    expect(bodies.map((b) => b.max_tokens)).toEqual([10_000, 20_000, 32_000]);
    expect(bodies[0].reasoning).toMatchObject({ effort: "high" });
    // The second attempt: 40% of 20000 for the reasoning. The third: no reasoning, because some providers think past the limit.
    expect(bodies[1].reasoning).toMatchObject({ max_tokens: 8000 });
    expect(bodies[2].reasoning).toEqual({ enabled: false });
    empty.close();
  });
});
