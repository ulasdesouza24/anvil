import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentStoreLike, KVStore } from "../core/registry.js";
import type { AgentSpec, EvaluationReport, RunRecord, StoredAgent } from "../core/types.js";

export type RunSummary = Omit<RunRecord, "events" | "nodeStates" | "input" | "output" | "stepData"> & { inputPreview?: string };

/**
 * The unsaved work of the workflow editor for one agent (docs/WORKFLOW_EDITOR.md). It is not a version:
 * runs, triggers and the API use the saved versions only.
 */
export interface WorkflowDraft {
  agentId: string;
  /** The version that the draft started from. A save checks that no newer version came after it. */
  baseVersion: number;
  spec: AgentSpec;
  /** Pinned outputs of steps for test runs of the editor. They never go into a version. */
  pinData?: Record<string, { output: unknown; ports?: string[] }>;
  /** The input of the last test run of the editor. */
  testInput?: unknown;
  updatedAt: number;
}

/** Serializes writes per file and writes atomically (tmp + rename). */
class Writer {
  private chains = new Map<string, Promise<void>>();
  write(file: string, data: unknown): Promise<void> {
    const prev = this.chains.get(file) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
        await fsp.rename(tmp, file);
      });
    this.chains.set(file, next);
    next.finally(() => {
      if (this.chains.get(file) === next) this.chains.delete(file);
    });
    return next;
  }
  async flush() {
    await Promise.allSettled([...this.chains.values()]);
  }
  /** True when this process has a write of the file that is not done. */
  pending(file: string): boolean {
    return this.chains.has(file);
  }
}

function summarize(r: RunRecord): RunSummary {
  const { events: _e, nodeStates: _n, input, output: _o, stepData: _s, ...rest } = r;
  const preview = JSON.stringify(input ?? {});
  return { ...rest, inputPreview: preview.length > 160 ? `${preview.slice(0, 160)}…` : preview };
}

