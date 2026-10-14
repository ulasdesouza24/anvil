import { ArrowLeft, Download, Search, Store, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { GraphView } from "../components/GraphView";
import { Empty, Spinner } from "../components/ui";
import { api, type Listing, type ListingSummary } from "../lib/api";
import { categoryOf, iconFor } from "../lib/categories";
import { ago } from "../lib/format";

function Tags({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t} className="rounded bg-[var(--color-panel-2)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-muted)]">
          #{t}
        </span>
      ))}
    </div>
  );
}

function Card({ l }: { l: ListingSummary }) {
  return (
    <Link to={`/bazaar/${l.id}`} className="card flex flex-col gap-2 p-4 transition-colors hover:border-[var(--color-line-2)] hover:bg-[var(--color-panel-2)]">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{l.title}</div>
          <div className="mono text-[11.5px] text-[var(--color-ember)]">@{l.owner}</div>
        </div>
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--color-muted)]" title="Users who added it">
          <Users size={12} /> {l.uses}
        </span>
      </div>
      <p className="line-clamp-3 text-[12.5px] leading-snug text-[var(--color-muted)]">{l.description || "No description."}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
        {l.stepTypes
          .filter((t) => t !== "input" && t !== "output")
          .slice(0, 6)
          .map((t) => {
            const Icon = iconFor(t);
            const c = categoryOf(t);
            return (
              <span key={t} className="grid h-6 w-6 place-items-center rounded-md" style={{ background: c.bg, color: c.color }} title={t}>
                <Icon size={13} />
              </span>
            );
          })}
        <span className="ml-auto text-[11px] text-[var(--color-faint)]">
          {l.steps} steps · {ago(l.updatedAt)}
        </span>
      </div>
      <Tags tags={l.tags} />
    </Link>
  );
}

/** The Agent Bazaar (docs/BAZAAR.md): agents that users share under their username. */
export function BazaarPage() {
  const [list, setList] = useState<ListingSummary[] | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"new" | "popular">("new");
  const [mine, setMine] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .bazaar({ q, sort, mine })
        .then((l) => {
          setList(l);
          setErr("");
        })
        .catch((e) => setErr((e as Error).message));
    }, 200);
    return () => clearTimeout(t);
  }, [q, sort, mine]);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1200px] px-8 py-8">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-[22px] font-bold tracking-tight">
              <Store size={20} className="text-[var(--color-ember)]" /> Agent Bazaar
            </h1>
            <p className="text-[13px] text-[var(--color-muted)]">Agents that users built and shared. Add one to your agents, then run it with your own key.</p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={13} className="absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--color-faint)]" />
              <input className="input !w-[240px] !py-1.5 !pl-8 text-[12.5px]" placeholder="Search title, tag, or user" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="flex gap-1 rounded-lg border border-[var(--color-line)] p-0.5">
              {(["new", "popular"] as const).map((s) => (
                <button
                  key={s}
                  className={`rounded-md px-2.5 py-1 text-[12px] ${sort === s ? "bg-[var(--color-panel-2)] text-[var(--color-fg)]" : "text-[var(--color-muted)]"}`}
                  onClick={() => setSort(s)}
                >
                  {s === "new" ? "Newest" : "Most used"}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-[12px] text-[var(--color-muted)]">
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only mine
            </label>
          </div>
        </div>
        {err && <div className="mt-4 text-[13px] text-[var(--color-bad)]">{err}</div>}
        {!list && !err && (
          <div className="mt-8">
            <Spinner />
          </div>
        )}
        {list && !list.length && (
          <div className="mt-8">
            <Empty icon={<Store size={28} />} title={q || mine ? "No agent matches" : "No shared agent yet"}>
              Open one of your agents and click Share to Bazaar.
            </Empty>
          </div>
        )}
        {list && list.length > 0 && (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((l) => (
              <Card key={l.id} l={l} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function BazaarListingPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [l, setL] = useState<Listing | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listing(id!)
      .then(setL)
      .catch((e) => setErr((e as Error).message));
  }, [id]);

  if (err) return <div className="p-8 text-[13px] text-[var(--color-bad)]">{err}</div>;
  if (!l) return <div className="p-8">{<Spinner />}</div>;

  const use = async () => {
    setBusy(true);
    try {
      const r = await api.useListing(l.id);
      nav(`/agents/${r.agentId}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const input = Object.entries(l.spec.inputSchema?.properties ?? {}) as [string, { type?: string; description?: string }][];

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-[var(--color-line)] px-8 py-5">
        <Link to="/bazaar" className="inline-flex items-center gap-1 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-fg)]">
          <ArrowLeft size={13} /> Agent Bazaar
        </Link>
        <div className="mt-2 flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[20px] font-bold tracking-tight">{l.title}</h1>
            <div className="mt-0.5 text-[12.5px] text-[var(--color-muted)]">
              by <span className="mono text-[var(--color-ember)]">@{l.owner}</span> · v{l.version} · updated {ago(l.updatedAt)} · added by {l.uses} user(s)
            </div>
            <p className="mt-2 max-w-[780px] text-[13px] leading-relaxed text-[var(--color-muted)]">{l.description || "No description."}</p>
            <div className="mt-2">
              <Tags tags={l.tags} />
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {l.mine && (
              <button
                className="btn btn-danger"
                onClick={async () => {
                  if (!confirm("Remove this agent from the Bazaar? The copies of other users stay.")) return;
                  await api.unshare(l.id);
                  nav("/bazaar");
                }}
              >
                <Trash2 size={14} /> Remove
              </button>
            )}
            <button className="btn btn-primary" disabled={busy} onClick={() => void use()}>
              {busy ? <Spinner /> : <Download size={14} />} Add to my agents
            </button>
          </div>
        </div>
      </header>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="relative min-h-[320px]">
          <GraphView spec={l.spec} />
        </div>
        <aside className="space-y-4 overflow-auto border-t border-[var(--color-line)] p-5 lg:border-t-0 lg:border-l">
          <div>
            <div className="label mb-2">Input</div>
            {input.length ? (
              <ul className="space-y-1.5">
                {input.map(([k, s]) => (
                  <li key={k} className="text-[12.5px]">
                    <span className="mono">{k}</span> <span className="text-[var(--color-faint)]">{s.type}</span>
                    {s.description && <div className="text-[11.5px] text-[var(--color-muted)]">{s.description}</div>}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[12.5px] text-[var(--color-muted)]">No input fields.</div>
            )}
          </div>
          {l.classes.length > 0 && (
            <div>
              <div className="label mb-2">Library classes that come with it</div>
              <ul className="space-y-1.5">
                {l.classes.map((c) => (
                  <li key={c.type} className="text-[12.5px]">
                    <span className="mono">{c.type}</span> <span className="text-[var(--color-faint)]">{c.kind}</span>
                    {c.sideEffects && <div className="text-[11.5px] text-[var(--color-warn)]">Changes the outside world: approve it in the Node Library before it runs.</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="rounded-lg border border-[var(--color-line)] p-3 text-[12px] leading-relaxed text-[var(--color-muted)]">
            You get your own copy. It runs with your OpenRouter key and your secrets. A later change of the owner does not change your copy.
          </div>
        </aside>
      </div>
    </div>
  );
}
