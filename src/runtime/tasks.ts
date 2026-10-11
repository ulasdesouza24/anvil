import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseExternalTests } from "../core/externalTests.js";
import { builderFor } from "../builder/bestOf.js";
import type { AgentSpec, RunRecord, TestCase } from "../core/types.js";
import type { Anvil } from "./anvil.js";

/**
 * Build tasks from files: one JSON file for each task. The CLI
 * and a batch run use them without a person: no questions, no approvals.
 */
export const TaskFileZ = z.object({
  /** A name for the task. The file name applies when it is not set. */
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  /** What the agent must do, in plain language. */
  request: z.string().min(1),
  /** Files to attach: paths relative to the task file (docs/FILES.md). */
  files: z.array(z.string()).default([]),
  /** Tool definitions for the agent (docs/TOOLS.md): the definitions, or the path of a JSON or YAML file (relative to the task file). */
  tools: z.unknown().optional(),
  /** Best-of-N (docs/SELECTION.md): the number of candidates, or "auto". Without it, ANVIL_BEST_OF decides. */
  candidates: z.union([z.number().int().min(1), z.literal("auto")]).optional(),
  /** Given tests (docs/TESTS.md): the tests, or the path of a .json, .jsonl, or .yaml file (relative to the task file). */
  tests: z.unknown().optional(),
  /** Answers to questions that the builder can ask. */
  answers: z.record(z.string(), z.string()).optional(),
  evaluate: z.boolean().default(true),
  optimize: z.boolean().default(true),
  testCount: z.number().int().min(1).max(8).optional(),
  useLibrary: z.boolean().default(true),
  /** The build stops before it starts when its high cost estimate is above this value (USD). */
  maxBuildUsd: z.number().positive().default(10),
});
export type TaskFile = z.infer<typeof TaskFileZ>;

export interface LoadedTask extends TaskFile {
  id: string;
  /** The folder of the task file: file paths are relative to it. */
  dir: string;
}

export function loadTask(file: string): LoadedTask {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  const parsed = TaskFileZ.safeParse(raw);
  if (!parsed.success) throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "task"} ${i.message}`).join("; ")}`);
  return { ...parsed.data, id: parsed.data.id ?? path.basename(file).replace(/\.json$/i, ""), dir: path.dirname(path.resolve(file)) };
}

/** The task files of a folder (*.json), in name order. */
export function taskFilesIn(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .sort()
    .map((f) => path.join(dir, f));
}

export interface TaskResult {
  id: string;
  status: RunRecord["status"];
  runId: string | null;
  agentId: string | null;
  score: number | null;
  passRate: number | null;
  quality: string | null;
  costUsd: number;
  durationMs: number;
  error?: string;
  /** Where the agent spec was written. */
  out?: string;
}

/**
 * Builds the agent of one task and waits for the end. The build runs unattended.
 * With `outDir`, the spec of the agent is written to <outDir>/<task id>.agent.json.
 */
