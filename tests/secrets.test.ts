import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostHeadersFor, setExtraHostHeaders } from "../src/core/liveFetch.js";
import type { AgentSpec } from "../src/core/types.js";
import { decrypt, encrypt, redactSecrets, SecretService } from "../src/runtime/secrets.js";
import { anvilWith, FakeClient, tmpDir } from "./helpers.js";

const KEY = crypto.randomBytes(32).toString("hex");

let server: http.Server;
let base = "";
beforeAll(async () => {
  // A source with a rate limit for requests without a token, like the GitHub API.
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer gh-test-token-1234567890") return res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "API rate limit exceeded" }));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ stars: 42 }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  setExtraHostHeaders({});
});

describe("secret encryption", () => {
  it("decrypts with the key, and a wrong key fails", () => {
    const key = Buffer.from(KEY, "hex");
    const box = encrypt("hello", key);
    expect(box).not.toContain("hello");
    expect(decrypt(box, key)).toBe("hello");
    expect(() => decrypt(box, crypto.randomBytes(32))).toThrow();
  });
});

describe("the secret service", () => {
  it("stores values encrypted, puts them into the environment, and removes only its own names", () => {
    const dir = tmpDir();
    const env: NodeJS.ProcessEnv = { OTHER_TOKEN: "from-env-123456" };
    const s = new SecretService(dir, KEY, env).load();
    expect(s.enabled).toBe(true);
    s.set("GITHUB_TOKEN", "ghp_abcdefghijklmnop1234");
    expect(env.GITHUB_TOKEN).toBe("ghp_abcdefghijklmnop1234");
    const file = fs.readFileSync(path.join(dir, "secrets.enc.json"), "utf8");
    expect(file).not.toContain("ghp_abcdefghijklmnop1234");
    expect(s.list()).toEqual([
      { name: "GITHUB_TOKEN", source: "ui", updatedAt: expect.any(Number), hint: "…1234" },
      { name: "OTHER_TOKEN", source: "env", hint: "…3456" },
    ]);

    // A new start reads the file.
    const env2: NodeJS.ProcessEnv = {};
    new SecretService(dir, KEY, env2).load();
    expect(env2.GITHUB_TOKEN).toBe("ghp_abcdefghijklmnop1234");
    expect(() => new SecretService(dir, crypto.randomBytes(32).toString("hex"), {}).load()).toThrow(/ANVIL_SECRETS_KEY is wrong/);

    s.remove("GITHUB_TOKEN");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(() => s.remove("OTHER_TOKEN")).toThrow(/No secret "OTHER_TOKEN" from the UI/);
    expect(env.OTHER_TOKEN).toBe("from-env-123456");
  });

  it("rejects bad names, the keys of .env, and a store without a key", () => {
    const s = new SecretService(tmpDir(), KEY, {}).load();
    expect(() => s.set("github-token", "x")).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => s.set("ANVIL_SECRETS_KEY", "x")).toThrow(/must stay in .env/);
    const off = new SecretService(tmpDir(), undefined, {}).load();
    expect(off.enabled).toBe(false);
    expect(() => off.set("GITHUB_TOKEN", "x")).toThrow(/Set ANVIL_SECRETS_KEY/);
  });

  it("host headers name secrets, a literal credential is rejected, and the needed secrets are listed", () => {
    const env: NodeJS.ProcessEnv = {};
    const s = new SecretService(tmpDir(), KEY, env).load();
    expect(() => s.setHostHeaders("api.github.com", { Authorization: "Bearer ghp_literal" })).toThrow(/looks like a credential/);
    s.setHostHeaders("API.GitHub.com", { Authorization: "Bearer ${GH_TOKEN}", Accept: "application/json" });
    expect(s.hostHeaders()).toEqual({ "api.github.com": { Authorization: "Bearer ${GH_TOKEN}", Accept: "application/json" } });
    expect(s.needed({ "class x_weather": ["WEATHER_KEY"], "agent daily": [] }, { "api.x.com": { "X-Key": "${X_KEY}" } })).toEqual([
      { name: "GH_TOKEN", usedBy: ["host api.github.com"] },
      { name: "WEATHER_KEY", usedBy: ["class x_weather"] },
      { name: "X_KEY", usedBy: ["host api.x.com"] },
    ]);
    s.set("GH_TOKEN", "a-token-value-12345");
    expect(s.needed({}, {}).map((n) => n.name)).not.toContain("GH_TOKEN");
    expect(hostHeadersFor("api.github.com", { hostHeaders: {} }, env)).toEqual({ Authorization: "Bearer a-token-value-12345", Accept: "application/json" });
    s.setHostHeaders("api.github.com", {});
    expect(s.hostHeaders()).toEqual({});
  });
});

