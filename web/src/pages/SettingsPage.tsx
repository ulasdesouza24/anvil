import { KeyRound, RotateCcw, Save, Settings2, User } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Spinner, Toggle } from "../components/ui";
import { api, setToken, type Me, type SettingField } from "../lib/api";
import { useSession } from "../lib/session";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A value of a field as the text of an input. */
function toText(f: SettingField, v: unknown): string {
  if (v === undefined || v === null) return "";
  if (f.type === "list") return (v as string[]).join(", ");
  return String(v);
}

/** The text of an input as a value of the field. The server checks the value again. */
function fromText(f: SettingField, t: string): unknown {
  if (f.type === "number" || f.type === "integer") return t.trim() === "" ? undefined : Number(t);
  if (f.type === "list")
    return t
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  return t;
}

/** A duration in ms as a short text, for the hint next to the field. */
function human(f: SettingField, v: unknown): string | null {
  if (f.unit !== "ms" || typeof v !== "number") return null;
  if (v === 0) return "off";
  if (v >= 86_400_000) return `${+(v / 86_400_000).toFixed(2)} days`;
  if (v >= 3_600_000) return `${+(v / 3_600_000).toFixed(2)} h`;
  if (v >= 60_000) return `${+(v / 60_000).toFixed(2)} min`;
  return `${+(v / 1000).toFixed(2)} s`;
}

function Field({
  f,
  value,
  base,
  overridden,
  onChange,
  onReset,
}: {
  f: SettingField;
  value: unknown;
  base: unknown;
  overridden: boolean;
  onChange: (v: unknown) => void;
  onReset: () => void;
}) {
  const label = (
    <div className="mb-1 flex items-center gap-2">
      <span className="text-[12.5px] font-medium">{f.label}</span>
      {overridden && <span className="rounded bg-[var(--color-panel-2)] px-1.5 text-[10px] text-[var(--color-ember)]">changed</span>}
      {overridden && (
        <button
          className="ml-auto text-[11px] text-[var(--color-muted)] hover:text-[var(--color-fg)]"
          title={`Back to the default: ${toText(f, base) || "empty"}`}
          onClick={onReset}
        >
          <RotateCcw size={11} className="inline" /> default
        </button>
      )}
    </div>
  );
  const help = (
    <div className="mt-1 text-[11.5px] leading-snug text-[var(--color-faint)]">
      {f.help}
      {human(f, value) && <span className="mono ml-1 text-[var(--color-muted)]">({human(f, value)})</span>}
    </div>
  );
  if (f.type === "boolean")
    return (
      <div className="py-2">
        <Toggle checked={!!value} onChange={onChange} label={f.label} hint={f.help} />
        {overridden && (
          <button className="mt-1 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-fg)]" onClick={onReset}>
            <RotateCcw size={11} className="inline" /> default
          </button>
        )}
      </div>
    );
  return (
    <label className="block py-2">
      {label}
      {f.type === "enum" ? (
        <select className="input" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {f.options!.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <div className="flex items-center gap-2">
          <input
            className={`input ${f.type === "text" || f.type === "list" ? "mono" : ""}`}
            type={f.type === "number" || f.type === "integer" ? "number" : "text"}
            min={f.min}
            max={f.max}
            step={f.step ?? (f.type === "integer" ? 1 : "any")}
            value={toText(f, value)}
            placeholder={toText(f, base)}
            onChange={(e) => onChange(fromText(f, e.target.value))}
          />
          {f.unit && <span className="shrink-0 text-[11px] text-[var(--color-faint)]">{f.unit}</span>}
        </div>
      )}
      {help}
    </label>
  );
}

function KeyCard({ me, onMe }: { me: Me; onMe: (m: Me) => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async (value: string) => {
    setBusy(true);
    setErr("");
    try {
      onMe(await api.saveKey(value));
      setKey("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card p-5">
      <div className="flex items-center gap-2">
        <KeyRound size={16} className="text-[var(--color-ember)]" />
        <h2 className="text-[15px] font-semibold">OpenRouter key</h2>
        <span
          className={`ml-auto rounded-md px-2 py-0.5 text-[11.5px] ${me.key.configured ? "bg-[rgba(52,211,153,0.12)] text-[var(--color-ok)]" : "bg-[rgba(248,113,113,0.12)] text-[var(--color-bad)]"}`}
        >
          {me.key.configured ? (me.key.hint ? `saved ${me.key.hint}` : "from .env") : "not set"}
        </span>
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
        Builds and runs use this key, so the model costs go to your OpenRouter account. Anvil keeps it encrypted and never shows it again. Get a key at{" "}
        <a className="text-[var(--color-ember)] hover:underline" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
          openrouter.ai/keys
        </a>
        .
      </p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save(key);
        }}
      >
        <input className="input mono" type="password" autoComplete="off" placeholder="sk-or-v1-…" value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn btn-primary shrink-0" type="submit" disabled={busy || !key.trim()}>
          {busy ? <Spinner /> : <Save size={14} />} Save key
        </button>
        {me.key.hint && (
          <button
            className="btn shrink-0"
            type="button"
            disabled={busy}
            onClick={() => confirm("Remove your OpenRouter key? Builds and runs stop until you add a key again.") && void save("")}
          >
            Remove
          </button>
        )}
      </form>
      {err && <div className="mt-2 text-[12.5px] text-[var(--color-bad)]">{err}</div>}
    </section>
  );
}

function AccountCard({ me, onMe }: { me: Me; onMe: (m: Me) => void }) {
  const { signOut } = useSession();
  const [username, setUsername] = useState(me.account?.username ?? "");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<void>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  if (!me.account) return null;
  return (
    <section className="card p-5">
      <div className="flex items-center gap-2">
        <User size={16} className="text-[var(--color-ember)]" />
        <h2 className="text-[15px] font-semibold">Account</h2>
        <span className="mono ml-auto text-[12px] text-[var(--color-muted)]">@{me.account.username}</span>
      </div>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => onMe(await api.saveUsername(username)), "The username is saved. Your shared agents show the new name.");
          }}
        >
          <span className="label mb-1.5 block">Username</span>
          <div className="flex gap-2">
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
            <button className="btn shrink-0" type="submit" disabled={username === me.account.username}>
              Save
            </button>
          </div>
          <span className="mt-1 block text-[11.5px] text-[var(--color-faint)]">Other users see it on the agents that you share in the Bazaar.</span>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await api.savePassword(current, next);
              setToken(r.token);
              setCurrent("");
              setNext("");
            }, "The password is changed. Your other sessions are signed out.");
          }}
        >
          <span className="label mb-1.5 block">Password</span>
          <div className="flex gap-2">
            <input className="input" type="password" autoComplete="current-password" placeholder="current" value={current} onChange={(e) => setCurrent(e.target.value)} />
            <input className="input" type="password" autoComplete="new-password" placeholder="new (8+)" value={next} onChange={(e) => setNext(e.target.value)} />
            <button className="btn shrink-0" type="submit" disabled={!current || next.length < 8}>
              Change
            </button>
          </div>
        </form>
      </div>
      <div className="mt-4 flex gap-2">
        <button className="btn" onClick={signOut}>
          Sign out
        </button>
        <button
          className="btn"
          onClick={async () => {
            if (!confirm("Sign out on each device?")) return;
            await api.logoutAll();
            signOut();
          }}
        >
          Sign out everywhere
        </button>
      </div>
      {msg && <div className={`mt-2 text-[12.5px] ${msg.ok ? "text-[var(--color-ok)]" : "text-[var(--color-bad)]"}`}>{msg.text}</div>}
      <DeleteAccount />
    </section>
  );
}

