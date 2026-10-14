import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { hostSecretValues } from "../src/core/egress.js";
import { currentEnv, runInScope } from "../src/core/scope.js";
import { runSandboxed } from "../src/core/tools/text.js";
import type { AgentSpec } from "../src/core/types.js";
import { applySettings, cleanSetting, SETTING_FIELDS, settingValues } from "../src/core/userSettings.js";
import { AccountService } from "../src/runtime/accounts.js";
import { Bazaar } from "../src/runtime/bazaar.js";
import { isBlockedAddress } from "../src/runtime/netGuard.js";
import { WorkspaceManager } from "../src/runtime/workspaces.js";
import { FakeClient, tmpDir } from "./helpers.js";

const KEY = "k".repeat(40);
const SESSION = "s".repeat(40);

const echoSpec = (id: string, extra: Partial<AgentSpec> = {}): AgentSpec => ({
  specVersion: "anvil/v1",
  id,
  name: id,
  description: "Echo",
  version: 1,
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  nodes: [
    { id: "input", type: "input", config: {} },
    { id: "output", type: "output", config: { value: { text: "{{input.text}}" } } },
  ],
  edges: [{ from: "input", to: "output" }],
  policy: { maxCostUsd: 1, maxNodeExecutions: 50, timeoutMs: 60_000, requireApprovalForSideEffects: false },
  tests: [{ id: "t1", name: "private test", input: { text: "my private data" }, criteria: [], checks: [] }],
  meta: { request: "private request" },
  ...extra,
});

describe("hosted: accounts", () => {
  it("registers, signs in, and refuses a bad password, a taken name, and a reserved name", () => {
    const dir = tmpDir();
    const a = new AccountService(dir, SESSION, KEY).load();
    const r = a.register("Ada_1", "password123");
    expect(a.verify(r.token)).toEqual(r.account);
    expect(() => a.register("ada_1", "password123")).toThrow(/taken/);
    expect(() => a.register("admin", "password123")).toThrow(/reserved/);
    expect(() => a.register("x", "password123")).toThrow(/3 to 24/);
    expect(() => a.register("bob", "short")).toThrow(/8 characters/);
    expect(() => a.login("ada_1", "wrong-pass")).toThrow(/wrong/);
    expect(a.login("ADA_1", "password123").account.id).toBe(r.account.id);
    // The accounts survive a restart.
    expect(new AccountService(dir, SESSION, KEY).load().verify(r.token)?.username).toBe("Ada_1");
    // The password hash never leaves the service.
    expect(JSON.stringify(a.list())).not.toContain("hash");
  });

  it("rejects a token with a bad signature, from another secret, or after a logout of all sessions", () => {
    const a = new AccountService(tmpDir(), SESSION, KEY).load();
    const { token, account } = a.register("carol", "password123");
    const [body, sig] = token.split(".");
    expect(a.verify(`${body}.${sig.slice(0, -2)}xx`)).toBeUndefined();
    expect(new AccountService(tmpDir(), "t".repeat(40), KEY).load().verify(token)).toBeUndefined();
    a.logoutAll(account.id);
    expect(a.verify(token)).toBeUndefined();
  });

  it("limits the attempts of one client address", () => {
    const a = new AccountService(tmpDir(), SESSION, KEY).load();
    for (let i = 0; i < 3; i++) a.limit("login", "1.2.3.4", 3);
    expect(() => a.limit("login", "1.2.3.4", 3)).toThrow(/Too many/);
    expect(() => a.limit("login", "5.6.7.8", 3)).not.toThrow();
  });
});

