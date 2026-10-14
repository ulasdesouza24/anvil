import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, clearToken, getToken, setToken, type Me } from "./api";

/**
 * The session of the web app (docs/HOSTING.md). The local Anvil has no accounts: "me" is the local workspace.
 * A hosted Anvil needs a sign-in: without a valid token, the app shows the sign-in page.
 */
interface Session {
  /** null while the app loads. */
  hosted: boolean | null;
  me: Me | null;
  /** The hosted app needs a sign-in now. */
  signedOut: boolean;
  /** The API cannot be reached. */
  down: boolean;
  refresh: () => Promise<void>;
  signIn: (token: string) => Promise<void>;
  signOut: () => void;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [hosted, setHosted] = useState<boolean | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [down, setDown] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const m = await api.me();
      setMe(m);
      setSignedOut(false);
    } catch (e) {
      if ((e as { status?: number }).status === 401) setSignedOut(true);
      else throw e;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const app = await api.app();
        setHosted(app.hosted);
        setDown(false);
        if (app.hosted && !getToken()) {
          setSignedOut(true);
          return;
        }
        await refresh();
      } catch {
        setDown(true);
        setHosted(false);
      }
    })();
  }, [refresh]);

  // A request that the server refuses (an old or a revoked session) brings back the sign-in page.
  useEffect(() => {
    if (!hosted) return;
    const out = () => {
      clearToken();
      setMe(null);
      setSignedOut(true);
    };
    window.addEventListener("anvil:unauthorized", out);
    return () => window.removeEventListener("anvil:unauthorized", out);
  }, [hosted]);

  const signIn = useCallback(
    async (token: string) => {
      setToken(token);
      await refresh();
    },
    [refresh],
  );

  const signOut = useCallback(() => {
    clearToken();
    setMe(null);
    setSignedOut(true);
  }, []);

  return <Ctx.Provider value={{ hosted, me, signedOut, down, refresh, signIn, signOut }}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession needs a SessionProvider");
  return s;
}
