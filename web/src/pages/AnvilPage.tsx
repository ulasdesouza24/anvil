import { ArrowRight, BookOpen, Brain, CheckCircle2, FileUp, Hammer, LockKeyhole, Sparkles, TestTube2, Workflow, Wrench, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { StatusBadge, Spinner, Toggle } from "../components/ui";
import { api, type FileView, type LibraryView, type ModelsCheck, type RunSummary } from "../lib/api";
import { FileAttach } from "../components/FileAttach";
import { ago, duration, money } from "../lib/format";

const EXAMPLES = [
  {
    title: "Support triage",
    text: "Triage incoming customer support emails: classify intent (billing, bug, feature request, cancellation, other) and urgency, draft a reply for billing and bug emails grounded in our help-center text (passed as input), and flag angry customers or cancellation threats for a human.",
  },
  {
    title: "Company research brief",
    text: "Given a company name, research it on the web and produce a one-page brief: what they do, founding year, HQ, key products, recent news (last 12 months) with source URLs, and three smart questions a sales rep could ask them.",
  },
  {
    title: "Meeting notes → actions",
    text: "Turn raw meeting notes into a crisp summary, a list of decisions, and action items with owner and due date when mentioned. Flag action items without an owner. Output must be structured JSON.",
  },
  {
    title: "Lead qualification",
    text: "Score inbound B2B leads from a contact-form submission (name, company, role, message): estimate company size and fit for a developer-tools product, compute a 0-100 lead score with explicit weights, route hot leads to a personalized reply draft and cold leads to a nurture tag.",
  },
  {
    title: "Localize product copy",
    text: "Translate a product description into a target language with a native, marketing tone, keeping brand names untouched, staying within ±15% of the original length, and adapting units and currency formats to the locale. Self-check quality before returning.",
  },
  {
    title: "Contract risk review",
    text: "Review a contract text and list risky clauses (auto-renewal, unlimited liability, unilateral changes, data sharing, non-compete), each with severity, a quote of the clause, and a plain-English explanation. Require human approval before marking the review as final.",
  },
];

const STAGES = [
  { icon: Zap, label: "Triage", tone: "var(--color-s1)", text: "Jev answers 8 intake questions in one ~0.3s call" },
  { icon: Brain, label: "Analyze", tone: "var(--color-s2)", text: "precise task spec with testable success criteria" },
  { icon: BookOpen, label: "Library", tone: "var(--color-s1)", text: "class of the task · tested examples · lessons of the domain" },
  { icon: Workflow, label: "Architect", tone: "var(--color-s2)", text: "picks node classes · Jev routes model tiers" },
  { icon: Hammer, label: "Compile", tone: "var(--color-ember)", text: "JSON spec → static checks → auto-repair" },
  { icon: TestTube2, label: "Test", tone: "var(--color-ember)", text: "synthesized suite, Jev-graded criteria" },
  { icon: Sparkles, label: "Evolve", tone: "var(--color-ember)", text: "critic reads traces, patches, keeps the best" },
];

type CandidatesChoice = number | "auto" | "off";

const CANDIDATES_STORAGE_KEY = "anvil.bestOfN";

function storedCandidates(): CandidatesChoice {
  try {
    const stored = localStorage.getItem(CANDIDATES_STORAGE_KEY);
    if (stored === "off") return "off";
    if (stored === "auto") return "auto";
    if (stored && /^[1-9]\d*$/.test(stored)) return Number(stored);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return "off";
}

export function AnvilPage() {
  const nav = useNavigate();
  const [request, setRequest] = useState("");
  const [clarify, setClarify] = useState(true);
  const [evaluate, setEvaluate] = useState(true);
  const [optimize, setOptimize] = useState(true);
  const [useLibrary, setUseLibrary] = useState(true);
  const [candidates, setCandidates] = useState<CandidatesChoice>(storedCandidates);
  const [models, setModels] = useState<ModelsCheck | null>(null);
  /** Files that the person attaches to the request (docs/FILES.md). */
  const [attached, setAttached] = useState<FileView[]>([]);
  const [tools, setTools] = useState("");
  const [toolsError, setToolsError] = useState<string | null>(null);
  const toolsFile = useRef<HTMLInputElement>(null);
  const [library, setLibrary] = useState<LibraryView | null>(null);
  /** The examples that the person selects or removes. Other agents: the builder decides. */
  const [pick, setPick] = useState<Record<string, "use" | "exclude">>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recent, setRecent] = useState<RunSummary[]>([]);

  useEffect(() => {
    api
      .runs({ kind: "build", limit: 8 })
      .then(setRecent)
      .catch(() => undefined);
    api
      .library()
      .then(setLibrary)
      .catch(() => undefined);
    api
      .modelsCheck()
      .then(setModels)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(CANDIDATES_STORAGE_KEY, String(candidates));
    } catch {
      // Keep the control usable when storage is unavailable.
    }
  }, [candidates]);
  useEffect(() => {
    if (models && typeof candidates === "number" && candidates > models.builders.length) {
      setCandidates("auto");
    }
  }, [candidates, models]);
  const candidatesChoices: { value: CandidatesChoice; label: string }[] = [
    { value: "off", label: "Off" },
    { value: "auto", label: "Auto" },
    ...Array.from({ length: models?.builders.length ?? 0 }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
  ];
  const ready = library?.agents.filter((a) => a.example) ?? [];
  const cycle = (id: string) =>
    setPick((p) => {
      const next = { ...p };
      if (!p[id]) next[id] = "use";
      else if (p[id] === "use") next[id] = "exclude";
      else delete next[id];
      return next;
    });

  const start = async () => {
    if (!request.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const ids = (v: "use" | "exclude") => Object.keys(pick).filter((k) => pick[k] === v);
      const { runId } = await api.build({
        request,
        ...(candidates !== "off" ? { candidates } : {}),
        clarify,
        evaluate,
        optimize,
        useLibrary,
        ...(useLibrary ? { examples: ids("use"), excludeExamples: ids("exclude") } : {}),
        ...(attached.length ? { files: attached.map((f) => f.id) } : {}),
        ...(tools.trim() ? { tools } : {}),
      });
      nav(`/builds/${runId}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[980px] px-4 pb-16 pt-8 sm:px-8 sm:pt-14">
        <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-[var(--color-line-2)] px-3 py-1 text-[11.5px] text-[var(--color-muted)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-ember)]" /> An agent that builds agents
        </div>
        <h1 className="text-[34px] font-bold leading-[1.1] tracking-tight sm:text-[40px]">
          Describe a process.
          <br />
          <span className="text-[var(--color-ember)]">Get a tested agent.</span>
        </h1>
        <p className="mt-3 max-w-[640px] text-[15px] leading-relaxed text-[var(--color-muted)]">
          Anvil compiles plain language into a typed JSON workflow of node classes, runs it against a synthesized test suite, and evolves it until it passes — then serves it as an
          API.
        </p>

        <FileAttach
          files={attached}
          onChange={setAttached}
          actions={
            <>
              <details className="contents">
                <summary className="btn !py-1 text-[12px] marker:content-none">
                  <Wrench size={13} /> Tools
                </summary>
                <div className="card order-last mt-1 basis-full p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="label">Given tools</span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <input
                        ref={toolsFile}
                        type="file"
                        accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          const reader = new FileReader();
                          reader.onload = () => {
                            setTools(String(reader.result ?? ""));
                            setToolsError(null);
                          };
                          reader.onerror = () => setToolsError("Could not read this file.");
                          reader.readAsText(file);
                          e.target.value = "";
                        }}
                      />
                      <button type="button" className="btn !py-1 text-[11px]" onClick={() => toolsFile.current?.click()}>
                        <FileUp size={12} /> Load file
                      </button>
                      <button
                        type="button"
                        className="btn !py-1 text-[11px]"
                        disabled={!tools}
                        onClick={() => {
                          setTools("");
                          setToolsError(null);
                        }}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                  <textarea
                    className="input mono resize-y text-[12px]"
                    rows={8}
                    placeholder="Paste an OpenAPI document or function definitions in JSON or YAML."
                    value={tools}
                    onChange={(e) => {
                      setTools(e.target.value);
                      setToolsError(null);
                    }}
                  />
                  <div className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-faint)]">
                    OpenAPI 3, OpenAI/Anthropic function definitions, or {"{tools: [...]}"}. With tools, the agent uses only these tools and does not search the web.
                  </div>
                  {toolsError && <div className="mt-1 text-[11px] text-[var(--color-bad)]">{toolsError}</div>}
                </div>
              </details>
              {tools.trim() && (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-line-2)] px-2 py-1 text-[11.5px]">
                  <LockKeyhole size={13} className="text-[var(--color-ember)]" /> Tools: closed build
                </span>
              )}
            </>
          }
        >
          <div className="card mt-8 mb-2 overflow-hidden p-0 focus-within:border-[var(--color-ember)]">
            <textarea
              className="block min-h-[132px] w-full resize-none bg-transparent px-5 py-4 text-[15px] leading-relaxed outline-none placeholder:text-[var(--color-faint)]"
              placeholder="e.g. Every morning, read the RSS items I paste in, keep only the ones about AI infrastructure, summarize each in two sentences and write a short digest email…"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
              }}
            />
            <div className="flex flex-wrap items-center gap-5 border-t border-[var(--color-line)] bg-[var(--color-panel-2)] px-5 py-3">
              <Toggle checked={clarify} onChange={setClarify} label="Ask if unclear" hint="Let the builder ask blocking questions" />
              <Toggle checked={evaluate} onChange={setEvaluate} label="Test" hint="Synthesize and run a test suite" />
              <Toggle checked={optimize && evaluate} onChange={setOptimize} label="Evolve" hint="Improve the agent from failing tests" />
              {library?.enabled !== false && (
                <Toggle checked={useLibrary} onChange={setUseLibrary} label="Use library" hint="Use tested agents of the same class as examples, and the lessons of the domain" />
              )}
              <div className="flex items-center gap-2 text-[13px]" title="Build one candidate with each builder model, test all of them on one shared suite, and publish the best.">
                <span className={candidates !== "off" ? "text-[var(--color-ember)]" : "text-[var(--color-muted)]"}>Best of N</span>
                <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-line-2)] bg-[var(--color-bg)]" role="group" aria-label="Best of N candidates">
                  {candidatesChoices.map((choice) => {
                    const selected = candidates === choice.value;
                    const active = selected && choice.value !== "off";
                    return (
                      <button
                        key={String(choice.value)}
                        type="button"
                        className={`border-l border-[var(--color-line-2)] px-2.5 py-1 text-[13px] transition-colors first:border-l-0 ${
                          active
                            ? "bg-[var(--color-ember)] text-white"
                            : selected
                              ? "bg-[var(--color-panel)] text-[var(--color-fg)]"
                              : "text-[var(--color-muted)] hover:text-[var(--color-fg)]"
                        }`}
                        aria-pressed={selected}
                        title={
                          typeof choice.value === "number"
                            ? `Build ${choice.value} candidate${choice.value === 1 ? "" : "s"} with the first ${choice.value} builder model${
                                choice.value === 1 ? " — one candidate is a normal build" : "s"
                              }`
                            : undefined
                        }
                        onClick={() => setCandidates(choice.value)}
                      >
                        {choice.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="ml-auto flex items-center gap-3">
                <span className="hidden text-[11px] text-[var(--color-faint)] sm:inline">⌘↵</span>
                <button className="btn btn-primary !px-4 !py-2" disabled={busy || !request.trim()} onClick={start}>
                  {busy ? <Spinner /> : <Hammer size={15} />} Anvil agent
                </button>
              </div>
            </div>
            {candidates !== "off" && (
              <div className="border-t border-[var(--color-line)] bg-[var(--color-panel-2)] px-5 py-2 text-[13px] text-[var(--color-muted)]">
                {models ? (
                  <>
                    Best of N: builds one candidate with each model and publishes the best —{" "}
                    {models.builders.map((model, i) => {
                      const failure = models.failed.find((f) => f.model === model);
                      return (
                        <span key={model} className={`break-all ${failure ? "text-[var(--color-bad)]" : ""}`} title={failure?.error ?? model}>
                          {i ? ", " : ""}
                          {failure ? "✕ " : ""}
                          {model}
                        </span>
                      );
                    })}
                    <span> · judge </span>
                    <span
                      className={`break-all ${models.failed.some((f) => f.model === models.judge) ? "text-[var(--color-bad)]" : ""}`}
                      title={models.failed.find((f) => f.model === models.judge)?.error}
                    >
                      {models.failed.some((f) => f.model === models.judge) ? "✕ " : ""}
                      {models.judge}
                    </span>
                    {!models.builders.some((model) => models.ok.includes(model)) && (
                      <span className="text-[var(--color-bad)]"> · best-of unavailable: no builder model answers</span>
                    )}
                  </>
                ) : (
                  "Checking builder models…"
                )}
              </div>
            )}
          </div>
        </FileAttach>
        {err && <div className="mt-3 text-sm text-[var(--color-bad)]">{err}</div>}
        {useLibrary && library?.enabled !== false && ready.length > 0 && (
          <details className="mt-3 text-[12px]">
            <summary className="cursor-pointer text-[var(--color-muted)]">
              Library examples: {ready.length} tested agent(s) can be examples
              {Object.keys(pick).length > 0 && <span className="text-[var(--color-ember)]"> · {Object.keys(pick).length} set by you</span>}
            </summary>
            <div className="mt-2 text-[11.5px] text-[var(--color-faint)]">
              The builder selects the most similar agents of the same class. Click an agent to use it (it skips the similarity check), click again to never use it, and once more to
              let the builder decide.
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {ready.map((a) => {
                const p = pick[a.id];
                return (
                  <button
                    key={a.id}
                    onClick={() => cycle(a.id)}
                    className="rounded-full border px-2.5 py-1 text-[11.5px] transition-colors"
                    style={{
                      borderColor: p === "use" ? "var(--color-ok)" : p === "exclude" ? "var(--color-bad)" : "var(--color-line-2)",
                      color: p === "use" ? "var(--color-ok)" : p === "exclude" ? "var(--color-bad)" : "var(--color-muted)",
                      textDecoration: p === "exclude" ? "line-through" : undefined,
                    }}
                    title={a.taxonomy ? `${a.taxonomy.domain} / ${a.taxonomy.pattern}` : undefined}
                  >
                    {p === "use" ? "✓ " : ""}
                    {a.name}
                    {a.taxonomy && <span className="text-[var(--color-faint)]"> · {a.taxonomy.domain.replace(/_/g, " ")}</span>}
                  </button>
                );
              })}
            </div>
          </details>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.title}
              className="rounded-full border border-[var(--color-line-2)] px-3 py-1.5 text-[12px] text-[var(--color-muted)] transition-colors hover:border-[var(--color-ember)] hover:text-[var(--color-fg)]"
              onClick={() => setRequest(ex.text)}
            >
              {ex.title}
            </button>
          ))}
        </div>

        <div className="mt-12 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
          {STAGES.map(({ icon: Icon, label, tone, text }, i) => (
            <div key={label} className="card flex items-start gap-3 p-3.5">
              <div className="mono mt-0.5 text-[10.5px] text-[var(--color-faint)]">{String(i + 1).padStart(2, "0")}</div>
              <div>
                <div className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <Icon size={14} style={{ color: tone }} /> {label}
                </div>
                <div className="mt-0.5 text-[12px] leading-snug text-[var(--color-muted)]">{text}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-6 text-center text-[12.5px] text-[var(--color-muted)]">
          Or{" "}
          <button
            className="text-[var(--color-ember)] hover:underline"
            onClick={async () => {
              const name = prompt("Workflow name", "New workflow");
              if (!name?.trim()) return;
              try {
                const a = await api.createBlank(name.trim());
                nav(`/agents/${a.id}/workflow`);
              } catch (e) {
                alert((e as Error).message);
              }
            }}
          >
            start from a blank workflow
          </button>{" "}
          and build it by hand on the canvas.
        </div>

        {recent.length > 0 && (
          <div className="mt-12">
            <div className="label mb-3">Recent builds</div>
            <div className="card divide-y divide-[var(--color-line)]">
              {recent.map((r) => (
                <Link
                  key={r.id}
                  to={`/builds/${r.id}`}
                  className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-[13px] transition-colors hover:bg-[var(--color-panel-2)] sm:flex-nowrap"
                >
                  <StatusBadge status={r.status} />
                  <span className="min-w-0 flex-1 truncate text-[var(--color-muted)]">
                    {(() => {
                      try {
                        return JSON.parse(r.inputPreview ?? "{}").request ?? r.inputPreview;
                      } catch {
                        return r.inputPreview;
                      }
                    })()}
                  </span>
                  {r.resultAgentId && (
                    <span className="mono flex max-w-full items-center gap-1 truncate text-[12px] text-[var(--color-ok)]" title={r.resultAgentId}>
                      <CheckCircle2 size={12} /> {r.resultAgentId}
                    </span>
                  )}
                  <span className="mono w-16 text-right text-[11px] text-[var(--color-faint)]">{duration((r.endedAt ?? Date.now()) - r.startedAt)}</span>
                  <span className="mono w-14 text-right text-[11px] text-[var(--color-faint)]">{money(r.usage.costUsd)}</span>
                  <span className="w-16 text-right text-[11px] text-[var(--color-faint)]">{ago(r.startedAt)}</span>
                  <ArrowRight size={14} className="text-[var(--color-faint)]" />
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
