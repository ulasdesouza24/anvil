import { Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { TriggerCard } from "../components/Triggers";
import { Empty, Stat } from "../components/ui";
import { api, type TriggerView } from "../lib/api";

export function AutomationsPage() {
  const [items, setItems] = useState<TriggerView[] | null>(null);
  const load = useCallback(() => {
    api
      .triggers()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  const on = items?.filter((v) => v.enabled) ?? [];
  const fired = items?.reduce((a, v) => a + v.state.fireCount, 0) ?? 0;
  const next = on
    .map((v) => v.state.nextAt)
    .filter((x): x is number => !!x)
    .sort((a, b) => a - b)[0];
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] px-8 py-8">
        <h1 className="text-[22px] font-bold tracking-tight">Automations</h1>
        <p className="text-[13px] text-[var(--color-muted)]">
          Every trigger across your agents. Triggers the builder adds start switched off — turn them on when you’re happy with the agent.
        </p>
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Triggers" value={items?.length ?? "—"} />
          <Stat label="Active" value={on.length} accent="var(--color-ember)" />
          <Stat label="Runs started" value={fired} />
          <Stat
            label="Next scheduled"
            value={next ? new Date(next).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}
            sub={next ? new Date(next).toLocaleDateString() : undefined}
          />
        </div>
        <div className="mt-6 space-y-3">
          {items?.map((v) => (
            <TriggerCard key={`${v.agentId}:${v.trigger.id}`} v={v} onChange={load} showAgent />
          ))}
        </div>
        {items && !items.length && (
          <Empty icon={<Zap size={28} />} title="No automations yet">
            Open an agent and add a trigger in its Triggers tab, or describe the timing when you build (“every weekday at 9…”, “when a new post appears…”).
          </Empty>
        )}
      </div>
    </div>
  );
}
