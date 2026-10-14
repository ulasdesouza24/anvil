import type { AgentSpec, Diagnostic, Trigger } from "@core/types";
import type { Dispatch } from "react";
import type { PinData, SaveConflict } from "../lib/api";
import type { Action, EditorState } from "./store";
import { autoLayout } from "./layout";
import { newTrigger } from "./TriggerPanel";
import { JsonValue } from "./ConfigForm";
import { SaveDialog } from "./SaveDialog";
interface Props {
  state: EditorState;
  data: PinData;
  readOnly: boolean;
  busy: boolean;
  triggerMenu: boolean;
  pinEditor?: string;
  problems: boolean;
  toast: string;
  saveDialog: boolean;
  conflict?: SaveConflict;
  note: string;
  errors: number;
  setTriggerMenu: (v: boolean) => void;
  setTriggerPanel: (id: string | undefined) => void;
  setPanel: (id: string | undefined) => void;
  setSettings: (v: boolean) => void;
  setPinEditor: (id: string | undefined) => void;
  setProblems: (v: boolean) => void;
  setSaveDialog: (v: boolean) => void;
  setConflict: (v: SaveConflict | undefined) => void;
  setNote: (s: string) => void;
  setBase: (v: number) => void;
  edit: (spec: AgentSpec, group?: string) => void;
  pin: (id: string, value: unknown) => void;
  showDiagnostic: (d: Diagnostic) => void;
  publish: (force?: boolean) => Promise<void>;
  dispatch: Dispatch<Action>;
}
export function EditorDialogs({
  state,
  data,
  readOnly,
  busy,
  triggerMenu,
  pinEditor,
  problems,
  toast,
  saveDialog,
  conflict,
  note,
  errors,
  setTriggerMenu,
  setTriggerPanel,
  setPanel,
  setSettings,
  setPinEditor,
  setProblems,
  setSaveDialog,
  setConflict,
  setNote,
  setBase,
  edit,
  pin,
  showDiagnostic,
  publish,
  dispatch,
}: Props) {
  return (
    <>
      {triggerMenu && !readOnly && (
        <div className="wf-overlay">
          <section role="dialog" aria-label="Add trigger" className="card wf-dialog">
            <h3>Add trigger</h3>
            {(["schedule", "webhook", "poll", "agent"] as Trigger["type"][]).map((type) => (
              <button
                key={type}
                className="btn"
                onClick={() => {
                  const t = newTrigger(state.spec, type);
                  edit({ ...state.spec, triggers: [...(state.spec.triggers ?? []), t] });
                  setTriggerPanel(t.id);
                  setTriggerMenu(false);
                  setPanel(undefined);
                  setSettings(false);
                }}
              >
                {type === "agent" ? "After another agent" : type[0].toUpperCase() + type.slice(1)}
              </button>
            ))}
            <button className="btn" onClick={() => setTriggerMenu(false)}>
              Cancel
            </button>
          </section>
        </div>
      )}
      {pinEditor && (
        <div className="wf-overlay">
          <section role="dialog" aria-label="Edit pinned data" className="card wf-dialog">
            <h3>Edit pinned data · {pinEditor}</h3>
            <JsonValue value={state.pinData[pinEditor]?.output ?? data[pinEditor]?.output ?? {}} onChange={(value) => pin(pinEditor, value)} />
            <button className="btn" onClick={() => setPinEditor(undefined)}>
              Done
            </button>
          </section>
        </div>
      )}
      {problems && (
        <section className="wf-problems card">
          <div className="wf-row">
            <strong>Problems</strong>
            <button className="btn ml-auto" onClick={() => setProblems(false)}>
              Close
            </button>
          </div>
          {state.inspection?.diagnostics.length ? (
            state.inspection.diagnostics.map((d, i) => (
              <button key={i} className="wf-tree" onClick={() => showDiagnostic(d)}>
                <span className={d.severity === "error" ? "wf-error" : ""}>
                  {d.severity} · {d.nodeId} · {d.message}
                </span>
              </button>
            ))
          ) : (
            <p>No problems</p>
          )}
        </section>
      )}
      {toast && (
        <div role="status" className="wf-toast card">
          {toast}
        </div>
      )}
      {saveDialog && !conflict && <SaveDialog note={note} onNote={setNote} busy={busy} errors={errors} onCancel={() => setSaveDialog(false)} onSave={() => void publish()} />}
      {conflict && (
        <div className="wf-overlay">
          <section role="dialog" aria-modal="true" aria-label="Merge versions" className="card wf-dialog">
            <h3>
              v{conflict.latestVersion} came after your base v{conflict.baseVersion}
            </h3>
            {conflict.merge?.conflicts.map((c) => (
              <p key={c.kind + c.id}>
                {c.kind}: {c.id}
              </p>
            ))}
            <div className="wf-row mt-4">
              <button className="btn" onClick={() => setConflict(undefined)}>
                Cancel
              </button>
              {conflict.merge && (
                <button
                  className="btn"
                  onClick={() => {
                    setBase(conflict.latestVersion);
                    dispatch({ type: "rebase", spec: autoLayout(conflict.merge!.spec, true) });
                    setConflict(undefined);
                    setSaveDialog(false);
                  }}
                >
                  Use merged result
                </button>
              )}
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  if (confirm("Overwrite the latest version with this draft?")) void publish(true);
                }}
              >
                Overwrite
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
