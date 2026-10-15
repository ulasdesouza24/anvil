import { Hammer } from "lucide-react";
import { useState, type Ref } from "react";
import { Spinner } from "../components/ui";
import { api } from "../lib/api";
import { useSession } from "../lib/session";

export type AuthMode = "login" | "register";

interface AuthFormProps {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  usernameInputRef?: Ref<HTMLInputElement>;
  onSuccess?: () => void;
}

/** Shared sign-in and sign-up form for a hosted Anvil. */
export function AuthForm({ mode, onModeChange, usernameInputRef, onSuccess }: AuthFormProps) {
  const { signIn } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const changeMode = (next: AuthMode) => {
    onModeChange(next);
    setErr("");
  };

  const submit = async () => {
    setErr("");
    if (mode === "register" && password !== repeat) return setErr("The two passwords are not the same");
    setBusy(true);
    try {
      const result = mode === "login" ? await api.login(username, password) : await api.register(username, password);
      await signIn(result.token);
      onSuccess?.();
    } catch (error) {
      setErr((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mb-4 flex rounded-lg border border-[var(--color-line)] p-0.5 text-[13px]" role="tablist" aria-label="Account access">
        {(["login", "register"] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={mode === item}
            className={`flex-1 rounded-md py-1.5 ${mode === item ? "bg-[var(--color-panel-2)] font-medium text-[var(--color-fg)]" : "text-[var(--color-muted)]"}`}
            onClick={() => changeMode(item)}
          >
            {item === "login" ? "Log in" : "Sign up"}
          </button>
        ))}
      </div>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="block">
          <span className="label mb-1.5 block">Username</span>
          <input
            ref={usernameInputRef}
            className="input"
            autoFocus
            autoComplete="username"
            minLength={3}
            maxLength={24}
            pattern="[A-Za-z0-9_]+"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          {mode === "register" && (
            <span className="mt-1 block text-[11.5px] text-[var(--color-faint)]">3 to 24 letters, digits, or underscores. Other users see it on the agents that you share.</span>
          )}
        </label>
        <label className="block">
          <span className="label mb-1.5 block">Password</span>
          <input
            className="input"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={mode === "register" ? 8 : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {mode === "register" && (
          <label className="block">
            <span className="label mb-1.5 block">Password again</span>
            <input className="input" type="password" autoComplete="new-password" minLength={8} value={repeat} onChange={(event) => setRepeat(event.target.value)} />
            <span className="mt-1 block text-[11.5px] text-[var(--color-faint)]">At least 8 characters.</span>
          </label>
        )}
        {err && (
          <div className="text-[12.5px] text-[var(--color-bad)]" role="alert">
            {err}
          </div>
        )}
        <button className="btn btn-primary w-full justify-center" type="submit" disabled={busy || !username || !password}>
          {busy && <Spinner />} {mode === "login" ? "Log in" : "Create the account"}
        </button>
      </form>
    </>
  );
}

/** Sign-in and sign-up of a hosted Anvil (docs/HOSTING.md). The username is public: shared agents show it. */
export function AuthPage() {
  const [mode, setMode] = useState<AuthMode>("login");

  return (
    <div className="grid h-full place-items-center overflow-auto p-4">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--color-ember)] text-[#1a0a00] shadow-[0_0_28px_-6px_rgba(249,115,22,0.8)]">
            <Hammer size={20} strokeWidth={2.5} />
          </div>
          <div>
            <div className="text-[20px] font-bold tracking-tight">Anvil</div>
            <div className="-mt-0.5 text-[12px] text-[var(--color-faint)]">the agent builder</div>
          </div>
        </div>
        <div className="card p-5">
          <AuthForm mode={mode} onModeChange={setMode} />
        </div>
        <p className="mt-4 text-center text-[12px] leading-relaxed text-[var(--color-faint)]">
          Anvil builds, tests, and improves AI agents. Runs use your own OpenRouter key: add it in Settings after you sign in.
        </p>
      </div>
    </div>
  );
}
