import type { AgentSpec } from "./types.js";

/** True when the agent gets data from external sources at run time (its tests cannot know the exact values). */
export function readsLiveData(spec: AgentSpec, task: { dataNeeds?: unknown[] }, implKind?: (type: string) => string | undefined): boolean {
  if (task.dataNeeds?.length) return true;
  const live = new Set(["http", "web_fetch", "web_search", "browser", "mcp"]);
  return spec.nodes.some(
    (n) =>
      live.has(n.type) ||
      live.has(implKind?.(n.type) ?? "") || (n.type === "agent" && ((n.config as { tools?: string[] }).tools ?? []).some((x) => ["web_search", "fetch_url", "browse", "http_request"].includes(x))),
  );
}
