import { ArrowRight, Brain, ChevronDown, Code2, Database, FlaskConical, Hammer, KeyRound, PanelsTopLeft, Play, Settings, ShieldCheck, Store, Workflow, X, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { AuthForm, type AuthMode } from "./AuthPage";

const REPO_URL = "https://github.com/ulasdesouza24/anvil";

function GithubMark({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 .7A11.5 11.5 0 0 0 8.36 23.1c.58.1.79-.25.79-.56v-2.23c-3.23.7-3.91-1.37-3.91-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.17.08 1.78 1.2 1.78 1.2 1.04 1.77 2.72 1.26 3.38.96.1-.75.4-1.26.74-1.55-2.58-.29-5.29-1.29-5.29-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18a10.92 10.92 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.72 5.39-5.3 5.68.42.36.79 1.07.79 2.16v3.2c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className={`${compact ? "h-8 w-8 rounded-lg" : "h-9 w-9 rounded-[10px]"} grid shrink-0 place-items-center bg-[var(--color-ember)] text-[#1a0a00] shadow-[0_0_24px_-6px_rgba(249,115,22,0.8)]`}
      >
        <Hammer size={compact ? 17 : 19} strokeWidth={2.5} />
      </div>
      <div>
        <div className={`${compact ? "text-[15px]" : "text-[16px]"} font-bold tracking-tight`}>Anvil</div>
        <div className="-mt-0.5 text-[10.5px] text-[var(--color-faint)]">the agent builder</div>
      </div>
    </div>
  );
}

interface Feature {
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  title: string;
  text: string;
  tone: string;
}

const FEATURES: Feature[] = [
  { icon: Hammer, title: "Build", text: "13 build stages from one sentence.", tone: "var(--color-ember)" },
  { icon: Workflow, title: "A real workflow", text: "A typed graph of node classes, checked by a compiler.", tone: "var(--color-ok)" },
  { icon: Brain, title: "Two minds", text: "System 1 decides fast. System 2 reasons when it must.", tone: "var(--color-s2)" },
  { icon: FlaskConical, title: "Tested until right", text: "Synthesized tests, an evolve loop, and best-of-N with pass^k.", tone: "var(--color-ember)" },
  { icon: ShieldCheck, title: "Safe runs", text: "A self-correcting harness, action gates, and your own rules.", tone: "var(--color-ok)" },
  { icon: Database, title: "Live data", text: "Sources are probed for real. The library grows with each build.", tone: "var(--color-s1)" },
  { icon: Code2, title: "Real tools", text: "Python runs in a gVisor sandbox. Agents can use a real browser.", tone: "var(--color-s2)" },
  { icon: Zap, title: "Autopilot", text: "Schedule, webhook, and poll triggers. Health checks. MCP both ways.", tone: "var(--color-s1)" },
  { icon: PanelsTopLeft, title: "Workflow editor", text: "An n8n-style canvas, dry runs, an AI assistant, and locked steps.", tone: "var(--color-ember)" },
  { icon: Store, title: "Agent Bazaar", text: "Share agents under your username. Add others with one click.", tone: "var(--color-ok)" },
];

const DEEP_DIVES = [
  {
    eyebrow: "Workflow editor",
    title: "See every decision in the graph.",
    text: "Open the workflow canvas to inspect inputs, tools, rules, and outputs. Lock the steps you want to keep. Ask the editor assistant to change the rest, then run a dry test before you save.",
    image: "/onboarding/workflow-editor.svg",
    alt: "Anvil workflow editor with connected typed nodes",
  },
  {
    eyebrow: "Best-of-N",
    title: "Build candidates in parallel.",
    text: "Anvil can build several candidates from the same request. Each candidate runs the same synthesized tests. Pass^k selects the strongest result instead of trusting the first draft.",
    image: "/onboarding/best-of-n.svg",
    alt: "Best-of-N candidate evaluation diagram",
  },
  {
    eyebrow: "System 1 and System 2",
    title: "Spend reasoning where it matters.",
    text: "System 1 handles quick routing and routine decisions. System 2 takes over for work that needs deeper reasoning. The workflow makes that handoff visible.",
    image: "/onboarding/s1s2-v2.svg",
    alt: "System 1 and System 2 routing diagram",
  },
];

function modeFromHash(): AuthMode | null {
  if (window.location.hash === "#login") return "login";
  if (window.location.hash === "#signup") return "register";
  return null;
}

export function OnboardingPage() {
  const initialMode = modeFromHash();
  const [authOpen, setAuthOpen] = useState(initialMode !== null);
  const [authMode, setAuthMode] = useState<AuthMode>(initialMode ?? "register");
  const usernameRef = useRef<HTMLInputElement>(null);

  const openAuth = useCallback((mode: AuthMode) => {
    setAuthMode(mode);
    setAuthOpen(true);
    window.location.hash = mode === "login" ? "login" : "signup";
  }, []);

  const closeAuth = useCallback(() => {
    setAuthOpen(false);
    if (modeFromHash()) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }, []);

  const changeAuthMode = useCallback((mode: AuthMode) => {
    setAuthMode(mode);
    window.history.replaceState(null, "", mode === "login" ? "#login" : "#signup");
  }, []);

  useEffect(() => {
    const syncHash = () => {
      const mode = modeFromHash();
      if (!mode) {
        setAuthOpen(false);
        return;
      }
      setAuthMode(mode);
      setAuthOpen(true);
    };
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  useEffect(() => {
    if (!authOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    usernameRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAuth();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [authOpen, closeAuth]);

  return (
    <div className="h-full overflow-x-hidden overflow-y-auto bg-[var(--color-bg)]">
      <header className="sticky top-0 z-30 border-b border-[color-mix(in_srgb,var(--color-line)_80%,transparent)] bg-[color-mix(in_srgb,var(--color-bg)_88%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-[1180px] items-center px-4">
          <Logo compact />
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <a className="btn btn-ghost !px-2" href={REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="Anvil on GitHub">
              <GithubMark className="h-4 w-4" /> <span>Anvil</span>
            </a>
            <button className="btn btn-ghost" type="button" onClick={() => openAuth("login")}>
              Log in
            </button>
            <button className="btn btn-primary" type="button" onClick={() => openAuth("register")}>
              Sign up
            </button>
          </div>
        </div>
      </header>

      <main>
        <section className="relative mx-auto grid w-full max-w-[1180px] gap-10 px-4 pb-20 pt-16 lg:grid-cols-[0.88fr_1.12fr] lg:items-center lg:pb-28 lg:pt-24">
          <div className="relative z-10">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[var(--color-line-2)] bg-[var(--color-panel)] px-3 py-1 text-[11.5px] text-[var(--color-muted)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-ember)]" /> An agent that builds agents
            </div>
            <h1 className="max-w-[660px] text-[42px] font-bold leading-[1.03] tracking-[-0.035em] sm:text-[56px] lg:text-[62px]">
              Describe a process. <span className="text-[var(--color-ember)]">Get a tested agent.</span>
            </h1>
            <p className="mt-6 max-w-[640px] text-[15px] leading-7 text-[var(--color-muted)] sm:text-[16px]">
              Anvil is an agent that builds agents. It designs a typed workflow, writes tests, fixes the agent until the tests pass, and serves it as an API and an MCP tool.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <button className="btn btn-primary !px-4 !py-2.5" type="button" onClick={() => openAuth("register")}>
                Sign up free <ArrowRight size={15} />
              </button>
              <button className="btn !px-4 !py-2.5" type="button" onClick={() => openAuth("login")}>
                Log in
              </button>
            </div>
          </div>

          <div className="relative lg:-mr-8">
            <div className="absolute -inset-y-8 inset-x-0 -z-10 sm:-inset-8 bg-[radial-gradient(circle_at_center,color-mix(in_srgb,var(--color-ember)_12%,transparent),transparent_66%)]" />
            <div className="card overflow-hidden rounded-[16px] p-1.5 shadow-[0_28px_80px_-38px_rgba(0,0,0,0.9)]">
              <video className="aspect-video w-full rounded-[11px] bg-[var(--color-panel-2)] object-cover" autoPlay muted loop playsInline poster="/onboarding/hero.jpg">
                <source src="/onboarding/hero.webm" type="video/webm" />
                <source src="/onboarding/hero.mp4" type="video/mp4" />
              </video>
            </div>
          </div>
        </section>

        <section className="border-y border-[var(--color-line)] bg-[var(--color-panel)]">
          <div className="mx-auto w-full max-w-[1180px] px-4 py-20 sm:py-24">
            <div className="mb-10 max-w-[620px]">
              <div className="label mb-3 text-[var(--color-ember)]">Your first build</div>
              <h2 className="text-[30px] font-bold tracking-tight sm:text-[38px]">Get started in 4 steps</h2>
              <p className="mt-3 text-[14px] leading-6 text-[var(--color-muted)]">Set up your workspace, then turn one sentence into an agent you can inspect and share.</p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <article className="rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] p-5 sm:p-6">
                <div className="mb-8 flex items-center justify-between">
                  <span className="mono text-[12px] text-[var(--color-ember)]">01</span>
                  <div className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--color-panel-2)] text-[var(--color-ember)]">
                    <KeyRound size={17} />
                  </div>
                </div>
                <h3 className="text-[17px] font-semibold">Create an account</h3>
                <p className="mt-2 text-[13.5px] leading-6 text-[var(--color-muted)]">Pick a username. Other users see it on the agents you share.</p>
              </article>

              <article className="rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] p-5 sm:p-6">
                <div className="mb-8 flex items-center justify-between">
                  <span className="mono text-[12px] text-[var(--color-ember)]">02</span>
                  <div className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--color-panel-2)] text-[var(--color-s1)]">
                    <Settings size={17} />
                  </div>
                </div>
                <h3 className="text-[17px] font-semibold">Add your OpenRouter key</h3>
                <p className="mt-2 text-[13.5px] leading-6 text-[var(--color-muted)]">
                  Add it in Settings. Builds and runs use your key. It is stored encrypted, and Anvil shows only its last 4 characters.
                </p>
                <a
                  className="mt-4 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--color-ember)] hover:text-[var(--color-ember-2)]"
                  href="https://openrouter.ai/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Get a key <ArrowRight size={13} />
                </a>
              </article>

              <article className="rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] p-5 sm:p-6">
                <div className="mb-6 flex items-center justify-between">
                  <span className="mono text-[12px] text-[var(--color-ember)]">03</span>
                  <div className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--color-panel-2)] text-[var(--color-ok)]">
                    <Hammer size={17} />
                  </div>
                </div>
                <h3 className="text-[17px] font-semibold">Build your first agent</h3>
                <p className="mt-2 text-[13.5px] leading-6 text-[var(--color-muted)]">Describe a process in one sentence on the Build page.</p>
                <div className="mt-5 rounded-lg border border-[var(--color-line-2)] bg-[var(--color-panel)] p-3.5">
                  <div className="label mb-2">Build request</div>
                  <p className="text-[12.5px] leading-5 text-[var(--color-muted)]">Score inbound leads 0-100, draft a reply to hot leads, and tag cold leads for nurture.</p>
                  <div className="mt-3 flex justify-end">
                    <span className="grid h-7 w-7 place-items-center rounded-md bg-[var(--color-ember)] text-[#1a0a00]">
                      <ArrowRight size={13} />
                    </span>
                  </div>
                </div>
              </article>

              <article className="rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] p-5 sm:p-6">
                <div className="mb-8 flex items-center justify-between">
                  <span className="mono text-[12px] text-[var(--color-ember)]">04</span>
                  <div className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--color-panel-2)] text-[var(--color-s2)]">
                    <Play size={17} />
                  </div>
                </div>
                <h3 className="text-[17px] font-semibold">Edit, test, share</h3>
                <p className="mt-2 text-[13.5px] leading-6 text-[var(--color-muted)]">
                  Open the agent on the workflow canvas, test it in a dry run, and share it in the Agent Bazaar.
                </p>
                <div className="mt-5 flex flex-wrap gap-2 text-[11px] text-[var(--color-faint)]">
                  <span className="rounded-md border border-[var(--color-line)] px-2 py-1">Edit</span>
                  <span className="rounded-md border border-[var(--color-line)] px-2 py-1">Dry run</span>
                  <span className="rounded-md border border-[var(--color-line)] px-2 py-1">Share</span>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-[1180px] px-4 py-20 sm:py-28">
          <div className="mb-10 max-w-[620px]">
            <div className="label mb-3 text-[var(--color-ember)]">Inside the system</div>
            <h2 className="text-[30px] font-bold tracking-tight sm:text-[38px]">What Anvil does</h2>
            <p className="mt-3 text-[14px] leading-6 text-[var(--color-muted)]">The builder, runtime, and editor work as one system.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {FEATURES.map(({ icon: Icon, title, text, tone }) => (
              <article key={title} className="card min-h-[178px] p-4 transition-colors hover:border-[var(--color-line-2)]">
                <div className="mb-7 grid h-8 w-8 place-items-center rounded-lg bg-[var(--color-panel-2)]" style={{ color: tone }}>
                  <Icon size={16} strokeWidth={2} />
                </div>
                <h3 className="text-[14px] font-semibold">{title}</h3>
                <p className="mt-2 text-[12.5px] leading-5 text-[var(--color-muted)]">{text}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="border-y border-[var(--color-line)] bg-[var(--color-panel)]">
          <div className="mx-auto w-full max-w-[1180px] px-4 py-20 sm:py-28">
            <div className="space-y-20 sm:space-y-28">
              {DEEP_DIVES.map((item, index) => (
                <article key={item.eyebrow} className="grid items-center gap-8 lg:grid-cols-2 lg:gap-16">
                  <div className={index % 2 ? "lg:order-2" : ""}>
                    <div className="label mb-3 text-[var(--color-ember)]">{item.eyebrow}</div>
                    <h2 className="max-w-[520px] text-[28px] font-bold leading-tight tracking-tight sm:text-[36px]">{item.title}</h2>
                    <p className="mt-4 max-w-[520px] text-[14px] leading-7 text-[var(--color-muted)]">{item.text}</p>
                  </div>
                  <div className={`${index % 2 ? "lg:order-1" : ""} overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] p-2`}>
                    <img className="h-auto w-full rounded-lg" src={item.image} alt={item.alt} loading="lazy" />
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-[820px] px-4 py-20 sm:py-28">
          <div className="mb-9 text-center">
            <div className="label mb-3 text-[var(--color-ember)]">FAQ</div>
            <h2 className="text-[30px] font-bold tracking-tight sm:text-[38px]">Before your first build</h2>
          </div>
          <div className="divide-y divide-[var(--color-line)] border-y border-[var(--color-line)]">
            <details className="group py-1">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-[14px] font-medium marker:content-none">
                Is Anvil free?
                <ChevronDown className="shrink-0 text-[var(--color-faint)] transition-transform group-open:rotate-180" size={16} />
              </summary>
              <p className="max-w-[700px] pb-5 text-[13.5px] leading-6 text-[var(--color-muted)]">
                The site is free. You pay only for the model calls, with your own OpenRouter key.
              </p>
            </details>
            <details className="group py-1">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-[14px] font-medium marker:content-none">
                Where is my data?
                <ChevronDown className="shrink-0 text-[var(--color-faint)] transition-transform group-open:rotate-180" size={16} />
              </summary>
              <p className="max-w-[700px] pb-5 text-[13.5px] leading-6 text-[var(--color-muted)]">
                In your own workspace. Delete the account in Settings, and Anvil deletes your agents, runs, files, secrets, and key.
              </p>
            </details>
            <details className="group py-1">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-[14px] font-medium marker:content-none">
                Is my key safe?
                <ChevronDown className="shrink-0 text-[var(--color-faint)] transition-transform group-open:rotate-180" size={16} />
              </summary>
              <p className="max-w-[700px] pb-5 text-[13.5px] leading-6 text-[var(--color-muted)]">
                It is encrypted on disk with AES-256-GCM. The API shows only the last 4 characters.
              </p>
            </details>
            <details className="group py-1">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-[14px] font-medium marker:content-none">
                Is it open source?
                <ChevronDown className="shrink-0 text-[var(--color-faint)] transition-transform group-open:rotate-180" size={16} />
              </summary>
              <p className="max-w-[700px] pb-5 text-[13.5px] leading-6 text-[var(--color-muted)]">
                Yes. Anvil uses the Apache-2.0 license.{" "}
                <a className="text-[var(--color-ember)] hover:text-[var(--color-ember-2)]" href={REPO_URL} target="_blank" rel="noopener noreferrer">
                  View the repository.
                </a>
              </p>
            </details>
          </div>
        </section>

        <section className="px-4 pb-8">
          <div className="relative mx-auto flex w-full max-w-[1180px] flex-col items-start justify-between gap-6 overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--color-ember)_38%,var(--color-line))] bg-[var(--color-panel)] px-6 py-10 sm:flex-row sm:items-center sm:px-10 sm:py-12">
            <div className="absolute -right-24 -top-32 h-72 w-72 rounded-full bg-[color-mix(in_srgb,var(--color-ember)_10%,transparent)] blur-3xl" />
            <div className="relative">
              <div className="label mb-2 text-[var(--color-ember)]">Your first agent</div>
              <h2 className="text-[28px] font-bold tracking-tight sm:text-[36px]">Start with one sentence.</h2>
            </div>
            <button className="btn btn-primary relative !px-5 !py-2.5" type="button" onClick={() => openAuth("register")}>
              Sign up <ArrowRight size={15} />
            </button>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-4 py-8 text-[12px] text-[var(--color-faint)] sm:flex-row sm:items-center">
        <Logo compact />
        <div className="flex items-center gap-5 sm:ml-auto">
          <a className="inline-flex items-center gap-2 hover:text-[var(--color-fg)]" href={REPO_URL} target="_blank" rel="noopener noreferrer">
            <GithubMark className="h-4 w-4" /> Anvil
          </a>
          <span>Apache-2.0</span>
        </div>
      </footer>

      {authOpen && (
        <div
          className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[rgba(5,6,8,0.82)] p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="auth-dialog-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAuth();
          }}
        >
          <div className="card fade-in relative w-full max-w-[420px] p-5 shadow-2xl sm:p-6">
            <button className="btn btn-ghost absolute right-3 top-3 !p-1.5" type="button" aria-label="Close" onClick={closeAuth}>
              <X size={16} />
            </button>
            <div className="mb-5 pr-9">
              <h2 id="auth-dialog-title" className="text-[20px] font-bold tracking-tight">
                {authMode === "login" ? "Log in to Anvil" : "Create your account"}
              </h2>
              <p className="mt-1.5 text-[12.5px] leading-5 text-[var(--color-muted)]">Build, test, and run agents in your workspace.</p>
            </div>
            <AuthForm mode={authMode} onModeChange={changeAuthMode} usernameInputRef={usernameRef} onSuccess={closeAuth} />
          </div>
        </div>
      )}
    </div>
  );
}
