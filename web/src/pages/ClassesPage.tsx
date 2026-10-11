import { CheckCircle2, CircleSlash, RefreshCw, Shapes } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LessonRow, TaxonomyChips } from "../components/LibraryViews";
import { Empty, Spinner } from "../components/ui";
import { api, type LibraryView } from "../lib/api";

type AgentRow = LibraryView["agents"][number];

function AgentLine({ a }: { a: AgentRow }) {
  return (
    <div className="flex items-center gap-3 py-1.5 text-[12.5px]">
      <Link to={`/agents/${a.id}`} className="min-w-0 truncate font-medium hover:text-[var(--color-ember)]">
        {a.name}
      </Link>
      <TaxonomyChips t={a.taxonomy} />
      <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px]" style={{ color: a.example ? "var(--color-ok)" : "var(--color-faint)" }}>
        {a.example ? <CheckCircle2 size={12} /> : <CircleSlash size={12} />}
        {a.example ? "can be an example" : a.reason}
      </span>
    </div>
  );
}

/**
 * The classes of the library (docs/LIBRARY.md): the agents of each domain, which of them a new
 * build can use as examples, and the lessons that the builds of the domain learned.
 */
export function ClassesPage() {
  const [data, setData] = useState<LibraryView | null>(null);
  const [busy, setBusy] = useState<"" | "missing" | "all">("");
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(() => {
    api
      .library()
      .then(setData)
      .catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(reload, [reload]);

  const classify = async (force: boolean) => {
    setBusy(force ? "all" : "missing");
    setErr(null);
    try {
      const r = await api.classifyLibrary(force);
      setNote(`${r.classified.length} agent(s) classified.`);
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const remove = async (domain: string, id: string) => {
    await api.deleteLesson(domain, id).catch((e) => setErr((e as Error).message));
    reload();
  };

  if (!data)
    return (
      <div className="p-8">
        {err ? <div className="text-sm text-[var(--color-bad)]">{err}</div> : <Spinner />}
      </div>
    );

  const unclassified = data.agents.filter((a) => !a.taxonomy);
  const domains = [...new Set([...data.agents.map((a) => a.taxonomy?.domain), ...Object.keys(data.lessons)].filter((d): d is string => !!d))].sort();
  const examples = data.agents.filter((a) => a.example).length;

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1200px] px-8 py-8">
        <div className="flex items-start gap-3">
          <div>
            <h1 className="text-[22px] font-bold tracking-tight">Agent Classes</h1>
            <p className="mt-1 max-w-[760px] text-[13px] text-[var(--color-muted)]">
              Each agent has a class: domain, pattern, source kind, and output kind. A new build uses the tested agents of the same class as examples, and gets the lessons
              of its domain. {data.agents.length} agents, {examples} can be examples, {domains.length} domains.
            </p>
          </div>
          <div className="ml-auto flex shrink-0 gap-2">
            <button className="btn" disabled={!!busy || !unclassified.length} onClick={() => classify(false)} title="One decision call for each agent without a class">
              {busy === "missing" ? <Spinner /> : <Shapes size={14} />} Classify {unclassified.length} without a class
            </button>
            <button className="btn" disabled={!!busy || !data.agents.length} onClick={() => classify(true)} title="Find the class of every agent again">
              {busy === "all" ? <Spinner /> : <RefreshCw size={14} />} Classify all again
            </button>
          </div>
        </div>
        {!data.enabled && (
          <div className="mt-4 rounded-md border border-[var(--color-line-2)] p-3 text-[12.5px] text-[var(--color-warn)]">
            Library examples and lessons are off (ANVIL_LIBRARY_EXAMPLES=off). Builds still find the class of each agent.
          </div>
        )}
        {note && <div className="mt-3 text-[12.5px] text-[var(--color-ok)]">{note}</div>}
        {err && <div className="mt-3 text-[12.5px] text-[var(--color-bad)]">{err}</div>}

        {!data.agents.length && !domains.length && (
          <Empty icon={<Shapes size={28} />} title="No classes yet">
            Each agent gets a class when it is published. Build an agent on the Build page.
          </Empty>
        )}

        <div className="mt-6 space-y-4">
          {domains.map((d) => {
            const agents = data.agents.filter((a) => a.taxonomy?.domain === d);
            const lessons = data.lessons[d] ?? [];
            return (
              <section key={d} className="card p-4">
                <div className="flex items-baseline gap-3">
                  <h2 className="text-[15px] font-semibold">{d.replace(/_/g, " ")}</h2>
                  <span className="text-[12px] text-[var(--color-faint)]">
                    {agents.length} agent(s) · {lessons.length} lesson(s)
                  </span>
                </div>
                {agents.length > 0 && (
                  <div className="mt-2 divide-y divide-[var(--color-line)]">
                    {agents.map((a) => (
                      <AgentLine key={a.id} a={a} />
                    ))}
                  </div>
                )}
                {lessons.length > 0 && (
                  <div className="mt-3">
                    <div className="label mb-1">Lessons</div>
                    <div className="divide-y divide-[var(--color-line)]">
                      {lessons.map((l) => (
                        <LessonRow key={l.id} l={l} onDelete={() => remove(d, l.id)} />
                      ))}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
          {unclassified.length > 0 && (
            <section className="card p-4">
              <div className="flex items-baseline gap-3">
                <h2 className="text-[15px] font-semibold">Without a class</h2>
                <span className="text-[12px] text-[var(--color-faint)]">These agents are from before the library. Classify them to use them as examples.</span>
              </div>
              <div className="mt-2 divide-y divide-[var(--color-line)]">
                {unclassified.map((a) => (
                  <AgentLine key={a.id} a={a} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