describe("hosted: settings", () => {
  it("checks each value against its field", () => {
    expect(cleanSetting("thresholds.criterionPass", "0.7")).toBe(0.7);
    expect(() => cleanSetting("thresholds.criterionPass", 2)).toThrow(/maximum is 1/);
    expect(cleanSetting("bestOf.models", "a/b, c/d")).toEqual(["a/b", "c/d"]);
    expect(() => cleanSetting("searchProviders", ["google"])).toThrow(/not one of/);
    expect(() => cleanSetting("llmModel", "bad model!")).toThrow(/model id/);
    expect(() => cleanSetting("port", 1)).toThrow(/not a setting/);
    expect(() => cleanSetting("decisionModel", "x/y")).toThrow(/not a setting/);
    expect(SETTING_FIELDS.every((f) => settingValues(loadConfig())[f.path] !== undefined)).toBe(true);
  });

  it("puts the settings of a user on top of the server config, and the tiers follow the System 2 model", () => {
    const base = loadConfig();
    const cfg = applySettings(base, { llmModel: "x/my-model", "tiers.deep.model": "y/deep", "bestOf.enabled": true });
    expect(cfg.llmModel).toBe("x/my-model");
    expect(cfg.tiers.fast.model).toBe("x/my-model");
    expect(cfg.tiers.deep.model).toBe("y/deep");
    expect(cfg.bestOf.enabled).toBe(true);
    expect(base.llmModel).not.toBe("x/my-model");
  });

  it("stores the key encrypted and gives only its last 4 characters", () => {
    const dir = tmpDir();
    const a = new AccountService(dir, SESSION, KEY).load();
    const { account } = a.register("dan", "password123");
    const s = a.settingsStore();
    s.setApiKey(account.id, "sk-or-v1-abcdefghijklmnopqrstuvwxyz1234");
    expect(s.keyHint(account.id)).toBe("…1234");
    expect(fs.readFileSync(path.join(a.userDir(account.id), "settings.json"), "utf8")).not.toContain("abcdefghijklmnop");
    expect(() => s.setApiKey(account.id, "not a key")).toThrow(/OpenRouter key/);
    s.setValues(account.id, { "thresholds.actionGate": 0.8 });
    s.setValues(account.id, { "thresholds.actionGate": null, evolveMaxRounds: 3 });
    expect(s.settings(account.id).values).toEqual({ evolveMaxRounds: 3 });
  });
});