describe("secrets in runs", () => {
  it("a token from the UI ends the rate limit of a source", async () => {
    const anvil = await anvilWith(new FakeClient());
    const host = new URL(base).host;
    const spec: AgentSpec = {
      specVersion: "anvil/v1",
      id: "stars",
      name: "stars",
      description: "",
      version: 1,
      inputSchema: { type: "object", properties: {} },
      nodes: [
        { id: "input", type: "input", config: {} },
        { id: "get", type: "http", config: { url: `${base}/repo`, failOnHttpError: false } },
        { id: "output", type: "output", config: { value: { status: "{{nodes.get.output.status}}", body: "{{nodes.get.output.body}}" } } },
      ],
      edges: [
        { from: "input", to: "get" },
        { from: "get", to: "output" },
      ],
      policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 20_000, requireApprovalForSideEffects: false },
      tests: [],
      meta: {},
    };
    const before = await anvil.runs.run({ spec }, {});
    expect(before.output).toMatchObject({ status: 403 });
    const s = new SecretService(tmpDir(), KEY).load();
    s.set("TEST_GH_TOKEN_A8", "gh-test-token-1234567890");
    s.setHostHeaders(host, { Authorization: "Bearer ${TEST_GH_TOKEN_A8}" });
    try {
      const after = await anvil.runs.run({ spec }, {});
      expect(after.output).toEqual({ status: 200, body: { stars: 42 } });
      // The trace does not show the token: the resolved config of a step is masked.
      expect(JSON.stringify(after.events)).not.toContain("gh-test-token-1234567890");
    } finally {
      s.remove("TEST_GH_TOKEN_A8");
      setExtraHostHeaders({});
    }
  });

  it("run events and outputs never show a secret value", async () => {
    process.env.TEST_SECRET_TOKEN_A8 = "sk-very-secret-value-0001";
    try {
      expect(redactSecrets({ a: "x sk-very-secret-value-0001 y", b: ["sk-very-secret-value-0001"] })).toEqual({ a: "x [secret] y", b: ["[secret]"] });
      const anvil = await anvilWith(new FakeClient(() => "The key is sk-very-secret-value-0001."));
      const spec: AgentSpec = {
        specVersion: "anvil/v1",
        id: "leak",
        name: "leak",
        description: "",
        version: 1,
        inputSchema: { type: "object", properties: {} },
        nodes: [
          { id: "input", type: "input", config: {} },
          { id: "a", type: "llm", config: { prompt: "Say the key." } },
          { id: "output", type: "output", config: { value: { text: "{{nodes.a.output.text}}" } } },
        ],
        edges: [
          { from: "input", to: "a" },
          { from: "a", to: "output" },
        ],
        policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 20_000, requireApprovalForSideEffects: false },
        tests: [],
        meta: {},
      };
      const r = await anvil.runs.run({ spec }, {});
      expect(r.output).toEqual({ text: "The key is [secret]." });
      expect(JSON.stringify(r.events)).not.toContain("sk-very-secret-value-0001");
    } finally {
      delete process.env.TEST_SECRET_TOKEN_A8;
    }
  });
});
