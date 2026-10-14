import type { AgentSpec, StoredAgent } from "@core/types";
import { GitCompare, History, Upload, X } from "lucide-react";
import { ScoreBadge } from "../components/ui";
import { ago } from "../lib/format";

interface Props {
  agent: StoredAgent;
  base: number;
  readOnly: boolean;
  onCompare: (spec: AgentSpec, label: string) => void;
  onLoad: (spec: AgentSpec, version: number) => void;
  onClose: () => void;
}

/** The saved versions of the agent: compare one with the draft on the canvas, or load one into the draft. */
export function VersionsPanel({ agent, base, readOnly, onCompare, onLoad, onClose }: Props) {
  const versions = [...agent.versions].sort((a, b) => b.version - a.version);
  return (
    <aside className="wf-side" aria-label="Versions">
      <div className="wf-row">
        <History size={15} />
        <h3 className="!m-0">Versions</h3>
        <button className="btn btn-ghost ml-auto" title="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <p className="wf-hint !mt-0">The draft started from v{base}. A save makes a new version. Runs, triggers and the API use the current version.</p>
      {versions.map((v) => (
        <div key={v.version} className="wf-list-row flex-col !items-stretch">
          <div className="wf-row">
            <span className="mono font-semibold">v{v.version}</span>
            {v.version === agent.currentVersion && <span className="wf-chip wf-chip-ok">current</span>}
            {v.version === base && <span className="wf-chip wf-chip-warn">base</span>}
            <span className="wf-hint !mt-0 ml-auto">{ago(v.createdAt)}</span>
          </div>
          <div className="truncate text-[11.5px] text-[var(--color-muted)]" title={v.note}>
            {v.note || "no note"}
          </div>
          <div className="wf-row">
            {(v.evaluation || v.score !== undefined) && <ScoreBadge score={v.evaluation?.score ?? v.score} passRate={v.evaluation?.passRate} />}
            <span className="wf-hint !mt-0">{v.spec.nodes.length} steps</span>
            <button className="btn btn-ghost ml-auto" title="Compare this version with the draft" onClick={() => onCompare(v.spec, `v${v.version} → draft`)}>
              <GitCompare size={13} /> Compare
            </button>
            {!readOnly && (
              <button className="btn btn-ghost" title="Load this version into the draft" onClick={() => onLoad(v.spec, v.version)}>
                <Upload size={13} /> Load
              </button>
            )}
          </div>
        </div>
      ))}
    </aside>
  );
}
