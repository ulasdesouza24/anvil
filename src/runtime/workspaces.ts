import type { AnvilConfig } from "../core/config.js";
import { runInScope, type WorkspaceScope } from "../core/scope.js";
import { applySettings, assignConfig } from "../core/userSettings.js";
import type { AccountService } from "./accounts.js";
import type { SettingsStore } from "./settingsStore.js";
import { createAnvil, type Anvil, type CreateAnvilOptions } from "./anvil.js";
import { FeedbackService } from "./feedback.js";
import { HealthService } from "./health.js";
import { SessionService } from "./sessions.js";

/**
 * A workspace (docs/HOSTING.md): the agents, runs, classes, secrets, triggers, and settings of one user.
 * The local Anvil has one workspace. A hosted Anvil has one workspace for each account, each in its own data
 * folder and its own scope, so a user never sees or changes the data of another user.
 */
export interface Workspace {
  /** The account id, or "local". */
  id: string;
  anvil: Anvil;
  scope: WorkspaceScope;
  sessions: SessionService;
  health: HealthService;
  feedback: FeedbackService;
}

/** Runs fn in the scope of the workspace. A run or a timer that starts in fn keeps the scope. */
export const inWorkspace = <T>(ws: Workspace, fn: () => T): T => runInScope(ws.scope, fn);

async function open(id: string, opts: CreateAnvilOptions, scope: WorkspaceScope, log: (m: string) => void): Promise<Workspace> {
  return runInScope(scope, async () => {
    const anvil = await createAnvil({ ...opts, scope });
    const { store, runs, config } = anvil;
    const ws: Workspace = {
      id,
      anvil,
      scope,
      sessions: new SessionService(store),
      health: new HealthService({ store, kv: store, runs, config: config.health, log }),
      feedback: new FeedbackService({ store, kv: store, brain: runs.brain, runs }),
    };
    // The runs that waited for a person start again before the triggers (docs/RECOVERY.md).
    const recovered = await runs.recover();
    if (recovered.length) log(`[runs] ${id}: recovered ${recovered.length} waiting run(s)`);
    await anvil.triggers.start();
    void anvil.mcp.connectAll();
    ws.health.start();
    return ws;
  });
}

export class WorkspaceManager {
  private open = new Map<string, Promise<Workspace>>();

  constructor(
    private base: AnvilConfig,
    private deps: {
      /** The settings of each workspace ("local", or an account id). */
      settings: SettingsStore;
      /** Set for a hosted Anvil: one workspace for each account. */
      accounts?: AccountService;
      secretsKey?: string;
      log?: (m: string) => void;
      createOptions?: CreateAnvilOptions;
    },
  ) {}

  get hosted(): boolean {
    return !!this.deps.accounts;
  }

  /** The workspace of the local Anvil: the process environment holds its secrets. */
  local(): Promise<Workspace> {
    let p = this.open.get("local");
    if (!p) {
      const scope: WorkspaceScope = { env: process.env, hostHeaders: {} };
      p = open("local", { ...this.deps.createOptions, config: { ...this.deps.createOptions?.config, ...this.configFor("local") } }, scope, this.log);
      this.open.set("local", p);
    }
    return p;
  }

  /** The config of a workspace: the server config, the settings and the key of the user, and the data folder. */
  configFor(id: string): AnvilConfig {
    const cfg = applySettings(this.base, this.deps.settings.settings(id).values);
    // The local Anvil can use the key in .env. A hosted user always gives an own key.
    cfg.apiKey = this.deps.settings.apiKey(id) || (id === "local" ? this.base.apiKey : "");
    if (id === "local") return cfg;
    cfg.dataDir = this.deps.accounts!.userDir(id);
    // A hosted workspace runs programs only in gVisor behind the Docker guard (docs/HOSTING.md). Without the runtime, the sandbox stays off.
    if (!cfg.sandbox.runtime) cfg.sandbox = { ...cfg.sandbox, mode: "off" };
    return cfg;
  }

  /** The workspace of a user. It opens at the first use and stays open (its triggers run). */
  user(userId: string): Promise<Workspace> {
    let p = this.open.get(userId);
    if (!p) {
      // A hosted workspace never reads the process environment: its env has only the secrets of the user.
      const scope: WorkspaceScope = { env: {}, hostHeaders: {} };
      p = open(userId, { ...this.deps.createOptions, config: this.configFor(userId), secretsKey: this.deps.secretsKey }, scope, this.log).catch((e) => {
        this.open.delete(userId);
        throw e;
      });
      this.open.set(userId, p);
    }
    return p;
  }

  /** After a change of the settings or the key: the open workspace uses the new values at once. */
  async refresh(userId: string): Promise<void> {
    const p = this.open.get(userId);
    if (!p) return;
    const ws = await p;
    assignConfig(ws.anvil.config, this.configFor(userId));
  }

  /** Stops and forgets the workspace of a user: its triggers, health checks, MCP connections, browser, and sandbox. */
  async close(userId: string): Promise<void> {
    const p = this.open.get(userId);
    if (!p) return;
    this.open.delete(userId);
    const ws = await p.catch(() => undefined);
    if (!ws) return;
    ws.anvil.triggers.stop();
    ws.health.stop();
    for (const r of ws.anvil.store.listRuns({ limit: Number.MAX_SAFE_INTEGER })) if (ws.anvil.runs.isActive(r.id)) ws.anvil.runs.cancel(r.id);
    await ws.anvil.mcp.closeAll().catch(() => undefined);
    await ws.anvil.browser.close().catch(() => undefined);
    await ws.anvil.sandbox.dispose().catch(() => undefined);
    await ws.anvil.store.flush();
  }

  /** Opens the workspace of each account, so the triggers of each user run after a restart. */
  async openAll(): Promise<number> {
    const accounts = this.deps.accounts?.list() ?? [];
    for (const a of accounts) await this.user(a.id).catch((e) => this.log(`[workspaces] ${a.id}: ${(e as Error).message}`));
    return accounts.length;
  }

  async all(): Promise<Workspace[]> {
    return Promise.all([...this.open.values()]);
  }

  async closeAll(): Promise<void> {
    for (const ws of await this.all()) {
      ws.anvil.triggers.stop();
      ws.health.stop();
      await ws.anvil.mcp.closeAll().catch(() => undefined);
      await ws.anvil.browser.close().catch(() => undefined);
      await ws.anvil.sandbox.dispose().catch(() => undefined);
      await ws.anvil.store.flush();
    }
  }

  private log = (m: string) => (this.deps.log ?? console.log)(m);
}
