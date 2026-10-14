export function SaveDialog({
  note,
  onNote,
  busy,
  errors,
  onCancel,
  onSave,
}: {
  note: string;
  onNote: (note: string) => void;
  busy: boolean;
  errors: number;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="wf-overlay">
      <section role="dialog" aria-modal="true" aria-label="Save the draft" className="card wf-dialog">
        <h3>Save the draft</h3>
        <label>
          Version note
          <textarea autoFocus className="input" value={note} onChange={(e) => onNote(e.target.value)} />
        </label>
        <div className="wf-row mt-4">
          <button className="btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || errors > 0} onClick={onSave}>
            Save version
          </button>
        </div>
      </section>
    </div>
  );
}
