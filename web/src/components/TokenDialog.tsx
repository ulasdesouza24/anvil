import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { getToken, setToken } from "../lib/api";

export function TokenDialog() {
  const [open, setOpen] = useState(false);
  const [token, setTokenValue] = useState("");

  useEffect(() => {
    const show = () => {
      setTokenValue(getToken() ?? "");
      setOpen(true);
    };
    window.addEventListener("anvil:unauthorized", show);
    return () => window.removeEventListener("anvil:unauthorized", show);
  }, []);

  if (!open) return null;

  const save = () => {
    setToken(token);
    window.location.reload();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(11,12,14,0.78)] p-4" role="dialog" aria-modal="true" aria-labelledby="token-dialog-title">
      <div className="card fade-in w-full max-w-[420px] p-5 shadow-2xl">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--color-panel-2)] text-[var(--color-ember)]">
            <KeyRound size={16} />
          </div>
          <h2 id="token-dialog-title" className="text-[15px] font-semibold">
            API token
          </h2>
        </div>
        <p className="mt-3 text-[13px] text-[var(--color-muted)]">This Anvil server needs an API token (ANVIL_API_TOKEN).</p>
        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label className="label mb-1.5 block" htmlFor="anvil-token">
            Token
          </label>
          <input id="anvil-token" className="input mono" type="password" autoFocus autoComplete="current-password" value={token} onChange={(event) => setTokenValue(event.target.value)} />
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" type="submit">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
