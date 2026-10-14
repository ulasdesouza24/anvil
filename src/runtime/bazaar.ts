import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { CustomClassDef } from "../core/customClass.js";
import type { AgentSpec, StoredAgent } from "../core/types.js";
import { stable } from "../core/workflow.js";
import type { Anvil } from "./anvil.js";

/**
 * The Agent Bazaar (docs/BAZAAR.md): a user shares an agent under the username, and other users add it to their
 * own workspace. A listing is a snapshot: the spec of one version and the library classes that it uses. A user
 * who adds a listing gets a copy, and runs it with the own key. A change of the owner never changes the copy.
 */

export interface Listing {
  id: string;
  ownerId: string;
  /** The agent of the owner (a new share of the same agent updates the listing). */
  agentId: string;
  version: number;
  title: string;
  description: string;
  tags: string[];
  spec: AgentSpec;
  classes: CustomClassDef[];
  createdAt: number;
  updatedAt: number;
  /** How many users added it. */
  uses: number;
}

export type ListingSummary = Omit<Listing, "spec" | "classes"> & { owner: string; steps: number; stepTypes: string[]; inputs: string[] };

const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** The library classes (x_ types) that a spec uses: as a step, in a map step, or as a tool of an agent step. */
export function classTypesOf(spec: AgentSpec): string[] {
  const out = new Set<string>();
  for (const n of spec.nodes) {
    if (n.type.startsWith("x_")) out.add(n.type);
    const c = n.config as Record<string, unknown>;
    if (typeof c.nodeType === "string" && c.nodeType.startsWith("x_")) out.add(c.nodeType);
    for (const k of ["classes", "noConfirmation"]) if (Array.isArray(c[k])) for (const t of c[k] as unknown[]) if (typeof t === "string" && t.startsWith("x_")) out.add(t);
  }
  return [...out].sort();
}

/** The steps that call other saved agents: a shared copy cannot call the agents of its owner. */
function agentCalls(spec: AgentSpec): string[] {
  return spec.nodes
    .filter((n) => {
      const c = n.config as Record<string, unknown>;
      return n.type === "subagent" || (n.type === "map" && c.mode === "agent") || (Array.isArray(c.tools) && (c.tools as string[]).includes("call_agent"));
    })
    .map((n) => n.id);
}

/** A class without its lifecycle fields: two copies of the same class compare equal. */
const classBody = (d: CustomClassDef) => {
  const { createdAt: _c, createdBy: _b, approved: _a, status: _s, testReport: _t, version: _v, ...rest } = d;
  return stable(rest);
};

export class BazaarError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
  }
}

export class Bazaar {
  private file: string;
  private listings: Listing[] = [];

  constructor(
    dataDir: string,
    private usernameOf: (ownerId: string) => string,
  ) {
    this.file = path.join(dataDir, "bazaar", "listings.json");
  }

  load(): this {
    if (fs.existsSync(this.file)) this.listings = (JSON.parse(fs.readFileSync(this.file, "utf8")) as { listings: Listing[] }).listings ?? [];
    return this;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ listings: this.listings }, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  private summary(l: Listing): ListingSummary {
    const { spec, classes: _c, ...rest } = l;
    return {
      ...rest,
      owner: this.usernameOf(l.ownerId),
      steps: spec.nodes.length,
      stepTypes: [...new Set(spec.nodes.map((n) => n.type))],
      inputs: Object.keys(spec.inputSchema?.properties ?? {}),
    };
  }

  /** The listings, newest first. q searches the title, the description, the tags, and the username. */
  list(opts: { q?: string; owner?: string; sort?: "new" | "popular" } = {}): ListingSummary[] {
    const q = opts.q?.trim().toLowerCase();
    return this.listings
      .map((l) => this.summary(l))
      .filter((s) => !opts.owner || s.ownerId === opts.owner)
      .filter((s) => !q || [s.title, s.description, s.owner, ...s.tags].some((t) => t.toLowerCase().includes(q)))
      .sort((a, b) => (opts.sort === "popular" ? b.uses - a.uses || b.updatedAt - a.updatedAt : b.updatedAt - a.updatedAt));
  }

  get(id: string): (ListingSummary & { spec: AgentSpec; classes: { type: string; title: string; kind: string; sideEffects: boolean }[] }) | undefined {
    const l = this.listings.find((x) => x.id === id);
    if (!l) return undefined;
    return { ...this.summary(l), spec: l.spec, classes: l.classes.map((c) => ({ type: c.type, title: c.title, kind: c.impl.kind, sideEffects: c.sideEffects })) };
  }