export async function buildTask(
  anvil: Anvil,
  task: LoadedTask,
  opts: { outFile?: string; onEvent?: (e: unknown) => void; builder?: { agentId?: string; spec?: AgentSpec } } = {},
): Promise<TaskResult> {
  const started = Date.now();
  const fail = (error: string): TaskResult => ({ id: task.id, status: "failed", runId: null, agentId: null, score: null, passRate: null, quality: null, costUsd: 0, durationMs: Date.now() - started, error });
  const fileIds: string[] = [];
  for (const f of task.files) {
    const p = path.resolve(task.dir, f);
    if (!fs.existsSync(p)) return fail(`file not found: ${p}`);
    const saved = await anvil.files.save(path.basename(p), "", fs.readFileSync(p));
    fileIds.push(saved.id);
  }
  // Tools can be a file: an OpenAPI document or function definitions in JSON or YAML.
  let tools = task.tools;
  if (typeof tools === "string" && /\.(json|ya?ml)$/i.test(tools.trim())) {
    const p = path.resolve(task.dir, tools.trim());
    if (!fs.existsSync(p)) return fail(`tool file not found: ${p}`);
    tools = fs.readFileSync(p, "utf8");
  }
  // Tests can be a file. A bad test fails here, before the build costs money.
  let tests: TestCase[] | undefined;
  if (task.tests !== undefined) {
    try {
      tests = parseExternalTests(task.tests, task.dir);
    } catch (e) {
      return fail(`tests: ${(e as Error).message}`);
    }
  }
  let rec: RunRecord;
  try {
    // Best-of-N (docs/SELECTION.md): the task, or ANVIL_BEST_OF.
    const target = builderFor(task.candidates, anvil.config.bestOf.enabled);
    rec = anvil.runs.start(
      opts.builder ?? { agentId: target.agentId },
      {
        ...(target.candidates ? { candidates: target.candidates } : {}),
        request: task.request,
        clarify: false,
        askOnCost: false,
        confirmAboveUsd: task.maxBuildUsd,
        evaluate: task.evaluate,
        optimize: task.optimize,
        useLibrary: task.useLibrary,
        ...(task.testCount ? { testCount: task.testCount } : {}),
        ...(task.answers ? { answers: task.answers } : {}),
        ...(fileIds.length ? { files: fileIds } : {}),
        ...(tools !== undefined ? { tools } : {}),
        ...(tests?.length ? { tests } : {}),
      },
      // No person is there: an approval or a question of the build does not wait.
      { kind: "build", humanMode: "auto" },
    );
  } catch (e) {
    return fail((e as Error).message);
  }
  if (opts.onEvent) anvil.runs.subscribe(rec.id, opts.onEvent);
  const done = await anvil.runs.waitForRun(rec.id);
  if (!done) return fail(`the build run ${rec.id} has no record`);
  const out = (done.output ?? {}) as { agentId?: string; score?: number | null; passRate?: number | null; quality?: string; cancelled?: boolean; reason?: string };
  const result: TaskResult = {
    id: task.id,
    status: done.status,
    runId: done.id,
    agentId: out.agentId ?? null,
    score: typeof out.score === "number" ? out.score : null,
    passRate: typeof out.passRate === "number" ? out.passRate : null,
    quality: out.quality ?? null,
    costUsd: done.usage.costUsd,
    durationMs: Date.now() - started,
    ...(done.error ? { error: done.error } : out.cancelled ? { error: out.reason ?? "the build stopped" } : {}),
  };
  if (result.agentId && opts.outFile) {
    const spec = anvil.store.getSpec(result.agentId) as AgentSpec | undefined;
    if (spec) {
      fs.mkdirSync(path.dirname(path.resolve(opts.outFile)), { recursive: true });
      fs.writeFileSync(opts.outFile, JSON.stringify(spec, null, 2));
      result.out = opts.outFile;
    }
  }
  return result;
}

/** Builds the tasks of a folder, `concurrency` at a time, and writes the agents and summary.json to `outDir`. */
export async function buildTasks(
  anvil: Anvil,
  files: string[],
  opts: { outDir: string; concurrency?: number; onResult?: (r: TaskResult) => void; builder?: { agentId?: string; spec?: AgentSpec } },
): Promise<TaskResult[]> {
  fs.mkdirSync(opts.outDir, { recursive: true });
  const results: TaskResult[] = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      let r: TaskResult;
      try {
        const task = loadTask(files[i]);
        r = await buildTask(anvil, task, { outFile: path.join(opts.outDir, `${task.id}.agent.json`), builder: opts.builder });
      } catch (e) {
        // One bad task does not stop the others.
        r = { id: path.basename(files[i]).replace(/\.json$/i, ""), status: "failed", runId: null, agentId: null, score: null, passRate: null, quality: null, costUsd: 0, durationMs: 0, error: (e as Error).message };
      }
      results[i] = r;
      opts.onResult?.(r);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 2, files.length)) }, worker));
  const summary = {
    at: new Date().toISOString(),
    tasks: results.length,
    published: results.filter((r) => r.agentId).length,
    costUsd: Math.round(results.reduce((a, r) => a + r.costUsd, 0) * 10000) / 10000,
    results,
  };
  fs.writeFileSync(path.join(opts.outDir, "summary.json"), JSON.stringify(summary, null, 2));
  return results;
}