describe("hosted: workspaces", () => {
  it("gives each user an own data folder, config, key, and secrets", async () => {
    const dir = tmpDir();
    const accounts = new AccountService(dir, SESSION, KEY).load();
    const ann = accounts.register("ann", "password123").account;
    const ben = accounts.register("ben", "password123").account;
    const settings = accounts.settingsStore();
    settings.setApiKey(ann.id, "sk-or-v1-annkeyannkeyannkeyannkey");
    settings.setValues(ann.id, { llmModel: "ann/model" });
    const base = { ...loadConfig(), hosted: true, dataDir: dir, apiKey: "" };
    const client = new FakeClient();
    const wm = new WorkspaceManager(base, { settings, accounts, secretsKey: KEY, createOptions: { client }, log: () => undefined });
    const a = await wm.user(ann.id);
    const b = await wm.user(ben.id);
    expect(a.anvil.config.llmModel).toBe("ann/model");
    expect(a.anvil.config.apiKey).toBe("sk-or-v1-annkeyannkeyannkeyannkey");
    expect(b.anvil.config.apiKey).toBe("");
    expect(a.anvil.config.sandbox.mode).toBe("off");
    await a.anvil.store.saveVersion(echoSpec("anns-agent"), { note: "t" });
    expect(b.anvil.store.getAgent("anns-agent")).toBeUndefined();
    // A secret of ann is in the env of her workspace only, never in the process environment.
    runInScope(a.scope, () => a.anvil.secrets.set("MY_TOKEN", "ann-secret-value-123"));
    expect(a.scope.env.MY_TOKEN).toBe("ann-secret-value-123");
    expect(b.scope.env.MY_TOKEN).toBeUndefined();
    expect(process.env.MY_TOKEN).toBeUndefined();
    runInScope(b.scope, () => expect(currentEnv().MY_TOKEN).toBeUndefined());
    runInScope(a.scope, () => expect(hostSecretValues()).toContain("ann-secret-value-123"));
    // A settings change goes into the open workspace at once.
    settings.setValues(ben.id, { evolveMaxRounds: 5 });
    await wm.refresh(ben.id);
    expect(b.anvil.config.evolveMaxRounds).toBe(5);
    await wm.closeAll();
  });

  it("runs an agent of a user in the scope of that user", async () => {
    const dir = tmpDir();
    const accounts = new AccountService(dir, SESSION, KEY).load();
    const u = accounts.register("eve", "password123").account;
    const wm = new WorkspaceManager(
      { ...loadConfig(), hosted: true, dataDir: dir },
      { settings: accounts.settingsStore(), accounts, secretsKey: KEY, createOptions: { client: new FakeClient() }, log: () => undefined },
    );
    const w = await wm.user(u.id);
    runInScope(w.scope, () => w.anvil.secrets.set("EVE_HOOK", "https://example.invalid/eve"));
    const spec = echoSpec("hook-agent");
    spec.nodes.splice(1, 0, { id: "send", type: "send_webhook", config: { urlSecret: "EVE_HOOK", body: { a: 1 } } });
    spec.edges = [
      { from: "input", to: "send" },
      { from: "send", to: "output" },
    ];
    spec.nodes[2].config = { value: { sent: "{{nodes.send.output}}" } };
    const rec = await runInScope(w.scope, () => w.anvil.runs.run({ spec }, { text: "x" }, { dryRun: true }));
    expect(rec.status).toBe("completed");
    expect((rec.output as { sent: { dryRun: boolean } }).sent.dryRun).toBe(true);
    // A code step of the user cannot read a secret: code has no environment.
    const code = echoSpec("code-agent");
    code.nodes.splice(1, 0, { id: "peek", type: "code", config: { code: "return { v: typeof process === 'undefined' ? 'none' : 'leak' };" } });
    code.edges = [
      { from: "input", to: "peek" },
      { from: "peek", to: "output" },
    ];
    code.nodes[2].config = { value: "{{nodes.peek.output}}" };
    expect((await runInScope(w.scope, () => w.anvil.runs.run({ spec: code }, {}))).output).toEqual({ v: "none" });
    await wm.closeAll();
  });
});

