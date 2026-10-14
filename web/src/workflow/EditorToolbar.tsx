import type { AgentSpec } from "@core/types";
import type { Dispatch, ReactNode } from "react";
import { Link } from "react-router-dom";
import { Undo2, Redo2, Settings, Plus, LayoutGrid } from "lucide-react";
import { changesSince, type Action, type EditorState } from "./store";
import { autoLayout } from "./layout";
interface Props {
  agentId: string;
  state: EditorState;
  baseline: AgentSpec;
  base: number;
  status: string;
  readOnly: boolean;
  busy: boolean;
  starting: boolean;
  active: boolean;
  runId?: string;
  toolbar?: ReactNode;
  dispatch: Dispatch<Action>;
  onEdit: (s: AgentSpec, group?: string) => void;
  onProblems: () => void;
  onPalette: () => void;
  onSettings: () => void;
  onTest: () => void;
  onClearRun: () => void;
  onSave: () => void;
}
export function EditorToolbar({
  agentId,
  state,
  baseline,
  base,
  status,
  readOnly,
  busy,
  starting,
  active,
  runId,
  toolbar,
  dispatch,
  onEdit,
  onProblems,
  onPalette,
  onSettings,
  onTest,
  onClearRun,
  onSave,
}: Props) {
  const errors = state.inspection?.errors ?? 0;
  const warnings = state.inspection?.warnings ?? 0;
  const diff = changesSince(baseline, state.spec);
  return (
    <header className="wf-toolbar">
      <Link className="btn" to={`/agents/${agentId}`}>
        ← Agent
      </Link>
      <input
        className="input wf-name"
        aria-label="Workflow name"
        disabled={readOnly || busy}
        value={state.spec.name}
        onChange={(e) => onEdit({ ...state.spec, name: e.target.value }, "name")}
      />
      <span className="mono">base v{base}</span>
      <span role="status" title={`${diff.added.length} added · ${diff.changed.length} changed`}>
        {status}
      </span>
      <button className="btn" onClick={() => onProblems()}>
        {errors} errors · {warnings} warnings
      </button>
      {!readOnly && (
        <>
          <button className="btn" title="Undo" disabled={!state.past.length || busy} onClick={() => dispatch({ type: "undo" })}>
            <Undo2 size={15} />
          </button>
          <button className="btn" title="Redo" disabled={!state.future.length || busy} onClick={() => dispatch({ type: "redo" })}>
            <Redo2 size={15} />
          </button>
          <button className="btn" title="Auto-layout" disabled={busy} onClick={() => onEdit(autoLayout(state.spec))}>
            <LayoutGrid size={15} />
          </button>
          <button className="btn" onClick={() => onPalette()}>
            <Plus size={15} />
            Step
          </button>
        </>
      )}
      <button className="btn" title="Workflow settings" onClick={onSettings}>
        <Settings size={15} />
      </button>
      {!readOnly && (
        <button className="btn" title="Test workflow (Ctrl/Cmd+Enter)" disabled={starting} onClick={onTest}>
          {active ? "Stop" : "Test"}
        </button>
      )}
      {runId && (
        <button className="btn" onClick={onClearRun}>
          Clear run data
        </button>
      )}
      {!!Object.keys(state.pinData).length && (
        <span className="wf-row">
          {Object.keys(state.pinData).length} pinned{" "}
          {!readOnly && (
            <button className="btn" onClick={() => dispatch({ type: "edit", spec: state.spec, pinData: {} })}>
              Clear pins
            </button>
          )}
        </span>
      )}
      {toolbar}
      {!readOnly && (
        <button
          className="btn btn-primary"
          disabled={errors > 0 || busy}
          title={errors ? "Fix compiler errors before saving" : "Save as a new version (Ctrl/Cmd+S)"}
          onClick={() => {
            window.dispatchEvent(new Event("workflow:flush"));
            onSave();
          }}
        >
          Save
        </button>
      )}
    </header>
  );
}
