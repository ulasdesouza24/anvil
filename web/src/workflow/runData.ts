import type { JSONSchema } from "@core/types";
import type { RunState } from "../lib/useRun";
import type { PinData } from "../lib/api";
export function defaults(schema: JSONSchema): unknown {
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (Array.isArray(schema.examples) && schema.examples.length) return structuredClone(schema.examples[0]);
  if (schema.properties)
    return Object.fromEntries(
      Object.entries(schema.properties)
        .map(([key, s]) => [key, defaults(s)])
        .filter(([, v]) => v !== undefined),
    );
  return undefined;
}
export function stepData(run?: RunState): PinData {
  const data: PinData = {};
  for (const e of run?.events ?? []) if (e.type === "node.completed") data[e.nodeId] = { output: e.output, ports: e.ports };
  return Object.assign(data, run?.record?.stepData ?? {});
}
export function nodeOverlay(run: RunState | undefined, id: string) {
  const completed = run?.events.filter((e) => e.type === "node.completed" && e.nodeId === id).at(-1);
  const output = stepData(run)[id]?.output as { dryRun?: boolean; body?: { dryRun?: boolean } } | undefined;
  return {
    status: run?.nodeStates[id],
    error: run?.nodeErrors[id],
    durationMs: completed?.type === "node.completed" ? completed.durationMs : undefined,
    cost: completed?.type === "node.completed" ? completed.usage.costUsd : undefined,
    dryRun: !!(output?.dryRun || output?.body?.dryRun),
    runPinned: run?.events.some((e) => e.type === "log" && e.nodeId === id && e.message.startsWith("pinned:")),
  };
}
