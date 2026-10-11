import { Activity, Boxes, Cable, Gauge, Hammer, History, Library, Shapes, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { TokenDialog } from "./components/TokenDialog";
import { api, type Health } from "./lib/api";
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
  { to: "/classes", label: "Classes", icon: Shapes },
  { to: "/automations", label: "Automations", icon: Zap },
  { to: "/runs", label: "Runs", icon: History },
  { to: "/library", label: "Node Library", icon: Library },
  { to: "/connections", label: "Connections", icon: Cable },
  { to: "/benchmark", label: "Benchmark", icon: Gauge },
  { to: "/usage", label: "Usage", icon: Activity },
];

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [down, setDown] = useState(false);
  useEffect(() => {
    api
      .health()
      .then((h) => {
        setHealth(h);
        setDown(false);
      })
      .catch(() => setDown(true));
  }, []);

  return (
    <div className="flex h-full">
      <TokenDialog />
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
          {health && !health.keyConfigured && (
            <div className="rounded-md border border-[rgba(248,113,113,0.4)] p-2 text-[var(--color-bad)]">OPENROUTER_API_KEY missing in .env</div>
          )}
          {health && (
            <div className="space-y-1.5 rounded-lg border border-[var(--color-line)] p-2.5">
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-s1)]" />
                <span className="text-[var(--color-faint)]">System 1</span>
                <span className="mono ml-auto truncate text-[var(--color-muted)]">{health.models.decision.split("/").pop()}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-s2)]" />
                <span className="text-[var(--color-faint)]">System 2</span>
                <span className="mono ml-auto truncate text-[var(--color-muted)]">{health.models.llm.split("/").pop()}</span>
              </div>
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
