import { evaluateSpec } from "../builder/evaluate.js";
import type { HealthConfig } from "../core/config.js";
import { readsLiveData } from "../core/liveData.js";
import type { KVStore } from "../core/registry.js";
import type { AgentSpec, EvaluationReport, StoredAgent } from "../core/types.js";
import type { FileStore } from "../store/fileStore.js";
import type { RunManager } from "./runManager.js";

/**
 * Health checks of live data agents (docs/HEALTH.md). A source can change or
 * break after the build. At an interval, the service runs the tests of each live data agent.
 * An agent whose score falls is "broken", with the cause. Optional: evolve makes a fix as a new
 * version, and a person publishes it.
 */

export type HealthStatus = "healthy" | "broken" | "unknown";

export interface HealthCheck {
  at: number;
  version: number;
  status: HealthStatus;
  score: number | null;
  passRate: number | null;
  /** The score of the last evaluation of the version: the baseline of the check. */
  baseline: number | null;
  tests: number;
  failed: string[];
  cause?: string;
  costUsd: number;
  /** The evolve run that tries to fix a broken agent. */
  fixRunId?: string;
}

export interface AgentHealth {
  agentId: string;
  status: HealthStatus;
  last?: HealthCheck;
  history: HealthCheck[];
}

const NS = "health";

export interface HealthDeps {
  store: FileStore;
  kv: KVStore;
  runs: RunManager;
  config: HealthConfig;
  log?: (m: string) => void;
  /** Runs the tests. The default is evaluateSpec with the services of the run manager. */
  evaluate?: (spec: AgentSpec, budgetUsd: number) => Promise<EvaluationReport>;
}

/** The cause of a broken check, from the failed tests: the error, the failure class, and the failed items. */
export function causeOf(report: EvaluationReport): string {
  const failed = report.results.filter((r) => !r.passed && !r.skipped);
  if (!failed.length) return "";
  const parts = failed.slice(0, 3).map((r) => {
    const why =
      r.environment ??
      r.error ??
      [r.failureClass ? `failure class ${r.failureClass}` : "", ...r.criteria.filter((c) => !c.passed).map((c) => `"${c.criterion}" failed`), ...r.checks.filter((c) => !c.passed).map((c) => `${c.check.path} ${c.check.op} failed`)]
        .filter(Boolean)
        .slice(0, 2)
        .join(", ");
    return `${r.name}: ${String(why).slice(0, 200)}`;
  });
  return `${failed.length} of ${report.results.length} test(s) failed. ${parts.join(" | ")}`;
}

export class HealthService {
  private timer?: NodeJS.Timeout;
  private running = new Set<string>();

  constructor(private deps: HealthDeps) {}

  /** The agents that the service checks: not system agents, with tests, and with live data. */
  liveAgents(): StoredAgent[] {
    return this.deps.store.listAgents().filter((a) => {
      if (a.system) return false;
      const spec = a.versions.find((v) => v.version === a.currentVersion)?.spec;
      if (!spec?.tests?.length) return false;
      return readsLiveData(spec, (spec.meta?.taskSpec as { dataNeeds?: unknown[] } | undefined) ?? {}, (type) => this.deps.runs.services.registry.get(type)?.custom?.kind);
    });
  }

  async get(agentId: string): Promise<AgentHealth> {
    return ((await this.deps.kv.get(NS, agentId)) as AgentHealth | undefined) ?? { agentId, status: "unknown", history: [] };
  }

  async list(): Promise<AgentHealth[]> {
    return Promise.all(this.liveAgents().map((a) => this.get(a.id)));
  }

  /** Runs the tests of the current version of an agent, and saves the result. */
  async check(agentId: string): Promise<AgentHealth> {
    const agent = this.deps.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent "${agentId}" does not exist`);
    const version = agent.versions.find((v) => v.version === agent.currentVersion);
    if (!version) throw new Error(`Agent "${agentId}" has no current version`);
    if (!version.spec.tests?.length) throw new Error(`Agent "${agentId}" has no tests`);
    if (this.running.has(agentId)) throw new Error(`A health check of "${agentId}" is running`);
    this.running.add(agentId);
    try {
      const cfg = this.deps.config;
      const report = this.deps.evaluate
        ? await this.deps.evaluate(version.spec, cfg.budgetUsd)
        : (await evaluateSpec(version.spec, version.spec.tests, { services: this.deps.runs.services, brain: this.deps.runs.brain, budgetUsd: cfg.budgetUsd, concurrency: 2, freshData: true })).report;
      const baseline = (version.evaluation as EvaluationReport | undefined)?.score ?? version.score ?? null;
      const scored = report.results.filter((r) => !r.environment && !r.skipped);
      const prev = await this.get(agentId);
      let status: HealthStatus;
      let cause: string | undefined;
      if (!scored.length) {
        // The environment (for example a rate limit) stopped every test: the check says nothing about the agent.
        status = prev.status;
        cause = `not measured: ${report.results.find((r) => r.environment)?.environment ?? "no test ran"}`;
      } else {
        const low = report.score < cfg.minScore;
        const drop = baseline !== null && baseline - report.score > cfg.maxDrop;
        status = low || drop ? "broken" : "healthy";
        if (status === "broken")
          cause = `${low ? `the score ${report.score} is below ${cfg.minScore}` : `the score fell from ${baseline} to ${report.score}`}. ${causeOf(report)}`.trim();
      }
      const check: HealthCheck = {
        at: Date.now(),
        version: version.version,
        status,
        score: scored.length ? report.score : null,
        passRate: scored.length ? report.passRate : null,
        baseline,
        tests: report.results.length,
        failed: report.results.filter((r) => !r.passed).map((r) => r.name),
        ...(cause ? { cause } : {}),
        costUsd: report.costUsd,
      };
      // A newly broken agent gets one fix attempt: evolve saves a new version, and a person publishes it.
      if (status === "broken" && prev.status !== "broken" && cfg.evolve) {
        const rec = this.deps.runs.start({ agentId: "anvil-evolver" }, { agentId, rounds: 2, draft: true }, { kind: "refine", humanMode: "auto" });
        check.fixRunId = rec.id;
        this.deps.log?.(`health: ${agentId} is broken. Evolve run ${rec.id} tries a fix.`);
      }
      const health: AgentHealth = { agentId, status, last: check, history: [check, ...prev.history].slice(0, cfg.historyMax) };
      await this.deps.kv.set(NS, agentId, health);
      if (status !== prev.status) this.deps.log?.(`health: ${agentId} is ${status}${cause ? ` (${cause.slice(0, 160)})` : ""}`);
      return health;
    } finally {
      this.running.delete(agentId);
    }
  }

  /** Checks each live data agent whose last check is older than the interval. One agent at a time. */
  async tick(now = Date.now()): Promise<string[]> {
    const due: string[] = [];
    for (const a of this.liveAgents()) {
      const h = await this.get(a.id);
      if (!h.last || now - h.last.at >= this.deps.config.everyMs) due.push(a.id);
    }
    for (const id of due) {
      try {
        await this.check(id);
      } catch (e) {
        this.deps.log?.(`health: the check of ${id} failed: ${(e as Error).message}`);
      }
    }
    return due;
  }

  /** Starts the checks. The timer looks for due agents at most once each hour, and not more often than the interval. */
  start(): void {
    if (!this.deps.config.everyMs || this.timer) return;
    const every = Math.min(this.deps.config.everyMs, 3_600_000);
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
