import jsonpatch from "fast-json-patch";
import type { Registry } from "../core/registry.js";
import type { AgentSpec, Diagnostic, JSONSchema, StoredAgent } from "../core/types.js";
import { STE_RULES } from "../core/ste.js";
import { validateSpec, type ValidationResult } from "../core/validator.js";
import { configJsonSchema, configKeysOf } from "../core/registry.js";
import type { Brain } from "../llm/brain.js";
import { autoFix } from "./autofix.js";
import { IR_GUIDE } from "./guide.js";

/** Full reference docs (config JSON schema + example) for the given node types. */
export function nodeDocs(registry: Registry, types: Iterable<string>): string {
  const wanted = new Set(["input", "output", ...types]);
  return registry
    .list()
    .filter((c) => wanted.has(c.type))
    .map(
      (c) =>
        `### ${c.type} — ${c.title}\n${c.description}\nconfig schema: ${JSON.stringify(configJsonSchema(c))}${c.outputSchema && c.custom ? `\noutput schema: ${JSON.stringify(c.outputSchema(c.example as never, { spec: undefined as never }))}` : ""}\nexample config: ${JSON.stringify(c.example)}`,
    )
    .join("\n\n");
}

export function formatDiagnostics(diags: Diagnostic[], severities: Diagnostic["severity"][] = ["error"]): string {
  return diags
    .filter((d) => severities.includes(d.severity))
    .map((d) => `- [${d.code}] ${d.message}${d.path ? ` (at ${d.path})` : ""}${d.hint ? ` — hint: ${d.hint}` : ""}`)
    .join("\n");
}

const PATCH_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    operations: {
      type: "array",
      items: {
        type: "object",
        properties: { op: { type: "string", enum: ["add", "remove", "replace", "move", "copy"] }, path: { type: "string" }, from: { type: "string" }, value: {} },
        required: ["op", "path"],
      },
    },
    notes: { type: "string" },
  },
  required: ["operations"],
};

export interface RepairEnv {
  brain: Brain;
  registry: Registry;
  getAgent?: (id: string) => StoredAgent | undefined;
  maxAttempts: number;
  /** Extra context for the repairer (task summary). */
  context?: string;
  /** The request of the person. A URL in it must stay in the spec. */
  request?: string;
  /** The tested source plan. Its sources must stay in the spec. */
  sourcePlan?: import("../core/urls.js").PlannedSources;
  /** The attached files of the task and their roles. */
  files?: { id: string; name: string; role: string }[];
  /** The given tools of a closed build (class types). */
  givenTools?: string[];
  onStep?: (step: { attempt: number; strategy: "autofix" | "patch" | "rewrite"; result: ValidationResult; fixes: string[]; spec: unknown; notes?: string }) => void;
}

export interface RepairOutcome {
  spec: AgentSpec | null;
  raw: unknown;
  result: ValidationResult;
  attempts: number;
  history: { attempt: number; strategy: string; errors: number; warnings: number }[];
}

function typesIn(spec: unknown): string[] {
  const nodes = (spec as { nodes?: { type?: unknown }[] })?.nodes;
  return Array.isArray(nodes) ? [...new Set(nodes.map((n) => String(n?.type ?? "")).filter(Boolean))] : [];
}

/**
 * The compiler loop: deterministic auto-fix → static validation → targeted
 * JSON-Patch repair by the model (falling back to a full rewrite) until the
 * spec has zero errors or attempts run out. Keeps the best candidate seen.
 */
/**
 * Applies JSON Patch operations one by one. Harmless slips are tolerated
 * (removing a path that doesn't exist; replacing a missing key becomes add);
 * anything else is reported. The compiler loop validates the result anyway.
 */
export function applyPatchLenient<T>(doc: T, ops: jsonpatch.Operation[]): { doc: T; applied: number; skipped: string[] } {
  let current = structuredClone(doc);
  let applied = 0;
  const skipped: string[] = [];
  for (const raw of ops ?? []) {
    let op = raw;
    try {
      current = jsonpatch.applyOperation(current, op, true, true).newDocument as T;
      applied++;
      continue;
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0];
      if (op.op === "replace") {
        try {
          op = { op: "add", path: op.path, value: (op as { value: unknown }).value } as jsonpatch.Operation;
          current = jsonpatch.applyOperation(current, op, true, true).newDocument as T;
          applied++;
          continue;
        } catch {
          /* fall through */
        }
      }
      skipped.push(`${raw.op} ${raw.path}: ${op.op === "remove" ? "path does not exist (ignored)" : msg}`);
    }
  }
  return { doc: current, applied, skipped };
}

/** Valid config keys per node type, derived from each class's Zod schema. */
export function configKeysFor(registry: Registry): (type: string) => string[] | undefined {
  return (type) => configKeysOf(registry.get(type));
}

