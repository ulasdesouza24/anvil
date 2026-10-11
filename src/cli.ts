#!/usr/bin/env tsx
import fs from "node:fs";
import readline from "node:readline/promises";
import type { RunEvent, RunRecord } from "./core/types.js";
import { validateSpec } from "./core/validator.js";
import { createAnvil } from "./runtime/anvil.js";
import { classifyLibrary, taxonomyOf } from "./builder/library.js";
import { guardProcess } from "./runtime/processGuard.js";
import { buildTask, buildTasks, loadTask, taskFilesIn } from "./runtime/tasks.js";
import { parseExternalTests } from "./core/externalTests.js";
import { evaluateSpec } from "./builder/evaluate.js";
import { HealthService } from "./runtime/health.js";
import { checkModels } from "./builder/bestOf.js";

guardProcess("cli");

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

function printEvent(e: RunEvent, verbose: boolean) {
  const ts = c.dim(new Date(e.t).toISOString().slice(11, 19));
  switch (e.type) {
    case "node.started":
      console.log(`${ts} ${c.cyan("▶")} ${e.nodeId}${e.attempt > 1 ? c.yellow(` (attempt ${e.attempt})`) : ""}`);
      break;
    case "node.completed":
      console.log(`${ts} ${c.green("✓")} ${e.nodeId} ${c.dim(`${e.durationMs}ms · $${e.usage.costUsd.toFixed(5)} · ports ${e.ports.join(",")}`)}`);
      if (verbose) console.log(c.dim(JSON.stringify(e.output).slice(0, 400)));
      break;
    case "node.skipped":
      console.log(`${ts} ${c.dim(`○ ${e.nodeId} skipped`)}`);
      break;
    case "node.failed":
      console.log(`${ts} ${c.red("✗")} ${e.nodeId}: ${e.error.slice(0, 300)}${e.willRetry ? c.yellow(" → retrying") : ""}`);
      break;
    case "llm":
      console.log(`${ts}   ${c.magenta("S2")} ${e.purpose} ${c.dim(`${e.model}${e.tier ? `/${e.tier}` : ""} ${e.inputTokens}→${e.outputTokens} tok ${e.latencyMs}ms`)}`);
      break;
    case "decision": {
      const summary = Object.entries(e.answers)
        .map(([k, a]) => `${k}=${a.type === "choice" ? `${a.choice}(${a.confidence.toFixed(2)})` : a.type === "score" ? a.score.toFixed(2) : a.noul.toFixed(2)}`)
        .join(" ");
      console.log(`${ts}   ${c.yellow("S1")} ${e.purpose} ${c.dim(`${e.latencyMs}ms`)} ${summary.slice(0, 220)}${e.escalated ? c.magenta(" ↑escalated") : ""}`);
      break;
    }
    case "log":
      if (e.message !== "__final__") console.log(`${ts}   ${e.level === "warn" ? c.yellow("!") : "·"} ${e.nodeId ? `${e.nodeId}: ` : ""}${e.message}`);
      break;
    case "artifact":
      if (e.kind === "validation") {
        const d = e.data as { attempt: number; strategy: string; errors: number; warnings: number; diagnostics: { severity: string; message: string }[] };
        console.log(`${ts}   ${c.bold("compile")} pass ${d.attempt} (${d.strategy}): ${d.errors ? c.red(`${d.errors} errors`) : c.green("0 errors")}, ${d.warnings} warnings`);
        if (verbose || d.errors)
          d.diagnostics
            .filter((x) => x.severity === "error")
            .slice(0, 6)
            .forEach((x) => console.log(c.dim(`      - ${x.message}`)));
      } else if (e.kind === "evaluation") {
        const d = e.data as { round: number; report: { passRate: number; score: number } };
        console.log(`${ts}   ${c.bold("eval")} round ${d.round}: pass ${(d.report.passRate * 100).toFixed(0)}% · score ${d.report.score.toFixed(2)}`);
      } else if (e.kind === "critique") {
        const d = e.data as { diagnosis: string; changes: string[] };
        console.log(`${ts}   ${c.bold("critic")} ${d.diagnosis.slice(0, 300)}`);
      } else if (e.kind === "published") {
        const d = e.data as { agentId: string; version: number };
        console.log(`${ts}   ${c.green(c.bold(`published ${d.agentId} v${d.version}`))}`);
      } else if (verbose) console.log(`${ts}   artifact ${e.kind}`);
      break;
    case "run.completed":
      console.log(
        `${ts} ${c.green(c.bold("run completed"))} ${c.dim(`${(e.durationMs / 1000).toFixed(1)}s · $${e.usage.costUsd.toFixed(4)} · ${e.usage.llmCalls} LLM / ${e.usage.decisionCalls} Jev calls`)}`,
      );
      break;
    case "run.failed":
      console.log(`${ts} ${c.red(c.bold("run failed"))}: ${e.error}`);
      break;
  }
}