/** The danger zone: delete the account and all its data, after the password and the username are typed again. */
function DeleteAccount() {
  const { me, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const username = me?.account?.username ?? "";
  if (!open)
    return (
      <div className="mt-5 border-t border-[var(--color-line)] pt-4">
        <button className="btn btn-danger" onClick={() => setOpen(true)}>
          Delete the account
        </button>
      </div>
    );
  return (
    <form
      className="mt-5 rounded-lg border border-[rgba(248,113,113,0.4)] p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr("");
        try {
          await api.deleteAccount(password);
          signOut();
        } catch (x) {
          setErr((x as Error).message);
          setBusy(false);
        }
      }}
    >
      <div className="text-[13px] font-semibold text-[var(--color-bad)]">Delete the account</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--color-muted)]">
        This deletes your agents, runs, files, secrets, settings, your OpenRouter key, and your Bazaar listings. You cannot undo it. Copies that other users added stay with them.
      </p>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <input className="input" placeholder={`Type ${username}`} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" type="password" autoComplete="current-password" placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {err && <div className="mt-2 text-[12.5px] text-[var(--color-bad)]">{err}</div>}
      <div className="mt-3 flex gap-2">
        <button className="btn" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button className="btn btn-danger" type="submit" disabled={busy || name !== username || !password}>
          {busy ? <Spinner /> : null} Delete everything
        </button>
      </div>
    </form>
  );
}