export async function validateAndRepair(raw: unknown, env: RepairEnv): Promise<RepairOutcome> {
  const history: RepairOutcome["history"] = [];
  const fixOpts = { configKeys: configKeysFor(env.registry) };
  let { spec: current, fixes } = autoFix(raw, fixOpts);
  const vopts = { getAgent: env.getAgent, ste: env.brain.config.stePrompts, steMaxPer100w: env.brain.config.steMaxPer100w, request: env.request, namedSources: "error" as const, sourcePlan: env.sourcePlan, plannedSources: "error" as const, files: env.files, unattended: env.brain.config.unattended, givenTools: env.givenTools };
  let result = validateSpec(current, env.registry, vopts);
  history.push({ attempt: 0, strategy: "autofix", errors: result.errors, warnings: result.warnings });
  env.onStep?.({ attempt: 0, strategy: "autofix", result, fixes, spec: current });
  let best = { spec: current, result };
  let usePatch = true;

  for (let attempt = 1; attempt <= env.maxAttempts && result.errors > 0; attempt++) {
    const errorText = formatDiagnostics(result.diagnostics);
    const docs = nodeDocs(env.registry, typesIn(current));
    const known = env.registry.types().join(", ");
    const steGuide = result.diagnostics.some((d) => d.code === "STE_PROMPT" && d.severity === "error") ? `\n\nSTE_PROMPT errors: rewrite the text of each listed field. Keep the meaning, the templates, and the details.\n${STE_RULES}` : "";
    const strategy: "patch" | "rewrite" = usePatch && result.errors <= 8 ? "patch" : "rewrite";
    let notes: string | undefined;
    let candidate: unknown;
    try {
      if (strategy === "patch") {
        const out = await env.brain.json<{ operations: jsonpatch.Operation[]; notes?: string }>({
          purpose: `repair spec (patch #${attempt})`,
          tier: "balanced",
          system: `You fix Anvil agent specs. Return RFC 6902 JSON Patch operations that resolve EVERY listed error while preserving the agent's intent. Paths are JSON pointers into the spec (e.g. /nodes/3/config/prompt, /edges/-). Prefer the smallest correct change. Node types available: ${known}.${steGuide}\n\n${IR_GUIDE}\n\nNODE REFERENCE:\n${docs}`,
          user: `${env.context ? `TASK CONTEXT:\n${env.context}\n\n` : ""}SPEC:\n${JSON.stringify(current, null, 1)}\n\nERRORS:\n${errorText}`,
          schema: PATCH_SCHEMA,
          maxTokens: 8000,
        });
        notes = out.notes;
        const r = applyPatchLenient(current, out.operations);
        if (!r.applied) throw new Error(`no patch operation applied (${r.skipped.slice(0, 3).join("; ")})`);
        if (r.skipped.length) notes = `${notes ?? ""} [skipped ops: ${r.skipped.join("; ")}]`.trim();
        candidate = r.doc;
      } else {
        candidate = await env.brain.json({
          purpose: `repair spec (rewrite #${attempt})`,
          tier: "balanced",
          system: `You fix Anvil agent specs. Return the COMPLETE corrected spec JSON, resolving every listed error while preserving the agent's intent. Node types available: ${known}.${steGuide}\n\n${IR_GUIDE}\n\nNODE REFERENCE:\n${docs}`,
          user: `${env.context ? `TASK CONTEXT:\n${env.context}\n\n` : ""}SPEC:\n${JSON.stringify(current, null, 1)}\n\nERRORS:\n${errorText}`,
          maxTokens: 16000,
        });
      }
    } catch (e) {
      // Bad patch (e.g. wrong path) → fall back to a full rewrite next time.
      usePatch = false;
      history.push({ attempt, strategy: `${strategy} (failed: ${(e as Error).message.slice(0, 80)})`, errors: result.errors, warnings: result.warnings });
      continue;
    }
    ({ spec: current, fixes } = autoFix(candidate, fixOpts));
    const next = validateSpec(current, env.registry, vopts);
    history.push({ attempt, strategy, errors: next.errors, warnings: next.warnings });
    env.onStep?.({ attempt, strategy, result: next, fixes, spec: current, notes });
    if (next.errors >= result.errors && strategy === "patch") usePatch = false;
    result = next;
    if (result.errors < best.result.errors || (result.errors === best.result.errors && result.warnings < best.result.warnings)) best = { spec: current, result };
  }

  // STE and source checks do not block a build: when only these errors remain, they become warnings.
  if (!best.result.valid && best.result.diagnostics.every((d) => d.severity !== "error" || d.code === "STE_PROMPT" || d.code === "NAMED_SOURCE" || d.code === "PLANNED_SOURCE")) {
    best = { spec: best.spec, result: validateSpec(best.spec, env.registry, { ...vopts, ste: "warning", namedSources: "warning", plannedSources: "warning" }) };
  }
  return { spec: best.result.valid ? (best.result.spec ?? null) : null, raw: best.spec, result: best.result, attempts: history.length - 1, history };
}