describe("hosted: the Agent Bazaar", () => {
  async function two() {
    const dir = tmpDir();
    const accounts = new AccountService(dir, SESSION, KEY).load();
    const owner = accounts.register("owner", "password123").account;
    const user = accounts.register("user", "password123").account;
    const wm = new WorkspaceManager(
      { ...loadConfig(), hosted: true, dataDir: dir },
      { settings: accounts.settingsStore(), accounts, secretsKey: KEY, createOptions: { client: new FakeClient() }, log: () => undefined },
    );
    const bazaar = new Bazaar(dir, (id) => accounts.get(id)?.username ?? "?").load();
    return { dir, accounts, owner, user, wm, bazaar, o: await wm.user(owner.id), u: await wm.user(user.id) };
  }

  const cls = (type: string, code = "return { n: config.n * 2 };") => ({
    type,
    title: "Double",
    description: "Doubles a number for the test",
    whenToUse: "In tests",
    configSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
    outputSchema: { type: "object", properties: { n: { type: "number" } } },
    impl: { kind: "code", code },
  });

  it("shares a snapshot under the username, without private tests and history, and copies it with its classes", async () => {
    const { o, u, owner, user, bazaar, wm } = await two();
    await o.anvil.classes.save(cls("x_double"), { test: false });
    const spec = echoSpec("doubler");
    spec.nodes.splice(1, 0, { id: "dbl", type: "x_double", config: { n: 21 } });
    spec.edges = [
      { from: "input", to: "dbl" },
      { from: "dbl", to: "output" },
    ];
    spec.nodes[2].config = { value: { n: "{{nodes.dbl.output.n}}" } };
    spec.triggers = [{ id: "daily", type: "schedule", cron: "0 9 * * *", enabled: true }];
    await o.anvil.store.saveVersion(spec, { note: "t" });
    const l = bazaar.share(owner.id, o.anvil, { agentId: "doubler", title: "Doubler", tags: ["Math", "bad tag!"] });
    expect(l).toMatchObject({ owner: "owner", title: "Doubler", tags: ["math"], steps: 3 });
    const full = bazaar.get(l.id)!;
    expect(full.spec.tests).toEqual([]);
    expect(full.spec.meta).not.toHaveProperty("request");
    expect(full.classes).toEqual([{ type: "x_double", title: "Double", kind: "code", sideEffects: false }]);
    // The user has another class with the same name: the copy gets a free name.
    await u.anvil.classes.save(cls("x_double", "return { n: 0 };"), { test: false });
    const r = await bazaar.use(l.id, user.id, u.anvil);
    expect(r.classes).toEqual(["x_double_2"]);
    const copy = u.anvil.store.getSpec(r.agentId)!;
    expect(copy.nodes[1].type).toBe("x_double_2");
    expect(copy.meta.bazaar).toMatchObject({ listingId: l.id, owner: "owner" });
    expect(copy.triggers).toEqual([expect.objectContaining({ id: "daily", enabled: false })]);
    const run = await u.anvil.runs.run({ agentId: r.agentId }, { text: "x" });
    expect(run.output).toEqual({ n: 42 });
    expect(bazaar.list({ sort: "popular" })[0].uses).toBe(1);
    // A new share of the same agent updates the listing. Only the owner can remove it.
    expect(bazaar.share(owner.id, o.anvil, { agentId: "doubler", title: "Doubler 2" }).id).toBe(l.id);
    expect(() => bazaar.unshare(l.id, user.id)).toThrow(/Only the owner/);
    bazaar.unshare(l.id, owner.id);
    expect(bazaar.list()).toEqual([]);
    await wm.closeAll();
  });

  it("refuses an agent that calls other agents, and a system agent", async () => {
    const { o, owner, bazaar, wm } = await two();
    const spec = echoSpec("caller");
    spec.nodes.splice(1, 0, { id: "sub", type: "subagent", config: { agentId: "other", input: {} } });
    await o.anvil.store.saveVersion(spec, { note: "t" });
    expect(() => bazaar.share(owner.id, o.anvil, { agentId: "caller" })).toThrow(/call your other agents/);
    expect(() => bazaar.share(owner.id, o.anvil, { agentId: "anvil-builder" })).toThrow(/No such agent/);
    await wm.closeAll();
  });
});

describe("hosted: security", () => {
  it("blocks private, local, and metadata addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd12::1", "fe80::1", "::ffff:10.0.0.1"])
      expect(isBlockedAddress(a)).toBe(true);
    for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "93.184.215.14"]) expect(isBlockedAddress(a)).toBe(false);
  });

  it("runs code in QuickJS: no Node, no process, time and memory limits", () => {
    expect(runSandboxed("return { n: input.n + 1, d: new Date(0) };", { input: { n: 1 } })).toEqual({ n: 2, d: "1970-01-01T00:00:00.000Z" });
    expect(() => runSandboxed('return Object.constructor("return process")().pid;', {})).toThrow(/process/);
    expect(runSandboxed("return [typeof require, typeof process, typeof fetch, typeof globalThis.Buffer];", {})).toEqual(["undefined", "undefined", "undefined", "undefined"]);
    expect(() => runSandboxed("while (true) {}", {}, 200)).toThrow(/timed out/);
    expect(() => runSandboxed("const a = []; while (true) a.push('x'.repeat(1e6));", {}, 5000)).toThrow(/64 MB/);
  });
});
