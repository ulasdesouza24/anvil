import { z } from "zod";
import type { Tier } from "../config.js";
import type { NodeContext } from "../registry.js";
import type { JSONSchema } from "../types.js";

export const TIER_NAMES = ["fast", "balanced", "deep"] as const;

export const ModelField = z
  .string()
  .default("fast")
  .describe('"auto" (the decision model picks the tier per call), "fast", "balanced", "deep", or an explicit OpenRouter model slug');

export const JsonSchemaField = z
  .record(z.string(), z.unknown())
  .describe('A JSON Schema object, e.g. {"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}');

export async function pickModel(ctx: NodeContext<any>, model: string, prompt: string): Promise<{ tier?: Tier; model?: string; label: string }> {
  if (model === "auto") {
    const tier = await ctx.brain.routeTier(ctx.node.name ?? ctx.node.id, prompt, ctx.node.description);
    return { tier, label: `auto→${tier}` };
  }
  if ((TIER_NAMES as readonly string[]).includes(model)) return { tier: model as Tier, label: model };
  return { model, label: model };
}

export function toText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

/** Validate that a user-supplied JSON schema describes an object with properties. */
export function checkObjectSchema(schema: unknown, path: string) {
  const issues: { message: string; path: string; hint?: string }[] = [];
  const s = schema as JSONSchema | undefined;
  if (!s || typeof s !== "object") return [{ message: "schema is required", path }];
  if (s.type !== "object") issues.push({ message: 'schema.type must be "object"', path: `${path}/type`, hint: 'Wrap fields in {"type":"object","properties":{...}}' });
  if (!s.properties || typeof s.properties !== "object" || !Object.keys(s.properties).length) {
    issues.push({ message: "schema must declare at least one property", path: `${path}/properties` });
  }
  return issues;
}

export function isPlainTemplate(v: unknown) {
  return typeof v === "string" && /^\s*\{\{[\s\S]*\}\}\s*$/.test(v);
}
