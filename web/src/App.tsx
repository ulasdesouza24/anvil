import { Activity, Boxes, Cable, Gauge, Hammer, History, Library, LogOut, Settings, Shapes, Store, Zap } from "lucide-react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { TokenDialog } from "./components/TokenDialog";
import { SessionProvider, useSession } from "./lib/session";
import { AuthPage } from "./pages/AuthPage";
import { BazaarListingPage, BazaarPage } from "./pages/BazaarPage";
import { SettingsPage } from "./pages/SettingsPage";
import { WorkflowEditorPage } from "./pages/WorkflowEditorPage";
import { AgentPage } from "./pages/AgentPage";
import { AgentsPage } from "./pages/AgentsPage";
import { AutomationsPage } from "./pages/AutomationsPage";
import { BenchmarkPage } from "./pages/BenchmarkPage";
import { BuildPage } from "./pages/BuildPage";
import { ClassesPage } from "./pages/ClassesPage";
import { ConnectionsPage } from "./pages/ConnectionsPage";
import { AnvilPage } from "./pages/AnvilPage";
import { LibraryPage } from "./pages/LibraryPage";
import { RunPage } from "./pages/RunPage";
import { RunsPage } from "./pages/RunsPage";
import { UsagePage } from "./pages/UsagePage";

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <div className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--color-ember)] text-[#1a0a00] shadow-[0_0_24px_-6px_rgba(249,115,22,0.8)]">
        <Hammer size={17} strokeWidth={2.5} />
      </div>
      <div>
        <div className="text-[15px] font-bold tracking-tight">Anvil</div>
        <div className="-mt-0.5 text-[10.5px] text-[var(--color-faint)]">the agent builder</div>
      </div>
    </div>
  );
}

const NAV = [
  { to: "/", label: "Build", icon: Hammer, end: true },
  { to: "/agents", label: "Agents", icon: Boxes },
  { to: "/bazaar", label: "Agent Bazaar", icon: Store },
  { to: "/classes", label: "Classes", icon: Shapes },
  { to: "/automations", label: "Automations", icon: Zap },
  { to: "/runs", label: "Runs", icon: History },
  { to: "/library", label: "Node Library", icon: Library },
  { to: "/connections", label: "Connections", icon: Cable },
  { to: "/benchmark", label: "Benchmark", icon: Gauge },
  { to: "/usage", label: "Usage", icon: Activity },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}

function Shell() {
  const { hosted, me, signedOut, down, signOut } = useSession();
  if (hosted === null) return <div className="grid h-full place-items-center text-[13px] text-[var(--color-muted)]">Loading…</div>;
  // A hosted Anvil shows the sign-in page until the user signs in (docs/HOSTING.md).
  if (hosted && signedOut) return <AuthPage />;

  return (
    <div className="flex h-full">
      {!hosted && <TokenDialog />}
      <aside className="flex w-[216px] shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-4">
        <Logo />
        <nav className="mt-7 space-y-0.5">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors ${isActive ? "bg-[var(--color-panel-2)] font-medium text-[var(--color-fg)]" : "text-[var(--color-muted)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-fg)]"}`
              }
            >
              <Icon size={15} /> {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-2 px-1 text-[11px]">
          {down && <div className="rounded-md border border-[rgba(248,113,113,0.4)] p-2 text-[var(--color-bad)]">API unreachable — is the server running?</div>}
          {me && !me.key.configured && (
            <Link to="/settings" className="block rounded-md border border-[rgba(248,113,113,0.4)] p-2 text-[var(--color-bad)] hover:bg-[rgba(248,113,113,0.06)]">
              Add your OpenRouter key in Settings
            </Link>
          )}
          {me && (
            <Link
              to="/settings"
              className="block space-y-1.5 rounded-lg border border-[var(--color-line)] p-2.5 hover:border-[var(--color-line-2)]"
              title="Change the models in Settings"
            >
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-s1)]" />
                <span className="text-[var(--color-faint)]">System 1</span>
                <span className="mono ml-auto truncate text-[var(--color-muted)]">{me.models.decision.split("/").pop()}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-s2)]" />
                <span className="text-[var(--color-faint)]">System 2</span>
                <span className="mono ml-auto truncate text-[var(--color-muted)]" title={me.models.llm}>
                  {me.models.llm.split("/").pop()}
                </span>
              </div>
            </Link>
          )}
          {me?.account && (
            <div className="flex items-center gap-2 rounded-lg px-1 py-1">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--color-panel-2)] text-[11px] font-semibold uppercase text-[var(--color-ember)]">
                {me.account.username[0]}
              </span>
              <span className="mono min-w-0 flex-1 truncate text-[12px] text-[var(--color-muted)]">@{me.account.username}</span>
              <button className="text-[var(--color-faint)] hover:text-[var(--color-fg)]" title="Sign out" onClick={signOut}>
                <LogOut size={13} />
              </button>
            </div>
          )}
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<AnvilPage />} />
          <Route path="/builds/:runId" element={<BuildPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/:id" element={<AgentPage />} />
          <Route path="/agents/:id/workflow" element={<WorkflowEditorPage />} />
          <Route path="/bazaar" element={<BazaarPage />} />
          <Route path="/bazaar/:id" element={<BazaarListingPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/automations" element={<AutomationsPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/classes" element={<ClassesPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/benchmark" element={<BenchmarkPage />} />
          <Route path="/usage" element={<UsagePage />} />
        </Routes>
      </main>
    </div>
  );
}