/**
 * The settings of the workspace (docs/HOSTING.md): the OpenRouter key, the account, and each value that a user
 * can change: models, best-of-N, thresholds, budgets, and limits. The System 1 model (Jev) is fixed.
 */
export function SettingsPage() {
  const { me, refresh } = useSession();
  const [local, setLocal] = useState<Me | null>(me);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [group, setGroup] = useState<string>("Models");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => setLocal(me), [me]);
  const onMe = (m: Me) => {
    setLocal(m);
    void refresh();
  };

  const fields = useMemo(() => {
    if (!local) return [];
    const term = q.trim().toLowerCase();
    return local.fields.filter((f) => (term ? `${f.label} ${f.help} ${f.path}`.toLowerCase().includes(term) : f.group === group));
  }, [local, group, q]);

  if (!local) return <div className="p-8 text-[13px] text-[var(--color-muted)]">Loading…</div>;

  const value = (path: string) => (path in draft ? draft[path] : local.settings.values[path]);
  const overridden = (path: string) => (path in draft ? draft[path] !== null : path in local.settings.overrides);
  const changes = Object.keys(draft).filter((k) => !same(draft[k], k in local.settings.overrides ? local.settings.overrides[k] : local.settings.values[k]) || draft[k] === null);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const m = await api.saveSettings(Object.fromEntries(changes.map((k) => [k, draft[k] === undefined ? null : draft[k]])));
      setDraft({});
      onMe(m);
      setMsg({ ok: true, text: `${changes.length} setting(s) saved. New runs use them.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] px-8 py-8">
        <div className="flex items-end gap-4">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight">Settings</h1>
            <p className="text-[13px] text-[var(--color-muted)]">
              {local.hosted ? "Your key, your account, and the values of your workspace." : "The key and the values of this Anvil."} System 1 (
              <span className="mono">{local.models.decision}</span>) is fixed.
            </p>
          </div>
        </div>
        <div className="mt-6 space-y-4">
          <KeyCard me={local} onMe={onMe} />
          <AccountCard me={local} onMe={onMe} />
          <section className="card overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-5 py-3">
              <Settings2 size={16} className="text-[var(--color-ember)]" />
              <h2 className="text-[15px] font-semibold">Workspace values</h2>
              <input className="input ml-auto !w-[220px] !py-1 text-[12.5px]" placeholder="Search the settings" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="grid md:grid-cols-[200px_minmax(0,1fr)]">
              <nav className="border-b border-[var(--color-line)] p-2 md:border-r md:border-b-0">
                {local.groups.map((g) => {
                  const n = local.fields.filter((f) => f.group === g && overridden(f.path)).length;
                  return (
                    <button
                      key={g}
                      className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12.5px] ${!q && group === g ? "bg-[var(--color-panel-2)] font-medium" : "text-[var(--color-muted)] hover:text-[var(--color-fg)]"}`}
                      onClick={() => {
                        setGroup(g);
                        setQ("");
                      }}
                    >
                      {g}
                      {n > 0 && <span className="ml-auto rounded bg-[var(--color-panel-2)] px-1.5 text-[10px] text-[var(--color-ember)]">{n}</span>}
                    </button>
                  );
                })}
              </nav>
              <div className="grid gap-x-6 px-5 py-3 md:grid-cols-2">
                {fields.map((f) => (
                  <Field
                    key={f.path}
                    f={f}
                    value={value(f.path)}
                    base={local.settings.defaults[f.path]}
                    overridden={overridden(f.path)}
                    onChange={(v) => setDraft((d) => ({ ...d, [f.path]: v }))}
                    onReset={() => setDraft((d) => ({ ...d, [f.path]: null }))}
                  />
                ))}
                {!fields.length && <div className="py-6 text-[13px] text-[var(--color-muted)]">No setting matches.</div>}
              </div>
            </div>
            <div className="flex items-center gap-3 border-t border-[var(--color-line)] px-5 py-3">
              <span className="text-[12px] text-[var(--color-muted)]">{changes.length ? `${changes.length} unsaved change(s)` : "No unsaved change"}</span>
              {msg && <span className={`text-[12.5px] ${msg.ok ? "text-[var(--color-ok)]" : "text-[var(--color-bad)]"}`}>{msg.text}</span>}
              <button className="btn ml-auto" disabled={!changes.length || busy} onClick={() => setDraft({})}>
                Discard
              </button>
              <button className="btn btn-primary" disabled={!changes.length || busy} onClick={() => void save()}>
                {busy ? <Spinner /> : <Save size={14} />} Save
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
