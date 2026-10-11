import type { RunRecord } from "../core/types.js";

/**
 * Estimates the cost of a build before it starts. The estimate comes from the
 * cost of past builds with similar features. With fewer than `minSamples`
 * similar builds, it uses fixed starting values (priors). Every finished build
 * adds one sample, so the estimate calibrates itself over time.
 */
export interface BuildFeatures {
  pattern: string;
  needsWeb: boolean;
  complexity: number;
  evaluate: boolean;
  optimize: boolean;
}

export interface CostSample extends BuildFeatures {
  costUsd: number;
  at: number;
}

export interface CostEstimate {
  lowUsd: number;
  highUsd: number;
  basis: "history" | "prior";
  samples: number;
}

export interface CostModelStore {
  get(ns: string, key: string): Promise<unknown>;
  set(ns: string, key: string, value: unknown): Promise<void>;
}

const NS = "cost_model";
const KEY = "build_samples";
const MAX_SAMPLES = 300;

/** Starting values. They apply only until enough real builds exist. */
function prior(f: BuildFeatures): CostEstimate {
  let low = f.needsWeb ? 0.08 : 0.005;
  let high = f.needsWeb ? 0.9 : 0.08;
  if (!f.optimize) {
    low *= 0.6;
    high *= 0.6;
  }
  if (!f.evaluate) {
    low *= 0.3;
    high *= 0.3;
  }
  return { lowUsd: round(low), highUsd: round(high), basis: "prior", samples: 0 };
}

const round = (n: number) => Math.round(n * 10000) / 10000;

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export class CostModel {
  constructor(
    private store: CostModelStore,
    private opts: { minSamples?: number } = {},
  ) {}

  async samples(): Promise<CostSample[]> {
    const v = await this.store.get(NS, KEY);
    return Array.isArray(v) ? (v as CostSample[]) : [];
  }

  async record(f: BuildFeatures, costUsd: number, at = Date.now()) {
    if (!Number.isFinite(costUsd) || costUsd < 0) return;
    const list = [...(await this.samples()), { ...f, costUsd, at }].slice(-MAX_SAMPLES);
    await this.store.set(NS, KEY, list);
  }

  /** Uses the most specific group of past builds that has enough samples. */
  async estimate(f: BuildFeatures): Promise<CostEstimate> {
    const min = this.opts.minSamples ?? 3;
    const all = (await this.samples()).filter((s) => s.evaluate === f.evaluate && s.optimize === f.optimize);
    const groups = [all.filter((s) => s.pattern === f.pattern && s.needsWeb === f.needsWeb), all.filter((s) => s.needsWeb === f.needsWeb)];
    for (const g of groups) {
      if (g.length < min) continue;
      const costs = g.map((s) => s.costUsd).sort((a, b) => a - b);
      return { lowUsd: round(quantile(costs, 0.25)), highUsd: round(quantile(costs, 0.9)), basis: "history", samples: g.length };
    }
    return prior(f);
  }
}

/** Reads the build features from a finished build run (the triage artifact and the input). */
export function featuresOf(r: RunRecord): BuildFeatures | null {
  const triage = r.events.find((e) => e.type === "artifact" && e.kind === "triage") as
    { data?: { pattern?: string; complexity?: number; flags?: Record<string, number> } } | undefined;
  if (!triage?.data?.pattern) return null;
  const input = (r.input ?? {}) as { evaluate?: boolean; optimize?: boolean };
  return {
    pattern: triage.data.pattern,
    needsWeb: (triage.data.flags?.needs_web ?? 0) >= 0.5,
    complexity: triage.data.complexity ?? 0,
    evaluate: input.evaluate !== false,
    optimize: input.optimize !== false,
  };
}