  /** Shares one version of an agent of the workspace. A new share of the same agent updates its listing. */
  share(ownerId: string, anvil: Anvil, input: { agentId: string; version?: number; title?: string; description?: string; tags?: string[] }): ListingSummary {
    const agent: StoredAgent | undefined = anvil.store.getAgent(input.agentId);
    if (!agent || agent.system) throw new BazaarError("No such agent in your workspace", 404);
    const version = input.version ?? agent.currentVersion;
    const spec = anvil.store.getSpec(agent.id, version);
    if (!spec) throw new BazaarError(`v${version} does not exist`, 404);
    const calls = agentCalls(spec);
    if (calls.length) throw new BazaarError(`The steps ${calls.join(", ")} call your other agents. A shared copy cannot call them: remove these calls, then share.`);
    const classes: CustomClassDef[] = [];
    for (const type of classTypesOf(spec)) {
      const def = anvil.classes.get(type);
      if (!def) throw new BazaarError(`The class ${type} is not in your library`);
      if (def.impl.kind === "mcp") throw new BazaarError(`The class ${type} is a tool of your MCP server. Other users cannot reach it: share an agent without it.`);
      classes.push(def);
    }
    const title = (input.title ?? agent.name).trim().slice(0, 80);
    if (title.length < 3) throw new BazaarError("Give a title with at least 3 characters");
    const description = (input.description ?? spec.description ?? "").trim().slice(0, 2000);
    const tags = [...new Set((input.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter((t) => TAG.test(t)))].slice(0, 8);
    const now = Date.now();
    // The snapshot keeps no data of the owner: no tests with real inputs, no evaluation, no build history.
    const snapshot: AgentSpec = { ...structuredClone(spec), tests: [], meta: { taxonomy: spec.meta?.taxonomy, interaction: spec.meta?.interaction } };
    const prior = this.listings.find((l) => l.ownerId === ownerId && l.agentId === agent.id);
    const listing: Listing = prior
      ? { ...prior, version, title, description, tags, spec: snapshot, classes, updatedAt: now }
      : { id: `bz_${nanoid(10)}`, ownerId, agentId: agent.id, version, title, description, tags, spec: snapshot, classes, createdAt: now, updatedAt: now, uses: 0 };
    this.listings = [...this.listings.filter((l) => l.id !== listing.id), listing];
    this.save();
    return this.summary(listing);
  }

  unshare(id: string, ownerId: string): void {
    const l = this.listings.find((x) => x.id === id);
    if (!l) throw new BazaarError("No such listing", 404);
    if (l.ownerId !== ownerId) throw new BazaarError("Only the owner can remove a listing", 403);
    this.listings = this.listings.filter((x) => x.id !== id);
    this.save();
  }

  /** Users with a listing: when an account goes away, its listings go too. */
  removeOwner(ownerId: string): void {
    this.listings = this.listings.filter((l) => l.ownerId !== ownerId);
    this.save();
  }

  /**
   * Adds a copy of a listing to a workspace: its classes first, then the agent as a new agent. A class with a
   * side effect starts unapproved: the user approves it in the Node Library before it can change anything.
   */
  async use(id: string, userId: string, anvil: Anvil): Promise<{ agentId: string; classes: string[] }> {
    const l = this.listings.find((x) => x.id === id);
    if (!l) throw new BazaarError("No such listing", 404);
    let specText = JSON.stringify(l.spec);
    const installed: string[] = [];
    for (const def of l.classes) {
      let type = def.type;
      const mine = anvil.classes.get(type);
      if (mine && classBody(mine) !== classBody(def)) {
        // The user has another class with this name: the copy gets a free name, and the spec uses it.
        let n = 2;
        while (anvil.classes.get(`${def.type}_${n}`) || anvil.registry.get(`${def.type}_${n}`)) n++;
        type = `${def.type}_${n}`;
        specText = specText.split(JSON.stringify(def.type)).join(JSON.stringify(type));
      }
      if (!mine || type !== def.type) {
        const r = await anvil.classes.save({ ...def, type, createdBy: `bazaar:${this.usernameOf(l.ownerId)}`, approved: !def.sideEffects }, { test: false });
        if (!r.def) throw new BazaarError(`The class ${type} cannot be added: ${r.diagnostics.map((d) => d.message).join("; ")}`);
        installed.push(type);
      }
    }
    const spec = JSON.parse(specText) as AgentSpec;
    // A trigger of the copy starts off: it would run with the key of the new user (the same rule as the builder).
    if (spec.triggers) spec.triggers = spec.triggers.map((t) => ({ ...t, enabled: false }));
    const agentId = anvil.store.uniqueId(spec.id);
    await anvil.store.saveVersion(
      { ...spec, id: agentId, version: 1, meta: { ...spec.meta, bazaar: { listingId: l.id, owner: this.usernameOf(l.ownerId), version: l.version } } },
      { note: `added from the Agent Bazaar: "${l.title}" by ${this.usernameOf(l.ownerId)}` },
    );
    if (l.ownerId !== userId) {
      l.uses++;
      this.save();
    }
    return { agentId, classes: installed };
  }
}
