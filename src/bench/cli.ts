#!/usr/bin/env tsx
/**
 * Runs the builder benchmark: npm run bench -- [--only a,b] [--limit n]
 * [--concurrency n] [--budget usd] [--no-optimize] [--no-eval] [--no-library] [--suite file] [--best-of [n]]
 * Each case is a real build, so each case costs money. Use --budget to set a limit.
 */
import path from "node:path";
import { createAnvil } from "../runtime/anvil.js";
import { listReports, loadSuite, reportMarkdown, runBenchmark, saveReport } from "./runner.js";
import { evaluateSpec } from "../builder/evaluate.js";
import { guardProcess } from "../runtime/processGuard.js";

guardProcess("bench");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const suiteFile = arg("suite") ?? path.resolve(import.meta.dirname, "../../bench/suite.json");
const suite = loadSuite(suiteFile);
const opts = {
  only: arg("only")
    ?.split(",")
    .map((s) => s.trim()),
  limit: arg("limit") ? Number(arg("limit")) : undefined,
  concurrency: arg("concurrency") ? Number(arg("concurrency")) : 2,
  budgetUsd: arg("budget") ? Number(arg("budget")) : undefined,
  evaluate: !process.argv.includes("--no-eval"),
  optimize: !process.argv.includes("--no-optimize"),
  library: !process.argv.includes("--no-library"),
  // --best-of: one candidate for each builder model. --best-of 2: two candidates (docs/SELECTION.md).
  ...(process.argv.includes("--best-of") ? { bestOf: /^\d+$/.test(arg("best-of") ?? "") ? Number(arg("best-of")) : ("auto" as const) } : {}),
};

const anvil = await createAnvil();
// A stopped benchmark also removes its sandbox containers.
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => {
    void anvil.sandbox.dispose().finally(() => process.exit(130));
  });
const previous = listReports(anvil.config.dataDir)[0];
console.log(`Benchmark: ${opts.only?.length ?? opts.limit ?? suite.cases.length} case(s), concurrency ${opts.concurrency}${opts.budgetUsd ? `, budget $${opts.budgetUsd}` : ""}`);
const report = await runBenchmark(
  suite,
  {
    runs: anvil.runs,
    store: anvil.store,
    baseDir: path.dirname(path.resolve(suiteFile)),
    // Hidden tests (docs/TESTS.md) score the published agent, without a person.
    evaluate: async (spec, tests) => (await evaluateSpec(spec, tests, { services: anvil.runs.services, brain: anvil.runs.brain })).report,
    onCaseDone: (r, spent) =>
      console.log(
        `  ${r.met ? "✓" : "✗"} ${r.id}${r.selection ? `  [${r.selection.model} by ${r.selection.by}]` : ""}  score ${r.metrics?.score ?? "—"}${r.hidden ? `  hidden ${r.hidden.score} (${r.hidden.tests - r.hidden.failed.length}/${r.hidden.tests})` : ""}  $${(r.metrics?.costUsd ?? 0).toFixed(3)}  (total $${spent.toFixed(3)})${r.met ? "" : `  ${r.misses.join("; ")}`}`,
      ),
  },
  opts,
);
const file = saveReport(anvil.config.dataDir, report);
await anvil.store.flush();
console.log(`\n${reportMarkdown(report, previous)}\n\nSaved ${file}`);

// The benchmark is done: close what keeps the process alive (sandbox containers and gate, browser, MCP servers), then exit.
await Promise.allSettled([anvil.sandbox.dispose(), anvil.browser.close(), anvil.mcp.closeAll()]);
process.exit(0);
