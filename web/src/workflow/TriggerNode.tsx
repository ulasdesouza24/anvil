import type { Trigger } from "@core/types";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { Clock, Webhook, Rss, Bot, Play } from "lucide-react";
export const triggerIcons = { schedule: Clock, webhook: Webhook, poll: Rss, agent: Bot };
export function triggerSummary(t: Trigger, agentId: string) {
  switch (t.type) {
    case "schedule":
      return t.cron ?? `Every ${t.every}`;
    case "webhook":
      return `/api/hooks/${agentId}/${t.id}`;
    case "poll":
      return t.source.url;
    case "agent":
      return `after ${t.agentId} ${t.on}`;
  }
}
export interface TriggerNodeData extends Record<string, unknown> {
  trigger?: Trigger;
  agentId: string;
}
export function TriggerNode({ data, selected }: NodeProps<Node<TriggerNodeData>>) {
  const t = data.trigger;
  const Icon = t ? triggerIcons[t.type] : Play;
  return (
    <div className={`wf-node p-3 ${selected ? "selected" : ""}`}>
      <div className="wf-row">
        <Icon size={17} />
        <strong>{t?.id ?? "Manual"}</strong>
        <span className="ml-auto" title={t?.enabled ? "Enabled by default" : "Disabled by default"} style={{ color: !t || t.enabled ? "var(--color-ok)" : "var(--color-faint)" }}>
          ●
        </span>
      </div>
      <div className="wf-hint truncate" title={t ? triggerSummary(t, data.agentId) : "Test workflow"}>
        {t ? triggerSummary(t, data.agentId) : "Test workflow"}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