async function watch(anvil: Awaited<ReturnType<typeof createAnvil>>, rec: RunRecord, verbose: boolean) {
  const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  anvil.runs.subscribe(rec.id, async (e) => {
    printEvent(e, verbose);
    if (e.type === "node.waiting") {
      const req = e.request;
      console.log(c.bold(`\n⏸  ${req.title}`));
      if (req.kind === "input") {
        const answers: Record<string, string> = {};
        for (const q of req.questions ?? []) answers[q] = rl ? await rl.question(`  ${q}\n  > `) : "";
        anvil.runs.resume(rec.id, e.nodeId, { answers });
      } else {
        console.log(c.dim(JSON.stringify(req.payload, null, 2)?.slice(0, 1200)));
        const a = rl ? await rl.question("  approve? [y/N] ") : "n";
        anvil.runs.resume(rec.id, e.nodeId, { approved: /^y/i.test(a) });
      }
    }
  });
  const done = await anvil.runs.waitForRun(rec.id);
  rl?.close();
  return done!;
}

/** Flags with a value (--task file.json). The other words are positional arguments. */
const VALUE_FLAGS = new Set(["--task", "--tasks", "--out", "--spec", "--input", "--concurrency", "--tests", "--version"]);

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) values[a] = args[++i] ?? "";
    else if (a.startsWith("--")) flags.add(a);
    else pos.push(a);
  }
  const verbose = flags.has("--verbose");
  const anvil = await createAnvil();

  if (cmd === "build" && values["--tasks"]) {
    // A batch: each *.json file of the folder is one task.
    const files = taskFilesIn(values["--tasks"]);
    if (!files.length) throw new Error(`No task files (*.json) in ${values["--tasks"]}`);
    const outDir = values["--out"] ?? "out";
    console.log(c.bold(`Building ${files.length} task(s) → ${outDir}/`));
    const results = await buildTasks(anvil, files, {
      outDir,
      concurrency: values["--concurrency"] ? Number(values["--concurrency"]) : 2,
      onResult: (r) => console.log(`  ${r.agentId ? c.green("✓") : c.red("✗")} ${r.id}  ${r.agentId ?? r.error ?? r.status}  score ${r.score ?? "—"}  $${r.costUsd.toFixed(3)}`),
    });
    console.log(c.dim(`
summary: ${outDir}/summary.json`));
    process.exitCode = results.every((r) => r.agentId) ? 0 : 1;
  } else if (cmd === "build" && values["--task"]) {
    const task = loadTask(values["--task"]);
    const outFile = values["--out"] ?? `${task.id}.agent.json`;
    console.log(c.bold(`Building task ${task.id}…\n`));
    const r = await buildTask(anvil, task, { outFile, onEvent: (e) => printEvent(e as RunEvent, verbose) });
    console.log("\n" + JSON.stringify(r, null, 2));
    process.exitCode = r.agentId ? 0 : 1;
  } else if (cmd === "build") {
    const request = pos.join(" ");
    if (!request) throw new Error('Usage: anvil build "<what the agent should do>" [--no-optimize] [--no-eval] [--no-clarify]');
    const rec = anvil.runs.start(
      { agentId: "anvil-builder" },
      { request, clarify: !flags.has("--no-clarify"), evaluate: !flags.has("--no-eval"), optimize: !flags.has("--no-optimize") },
      { kind: "build" },
    );
    console.log(c.bold(`Building… run ${rec.id}\n`));
    const done = await watch(anvil, rec, verbose);
    console.log("\n" + JSON.stringify(done.output, null, 2));
    process.exitCode = done.status === "completed" ? 0 : 1;
  } else if (cmd === "refine") {
    const [agentId, ...rest] = pos;
    const rec = anvil.runs.start({ agentId: "anvil-refiner" }, { agentId, instruction: rest.join(" "), optimize: flags.has("--optimize") }, { kind: "refine" });
    const done = await watch(anvil, rec, verbose);
    console.log("\n" + JSON.stringify(done.output, null, 2));
  } else if (cmd === "run") {
    // anvil run <agentId> '<json>' | anvil run --spec agent.json [--input input.json]
    const [agentId, json] = pos;
    const input = values["--input"] ? JSON.parse(fs.readFileSync(values["--input"], "utf8")) : json ? JSON.parse(json) : {};
    const ref = values["--spec"] ? { spec: JSON.parse(fs.readFileSync(values["--spec"], "utf8")) } : { agentId };
    if (!ref.spec && !agentId) throw new Error("Usage: anvil run <agentId> '<json input>'  or  anvil run --spec agent.json [--input input.json]");
    const rec = anvil.runs.start(ref, input, { kind: "run" });
    const done = await watch(anvil, rec, verbose);
    console.log("\n" + JSON.stringify(done.output, null, 2));
    process.exitCode = done.status === "completed" ? 0 : 1;
  } else if (cmd === "test") {
    // anvil test <agentId> --tests tests.json | anvil test --spec agent.json --tests tests.json (docs/TESTS.md)
    const [agentId] = pos;
    if (!values["--tests"] || (!agentId && !values["--spec"])) throw new Error("Usage: anvil test <agentId> --tests tests.json [--version n] [--out report.json]  or  anvil test --spec agent.json --tests tests.json");
    const spec = values["--spec"] ? JSON.parse(fs.readFileSync(values["--spec"], "utf8")) : anvil.store.getSpec(agentId, values["--version"] ? Number(values["--version"]) : undefined);
    if (!spec) throw new Error(`Agent "${agentId}" does not exist`);
    const tests = parseExternalTests(values["--tests"]);
    console.log(c.bold(`Testing ${spec.id} v${spec.version} with ${tests.length} test(s)…\n`));
    const { report } = await evaluateSpec(spec, tests, {
      services: anvil.runs.services,
      brain: anvil.runs.brain,
      onResult: (r) =>
        console.log(
          `  ${r.passed ? c.green("✓") : c.red("✗")} ${r.name}  score ${r.score}  $${r.costUsd.toFixed(4)}${r.error ? c.dim(`  ${r.error.slice(0, 120)}`) : ""}${r.criteria.filter((x) => !x.passed).map((x) => c.dim(`\n      ✗ ${x.criterion}`)).join("")}`,
        ),
    });
    console.log(`\npass rate ${report.passRate} · score ${report.score} · $${report.costUsd.toFixed(4)}`);
    if (values["--out"]) fs.writeFileSync(values["--out"], JSON.stringify(report, null, 2));
    process.exitCode = report.passRate === 1 ? 0 : 1;
  } else if (cmd === "models" && pos[0] === "check") {
    // anvil models check: the builder models of best-of-N and the judge, and which of them answer (docs/SELECTION.md).
    const b = anvil.config.bestOf;
    const r = await checkModels(anvil.runs.brain, [...b.models, b.judgeModel]);
    for (const m of [...b.models, b.judgeModel]) {
      const f = r.failed.find((x) => x.model === m);
      console.log(`${f ? c.red("✗") : c.green("✓")} ${m}${m === b.judgeModel ? c.dim(" (judge)") : ""}${f ? c.dim(`  ${f.error}`) : ""}`);
    }
    console.log(c.dim(`best-of-N is ${b.enabled ? "on" : "off"} (ANVIL_BEST_OF)`));
    process.exitCode = r.failed.length ? 1 : 0;
  } else if (cmd === "health") {
    // anvil health [agentId]: check one agent, or each live data agent whose last check is old (docs/HEALTH.md).
    const h = new HealthService({ store: anvil.store, kv: anvil.store, runs: anvil.runs, config: anvil.config.health, log: (m) => console.log(c.dim(m)) });
    const ids = pos[0] ? [pos[0]] : h.liveAgents().map((a) => a.id);
    if (!ids.length) console.log("No live data agent with tests.");
    for (const id of ids) {
      const r = await h.check(id);
      const l = r.last!;
      console.log(`${l.status === "healthy" ? c.green("healthy") : l.status === "broken" ? c.red("broken") : c.yellow("unknown")} ${c.bold(id)} v${l.version}  score ${l.score ?? "—"} (baseline ${l.baseline ?? "—"})  $${l.costUsd.toFixed(4)}${l.cause ? c.dim(`\n    ${l.cause}`) : ""}`);
    }
    process.exitCode = 0;
  } else if (cmd === "list") {
    for (const a of anvil.store.listAgents()) {
      const v = a.versions.find((x) => x.version === a.currentVersion);
      const t = taxonomyOf(v?.spec);
      console.log(`${a.system ? c.dim("[system] ") : ""}${c.bold(a.id)} v${a.currentVersion} — ${a.description}${v?.score !== undefined ? c.green(` · score ${v.score}`) : ""}${t ? c.dim(` · ${t.pattern} / ${t.domain}`) : ""}`);
    }
  } else if (cmd === "classify") {
    const done = await classifyLibrary({ brain: anvil.runs.brain, store: anvil.store, cfg: anvil.config.library }, { force: flags.has("--force"), onClassified: (id, t) => console.log(`${c.bold(id)}: ${t.pattern} / ${t.domain} / ${t.sourceKind} / ${t.outputKind}`) });
    console.log(c.green(`${done.length} agent(s) classified`));
  } else if (cmd === "validate") {
    const spec = JSON.parse(fs.readFileSync(pos[0], "utf8"));
    const r = validateSpec(spec, anvil.registry, { getAgent: (id) => anvil.store.getAgent(id) });
    for (const d of r.diagnostics) console.log(`${d.severity === "error" ? c.red("error") : c.yellow(d.severity)} [${d.code}] ${d.message}${d.hint ? c.dim(` — ${d.hint}`) : ""}`);
    console.log(r.valid ? c.green("valid") : c.red(`${r.errors} errors`));
    process.exitCode = r.valid ? 0 : 1;
  } else {
    console.log(`Anvil CLI
  anvil build "<request>" [--no-optimize] [--no-eval] [--no-clarify] [--verbose]
  anvil build --task task.json [--out agent.json]       build one task from a file, without a person
  anvil build --tasks <dir> [--out <dir>] [--concurrency n]   build each task file of a folder
  anvil run --spec agent.json [--input input.json]       run an agent file
  anvil refine <agentId> "<instruction>" [--optimize]
  anvil run <agentId> '<json input>'
  anvil test <agentId> --tests tests.json [--out report.json]   score an agent with given tests (docs/TESTS.md)
  anvil models check          check the builder models of best-of-N and the judge (docs/SELECTION.md)
  anvil health [agentId]       run the tests of live data agents and mark broken ones (docs/HEALTH.md)
  anvil list
  anvil classify [--force]     give a class to each library agent (docs/LIBRARY.md)
  anvil validate <spec.json>`);
  }
  await anvil.store.flush();
  // The command is done: close what keeps the process alive (sandbox containers and gate, browser, MCP servers, triggers), then exit.
  await Promise.allSettled([anvil.sandbox.dispose(), anvil.browser.close(), anvil.mcp.closeAll()]);
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(c.red((e as Error).stack ?? String(e)));
  process.exit(1);
});