/** True when another process with this id is alive. */
export function ownedByLiveProcess(pid: number | undefined): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists, but it belongs to another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class FileStore implements AgentStoreLike, KVStore {
  private agents = new Map<string, StoredAgent>();
  private runs = new Map<string, RunSummary>();
  private runCache = new Map<string, RunRecord>();
  private kvCache = new Map<string, Record<string, unknown>>();
  /** The modification time of each KV file when this process read or wrote it last. */
  private kvMtime = new Map<string, number>();
  private writer = new Writer();
  readonly agentsDir: string;
  readonly runsDir: string;
  readonly kvDir: string;
  readonly classesDir: string;
  readonly draftsDir: string;
  private classDefs = new Map<string, Record<string, unknown>>();

  constructor(readonly dir: string) {
    this.agentsDir = path.join(dir, "agents");
    this.runsDir = path.join(dir, "runs");
    this.kvDir = path.join(dir, "kv");
    this.classesDir = path.join(dir, "classes");
    this.draftsDir = path.join(dir, "drafts");
  }

  init(): this {
    for (const d of [this.agentsDir, this.runsDir, this.kvDir, this.classesDir, this.draftsDir]) fs.mkdirSync(d, { recursive: true });
    for (const f of fs.readdirSync(this.classesDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(this.classesDir, f), "utf8")) as Record<string, unknown>;
        this.classDefs.set(String(c.type), c);
      } catch (e) {
        console.warn(`[store] skipping corrupt class file ${f}: ${(e as Error).message}`);
      }
    }
    for (const f of fs.readdirSync(this.agentsDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const a = JSON.parse(fs.readFileSync(path.join(this.agentsDir, f), "utf8")) as StoredAgent;
        this.agents.set(a.id, a);
      } catch (e) {
        console.warn(`[store] skipping corrupt agent file ${f}: ${(e as Error).message}`);
      }
    }
    for (const f of fs.readdirSync(this.runsDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.runsDir, f), "utf8")) as RunRecord;
        // A run of another live process (the CLI next to the server) is not interrupted: that process ends it.
        // A top run that waited for a person keeps its status: the server starts it again from its checkpoint (docs/RECOVERY.md).
        const recoverable = r.status === "waiting" && !r.parentRunId && !!r.checkpoint;
        if ((r.status === "running" || r.status === "waiting" || r.status === "queued") && !recoverable && !ownedByLiveProcess(r.pid)) {
          r.status = "failed";
          r.error = "Interrupted: the server stopped while this run was in progress";
          r.endedAt = r.endedAt ?? Date.now();
          fs.writeFileSync(path.join(this.runsDir, f), JSON.stringify(r, null, 2));
        }
        this.runs.set(r.id, summarize(r));
      } catch (e) {
        console.warn(`[store] skipping corrupt run file ${f}: ${(e as Error).message}`);
      }
    }
    return this;
  }

  /* -------------------------------- agents -------------------------------- */

  getAgent(id: string): StoredAgent | undefined {
    return this.agents.get(id);
  }

  listAgents(): StoredAgent[] {
    return [...this.agents.values()].sort((a, b) => Number(!!a.system) - Number(!!b.system) || b.updatedAt - a.updatedAt);
  }

  getSpec(id: string, version?: number): AgentSpec | undefined {
    const a = this.agents.get(id);
    if (!a) return undefined;
    const v = version ?? a.currentVersion;
    return a.versions.find((x) => x.version === v)?.spec;
  }

  uniqueId(base: string): string {
    const clean =
      base
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 56) || "agent";
    if (!this.agents.has(clean)) return clean;
    for (let i = 2; ; i++) if (!this.agents.has(`${clean}-${i}`)) return `${clean}-${i}`;
  }

  async saveVersion(
    spec: AgentSpec,
    opts: { note: string; score?: number; evaluation?: unknown; buildRunId?: string; system?: boolean; keepCurrent?: boolean },
  ): Promise<StoredAgent> {
    const now = Date.now();
    const existing = this.agents.get(spec.id);
    const version = existing ? Math.max(...existing.versions.map((v) => v.version)) + 1 : 1;
    const versioned: AgentSpec = { ...structuredClone(spec), version };
    const entry = {
      version,
      spec: versioned,
      createdAt: now,
      note: opts.note,
      score: opts.score,
      evaluation: opts.evaluation ? { ...(opts.evaluation as EvaluationReport), version } : undefined,
      buildRunId: opts.buildRunId,
    };
    const agent: StoredAgent = existing
      ? opts.keepCurrent
        ? // A draft version: the current version and its name stay.
          { ...existing, updatedAt: now, versions: [...existing.versions, entry] }
        : { ...existing, name: spec.name, description: spec.description, updatedAt: now, currentVersion: version, versions: [...existing.versions, entry] }
      : { id: spec.id, name: spec.name, description: spec.description, system: opts.system, createdAt: now, updatedAt: now, currentVersion: version, versions: [entry] };
    this.agents.set(agent.id, agent);
    await this.writer.write(path.join(this.agentsDir, `${agent.id}.json`), agent);
    return agent;
  }

  /** Replace a system agent's definition in place (keeps a single version). */
  async upsertSystemAgent(spec: AgentSpec): Promise<StoredAgent> {
    const now = Date.now();
    const existing = this.agents.get(spec.id);
    const agent: StoredAgent = {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      system: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      currentVersion: 1,
      versions: [{ version: 1, spec: { ...spec, version: 1 }, createdAt: now, note: "system definition" }],
    };
    this.agents.set(agent.id, agent);
    await this.writer.write(path.join(this.agentsDir, `${agent.id}.json`), agent);
    return agent;
  }

  async setCurrentVersion(id: string, version: number): Promise<StoredAgent> {
    const a = this.agents.get(id);
    if (!a) throw new Error(`Agent ${id} not found`);
    if (!a.versions.some((v) => v.version === version)) throw new Error(`Agent ${id} has no version ${version}`);
    a.currentVersion = version;
    a.updatedAt = Date.now();
    await this.writer.write(path.join(this.agentsDir, `${id}.json`), a);
    return a;
  }

  async attachEvaluation(id: string, version: number, evaluation: EvaluationReport): Promise<void> {
    const a = this.agents.get(id);
    const v = a?.versions.find((x) => x.version === version);
    if (!a || !v) return;
    v.evaluation = { ...evaluation, version };
    v.score = evaluation.score;
    await this.writer.write(path.join(this.agentsDir, `${id}.json`), a);
  }

  async setMeta(id: string, version: number, meta: Record<string, unknown>): Promise<void> {
    const a = this.agents.get(id);
    const v = a?.versions.find((x) => x.version === version);
    if (!a || !v) return;
    v.spec = { ...v.spec, meta: { ...(v.spec.meta ?? {}), ...meta } };
    await this.writer.write(path.join(this.agentsDir, `${id}.json`), a);
  }

  /** Replaces the tests of a version. Tests do not change what the agent does, so no new version is made (docs/FEEDBACK.md). */
  async setTests(id: string, version: number, tests: AgentSpec["tests"]): Promise<void> {
    const a = this.agents.get(id);
    const v = a?.versions.find((x) => x.version === version);
    if (!a || !v) throw new Error(`Agent ${id} has no version ${version}`);
    v.spec = { ...v.spec, tests };
    a.updatedAt = Date.now();
    await this.writer.write(path.join(this.agentsDir, `${id}.json`), a);
  }

  async deleteAgent(id: string): Promise<boolean> {
    const a = this.agents.get(id);
    if (!a || a.system) return false;
    this.agents.delete(id);
    await this.writer.flush();
    await fsp.rm(path.join(this.agentsDir, `${id}.json`), { force: true });
    await fsp.rm(this.draftFile(id), { force: true });
    return true;
  }

  /** The highest version number of an agent (a saved version can be newer than the current version). */
  latestVersion(id: string): number | undefined {
    const a = this.agents.get(id);
    return a ? Math.max(...a.versions.map((v) => v.version)) : undefined;
  }

  /* ------------------------- drafts (docs/WORKFLOW_EDITOR.md) ------------------------- */

  private draftFile(id: string) {
    return path.join(this.draftsDir, `${id}.json`);
  }

  async getDraft(id: string): Promise<WorkflowDraft | undefined> {
    try {
      return JSON.parse(await fsp.readFile(this.draftFile(id), "utf8")) as WorkflowDraft;
    } catch {
      return undefined;
    }
  }

  async saveDraft(draft: WorkflowDraft): Promise<WorkflowDraft> {
    await this.writer.write(this.draftFile(draft.agentId), draft);
    return draft;
  }

  async deleteDraft(id: string): Promise<boolean> {
    await this.writer.flush();
    const file = this.draftFile(id);
    if (!fs.existsSync(file)) return false;
    await fsp.rm(file, { force: true });
    return true;
  }

  /* --------------------------------- runs --------------------------------- */

  async saveRun(r: RunRecord): Promise<void> {
    this.runs.set(r.id, summarize(r));
    this.runCache.set(r.id, r);
    if (this.runCache.size > 200) this.runCache.delete(this.runCache.keys().next().value!);
    await this.writer.write(path.join(this.runsDir, `${r.id}.json`), r);
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const hit = this.runCache.get(id);
    if (hit) return hit;
    try {
      return JSON.parse(await fsp.readFile(path.join(this.runsDir, `${id}.json`), "utf8")) as RunRecord;
    } catch {
      return undefined;
    }
  }

  listRuns(filter: { agentId?: string; kind?: string; limit?: number; includeChildren?: boolean } = {}): RunSummary[] {
    return [...this.runs.values()]
      .filter(
        (r) =>
          (!filter.agentId || r.agentId === filter.agentId || r.resultAgentId === filter.agentId) &&
          (!filter.kind || r.kind === filter.kind) &&
          (filter.includeChildren || !r.parentRunId),
      )
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, filter.limit ?? 100);
  }

  allRunSummaries(): RunSummary[] {
    return [...this.runs.values()];
  }

  /* -------------------------------- classes ------------------------------- */

  listClassDefs(): Record<string, unknown>[] {
    return [...this.classDefs.values()];
  }

  getClassDef(type: string): Record<string, unknown> | undefined {
    return this.classDefs.get(type);
  }

  /** Saves a class definition; the previous version is kept in `history` (last 5). */
  async saveClassDef(def: Record<string, unknown>): Promise<Record<string, unknown>> {
    const prev = this.classDefs.get(String(def.type));
    const { history: _h, ...prevBare } = prev ?? {};
    const next = {
      ...def,
      version: prev ? Number(prev.version ?? 1) + 1 : Number(def.version ?? 1),
      history: prev ? [prevBare, ...((prev.history as unknown[]) ?? [])].slice(0, 5) : [],
    };
    this.classDefs.set(String(def.type), next);
    await this.writer.write(path.join(this.classesDir, `${def.type}.json`), next);
    return next;
  }

  async deleteClassDef(type: string): Promise<boolean> {
    if (!this.classDefs.delete(type)) return false;
    await this.writer.flush();
    await fsp.rm(path.join(this.classesDir, `${type}.json`), { force: true });
    return true;
  }

  /* ---------------------------------- kv ---------------------------------- */

  private kvFile(ns: string) {
    return path.join(this.kvDir, `${ns.replace(/[^a-zA-Z0-9_.-]+/g, "_")}.json`);
  }

  /**
   * The data of a namespace. Another process (the CLI next to the server) can change the file:
   * when the file is newer than the copy in memory, and this process has no write of it that is
   * not done, the file is read again.
   */
  private async kvLoad(ns: string): Promise<Record<string, unknown>> {
    const file = this.kvFile(ns);
    const hit = this.kvCache.get(ns);
    if (hit && this.writer.pending(file)) return hit;
    const mtime = await fsp.stat(file).then(
      (s) => s.mtimeMs,
      () => 0,
    );
    if (hit && mtime === this.kvMtime.get(ns)) return hit;
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      data = hit ?? {};
    }
    this.kvCache.set(ns, data);
    this.kvMtime.set(ns, mtime);
    return data;
  }

  async get(ns: string, key: string) {
    return (await this.kvLoad(ns))[key];
  }
  async set(ns: string, key: string, value: unknown) {
    const d = await this.kvLoad(ns);
    d[key] = value;
    await this.writer.write(this.kvFile(ns), d);
  }
  async delete(ns: string, key: string) {
    const d = await this.kvLoad(ns);
    delete d[key];
    await this.writer.write(this.kvFile(ns), d);
  }
  async list(ns: string) {
    return { ...(await this.kvLoad(ns)) };
  }
  /** Replaces all keys of a namespace with one write. */
  async replaceAll(ns: string, data: Record<string, unknown>) {
    this.kvCache.set(ns, { ...data });
    await this.writer.write(this.kvFile(ns), data);
  }

  async flush() {
    await this.writer.flush();
  }
}
