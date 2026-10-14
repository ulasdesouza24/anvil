import type { AgentSpec } from "@core/types";
import { layout } from "../components/GraphView";
export function autoLayout(spec: AgentSpec, missingOnly = false): AgentSpec {
  const positions = layout(spec, { direction: "LR" });
  return { ...spec, nodes: spec.nodes.map((n) => (missingOnly && n.position ? n : { ...n, position: positions[n.id] })) };
}
