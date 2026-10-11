import { Boxes, FlaskConical, Hammer, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { qualityOf } from "@core/quality";
import { Empty, QualityBadge, ScoreBadge, StatusBadge } from "../components/ui";
import { TaxonomyChips } from "../components/LibraryViews";
import { api, type AgentHealth, type AgentSummary } from "../lib/api";
import { categoryOf, iconFor } from "../lib/categories";
import { ago } from "../lib/format";

function AgentCard({ a, health }: { a: AgentSummary; health?: AgentHealth }) {
  return (
    <Link to={`/agents/${a.id}`} className="card group flex flex-col p-4 transition-colors hover:border-[var(--color-line-2)] hover:bg-[var(--color-panel-2)]">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold group-hover:text-[var(--color-ember)]">{a.name}</div>
          <div className="mono mt-0.5 truncate text-[11px] text-[var(--color-faint)]" title={a.id}>
            {a.id} · v{a.currentVersion}
            {a.versions > 1 ? ` (${a.versions} versions)` : ""}
          </div>
        </div>
        {!a.system && (
          <div className="flex flex-col items-end gap-1">
            {health && (
              <span title={health.status === "broken" ? health.last?.cause : undefined}>
                <StatusBadge status={health.status} />
              </span>
            )}
            <ScoreBadge score={a.score} passRate={a.passRate} />
            {a.passRate !== null && a.passRate < 1 && <QualityBadge quality={qualityOf({ passRate: a.passRate })} />}
          </div>
        )}
      </div>
      <p className="mt-2 line-clamp-2 min-h-[36px] text-[12.5px] leading-snug text-[var(--color-muted)]">{a.description}</p>
      {!a.system && (
        <div className="mt-2">
          <TaxonomyChips t={a.taxonomy} compact />
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1">
        {a.nodeTypes
          .filter((t) => t !== "input" && t !== "output")
          .map((t) => {
            const Icon = iconFor(t);
            const c = categoryOf(t);
            return (
              <span key={t} className="mono inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px]" style={{ background: c.bg, color: c.color }}>
                <Icon size={10} /> {t}
              </span>
            );
          })}
      </div>
      <div className="mt-3 flex items-center gap-3 border-t border-[var(--color-line)] pt-2.5 text-[11px] text-[var(--color-faint)]">
        <span>{a.nodeCount} nodes</span>
        {!a.system && (
          <span className="flex items-center gap-1">
            <FlaskConical size={11} /> {a.tests} tests
          </span>
        )}
        <span className="ml-auto">{ago(a.updatedAt)}</span>
      </div>
    </Link>
  );
}

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [health, setHealth] = useState<Record<string, AgentHealth>>({});
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  useEffect(() => {
    api
      .agents()
      .then(setAgents)
      .catch((e) => setErr(e.message));
    api
      .healthList()
      .then((items) => setHealth(Object.fromEntries(items.map((h) => [h.agentId, h]))))
      .catch(() => undefined);
  }, []);

  const importFile = async (f: File) => {
    try {
      const spec = JSON.parse(await f.text());
      const a = await api.importAgent(spec);
      nav(`/agents/${a.id}`);
    } catch (e) {
      const d = (e as { data?: { diagnostics?: { message: string }[] } }).data;
      setErr(
        `${(e as Error).message}${
          d?.diagnostics
            ? `: ${d.diagnostics
                .slice(0, 3)
                .map((x) => x.message)
                .join("; ")}`
            : ""
        }`,
      );
    }
  };

  const [domain, setDomain] = useState("");
  const [pattern, setPattern] = useState("");
  const all = agents?.filter((a) => !a.system) ?? [];
  const domains = [...new Set(all.map((a) => a.taxonomy?.domain).filter((d): d is string => !!d))].sort();
  const patterns = [...new Set(all.map((a) => a.taxonomy?.pattern).filter((p): p is string => !!p))].sort();
  const user = all.filter((a) => (!domain || a.taxonomy?.domain === domain) && (!pattern || a.taxonomy?.pattern === pattern));
  const system = agents?.filter((a) => a.system) ?? [];
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-8 sm:py-8">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight">Agents</h1>
            <p className="text-[13px] text-[var(--color-muted)]">Every agent is a versioned JSON spec — runnable in the UI and at its own API endpoint.</p>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <input ref={file} type="file" accept=".json" className="hidden" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
            <button className="btn" onClick={() => file.current?.click()}>
              <Upload size={14} /> Import JSON
            </button>
            <Link to="/" className="btn btn-primary">
              <Hammer size={14} /> Anvil new
            </Link>
          </div>
        </div>
        {err && <div className="mt-4 text-sm text-[var(--color-bad)]">{err}</div>}
        {all.length > 0 && (
          <div className="mt-5 flex flex-wrap items-center gap-2 text-[12px]">
            <span className="text-[var(--color-faint)]">Class</span>
            <select className="input !w-auto !py-1 text-[12px]" value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Filter by domain">
              <option value="">all domains</option>
              {domains.map((d) => (
                <option key={d} value={d}>
                  {d.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <select className="input !w-auto !py-1 text-[12px]" value={pattern} onChange={(e) => setPattern(e.target.value)} aria-label="Filter by pattern">
              <option value="">all patterns</option>
              {patterns.map((p) => (
                <option key={p} value={p}>
                  {p.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            {(domain || pattern) && (
              <span className="text-[var(--color-faint)]">
                {user.length} of {all.length}
              </span>
            )}
            <Link to="/classes" className="ml-auto text-[12px] text-[var(--color-ember)]">
              Classes and lessons →
            </Link>
          </div>
        )}
        {agents && !all.length && (
          <Empty icon={<Boxes size={28} />} title="No agents yet">
            Describe a process on the Build page and Anvil will create one.
          </Empty>
        )}
        <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {user.map((a) => (
            <AgentCard key={a.id} a={a} health={health[a.id]} />
          ))}
        </div>
        {system.length > 0 && (
          <div className="mt-12">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="text-[15px] font-semibold">Meta-agents</h2>
              <span className="text-[12px] text-[var(--color-muted)]">The builder, refiner, evaluator and evolver are Anvil agents too — same IR, same engine.</span>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
              {system.map((a) => (
                <AgentCard key={a.id} a={a} health={health[a.id]} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
