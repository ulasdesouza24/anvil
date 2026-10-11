import type { RunAgentResult } from "./registry.js";
import type { AgentSpec, RunEvent } from "./types.js";

/** One tool call of a turn: the tool, its arguments, and the start of its result. */
export interface ToolCallRecord {
  tool: string;
  args: unknown;
  result: string;
}

/**
 * The tool calls of one run: the steps of a given tool class (docs/TOOLS.md), with their arguments,
 * and the tool calls inside agent steps. The order is the order of the nodes in the spec.
 */
export function toolCallsOf(spec: AgentSpec, run: Pick<RunAgentResult, "nodeOutputs" | "nodeConfigs">): ToolCallRecord[] {
  const given = new Set([...((spec.meta?.givenTools as string[] | undefined) ?? [])]);
  const out: ToolCallRecord[] = [];
  for (const n of spec.nodes) {
    if (!(n.id in (run.nodeOutputs ?? {}))) continue;
    const o = run.nodeOutputs[n.id];
    if (given.has(n.type) || n.type.startsWith("x_tool_")) out.push({ tool: n.type, args: run.nodeConfigs?.[n.id] ?? null, result: JSON.stringify(o ?? null).slice(0, 300) });
    const steps = (o as { steps?: unknown } | null)?.steps;
    if (Array.isArray(steps))
      // A call that the harness rejected did not run: it is not an action of the agent.
      for (const x of steps)
        if (x && typeof (x as { tool?: unknown }).tool === "string" && !(x as { rejected?: unknown }).rejected)
          out.push({ tool: (x as { tool: string }).tool, args: (x as { args?: unknown }).args, result: String((x as { result?: unknown }).result ?? "").slice(0, 300) });
  }
  return out;
}

/** The tool calls of a recorded run, from its events (a turn of a chat session). */
export function toolCallsOfEvents(spec: AgentSpec, events: RunEvent[]): ToolCallRecord[] {
  const nodeOutputs: Record<string, unknown> = {};
  const nodeConfigs: Record<string, unknown> = {};
  for (const e of events) {
    if (e.type === "node.completed") nodeOutputs[e.nodeId] = e.output;
    if (e.type === "node.started" && e.config !== undefined) nodeConfigs[e.nodeId] = e.config;
  }
  return toolCallsOf(spec, { nodeOutputs, nodeConfigs });
}
