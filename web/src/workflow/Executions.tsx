import { useEffect, useState } from "react";
import { api, type RunSummary } from "../lib/api";
import type { RunState } from "../lib/useRun";
import { EventFeed } from "../components/Feed";
import { duration, money } from "../lib/format";
export function Executions({
  agentId,
  run,
  runId,
  open,
  onOpen,
  onSelect,
  onNode,
  modes,
}: {
  agentId: string;
  run?: RunState;
  runId?: string;
  open: boolean;
  onOpen: (v: boolean) => void;
  onSelect: (id: string) => void;
  onNode: (id: string) => void;
  modes: Record<string, string>;
}) {
  const [tab, setTab] = useState("Log");
  const [height, setHeight] = useState(240);
  const [editor, setEditor] = useState<RunSummary[]>([]);
  const [production, setProduction] = useState<RunSummary[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    Promise.all([api.runs({ agentId, origin: "editor", limit: 50 }), api.runs({ agentId, origin: "!editor", limit: 20 })])
      .then(([a, b]) => {
        if (active) {
          setEditor(a.sort((x, y) => y.startedAt - x.startedAt));
          setProduction(b.sort((x, y) => y.startedAt - x.startedAt));
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [agentId, open, runId, run?.status]);
  const rows = (list: RunSummary[]) => (
    <table className="w-full text-left">
      <thead>
        <tr>
          {["Status", "Mode", "Duration", "Cost", "Time"].map((x) => (
            <th key={x}>{x}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {list.map((r) => (
          <tr key={r.id} className={r.id === runId ? "bg-[var(--color-panel-2)]" : ""}>
            <td>
              <button className="btn" onClick={() => onSelect(r.id)}>
                {r.status}
              </button>
            </td>
            <td>
              {modes[r.id] ?? (r.targetNodeId ? `To / only step ${r.targetNodeId}` : "Full")}
              {r.dryRun && " · dry run"}
            </td>
            <td>{duration(r.endedAt ? r.endedAt - r.startedAt : undefined)}</td>
            <td>{money(r.usage.costUsd)}</td>
            <td>{new Date(r.startedAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <section className="wf-executions" style={{ height: open ? height : 38 }}>
      {open && (
        <div
          role="separator"
          aria-label="Resize executions"
          aria-orientation="horizontal"
          tabIndex={0}
          className="wf-resize"
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") setHeight((h) => Math.min(600, h + 20));
            if (e.key === "ArrowDown") setHeight((h) => Math.max(120, h - 20));
          }}
          onPointerDown={(e) => {
            const start = e.clientY;
            const initial = height;
            e.currentTarget.setPointerCapture(e.pointerId);
            const el = e.currentTarget;
            const move = (event: PointerEvent) => setHeight(Math.max(120, Math.min(window.innerHeight * 0.65, initial + start - event.clientY)));
            const end = () => {
              el.removeEventListener("pointermove", move);
              el.removeEventListener("pointerup", end);
            };
            el.addEventListener("pointermove", move);
            el.addEventListener("pointerup", end);
          }}
        />
      )}
      <div className="wf-row p-2">
        {["Log", "Executions"].map((t) => (
          <button
            className="btn"
            aria-pressed={tab === t}
            key={t}
            onClick={() => {
              setTab(t);
              onOpen(true);
            }}
          >
            {t}
          </button>
        ))}
        <button className="btn ml-auto" onClick={() => onOpen(!open)}>
          {open ? "Collapse" : "Expand"}
        </button>
      </div>
      {open && (
        <div className="overflow-auto p-3">
          {error && <p className="wf-error">{error}</p>}
          {tab === "Log" ? (
            <EventFeed events={run?.events ?? []} onNode={onNode} />
          ) : (
            <>
              {rows(editor)}
              <h3>Production runs</h3>
              {rows(production)}
            </>
          )}
        </div>
      )}
    </section>
  );
}
