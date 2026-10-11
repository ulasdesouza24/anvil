import type { Lesson, Taxonomy } from "@core/types";
import { BookOpen, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { ago } from "../lib/format";

/** The four axes of a class (docs/LIBRARY.md). */
export function TaxonomyChips({ t, compact = false }: { t: Taxonomy | null | undefined; compact?: boolean }) {
  if (!t) return <span className="text-[11px] text-[var(--color-faint)]">no class</span>;
  const chip = (label: string, value: string, strong = false) => (
    <span
      key={label}
      title={label}
      className="mono inline-flex items-center rounded px-1.5 py-0.5 text-[10.5px]"
      style={strong ? { background: "rgba(249,115,22,0.14)", color: "var(--color-ember)" } : { background: "var(--color-panel-2)", color: "var(--color-muted)" }}
    >
      {value.replace(/_/g, " ")}
    </span>
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {chip("domain", t.domain, true)}
      {chip("pattern", t.pattern)}
      {!compact && chip("source kind", t.sourceKind)}
      {!compact && chip("output kind", t.outputKind)}
    </span>
  );
}

export const LESSON_KIND: Record<Lesson["kind"], { label: string; color: string }> = {
  agent_fix: { label: "agent fix", color: "var(--color-ember)" },
  test_problem: { label: "test problem", color: "var(--color-warn)" },
  source_ok: { label: "source works", color: "var(--color-ok)" },
  source_blocked: { label: "source blocked", color: "var(--color-bad)" },
};

export function LessonRow({ l, onDelete }: { l: Lesson; onDelete?: () => void }) {
  const k = LESSON_KIND[l.kind];
  return (
    <div className="flex items-start gap-2 py-1.5 text-[12px]">
      <span className="mono mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ color: k.color, border: `1px solid ${k.color}` }}>
        {k.label}
      </span>
      <span className="min-w-0 flex-1 break-words text-[var(--color-muted)]">{l.text}</span>
      <span className="mono shrink-0 text-[10.5px] text-[var(--color-faint)]" title={`first ${new Date(l.firstAt).toLocaleString()}`}>
        {l.count > 1 ? `${l.count} builds · ` : ""}
        {l.pattern.replace(/_/g, " ")} · {ago(l.lastAt)}
      </span>
      {onDelete && (
        <button className="shrink-0 text-[var(--color-faint)] hover:text-[var(--color-bad)]" title="Delete this lesson" onClick={onDelete}>
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

interface LibraryArtifact {
  taxonomy: Taxonomy;
  enabled: boolean;
  examples: { agentId: string; version: number; name: string; score: number | null; similarity: number | null; forced?: boolean; classes: string[]; sources: { needId: string; url?: string; classType?: string }[] }[];
  candidates: { agentId: string; name: string; similarity?: number; selected: boolean; reason: string }[];
  lessons: Lesson[];
  droppedLessons?: { text: string; kind: Lesson["kind"]; p: number }[];
}

/** The library step of a build: the class, the examples, the other candidates and why, and the lessons. */
export function LibraryStageView({ data }: { data: LibraryArtifact }) {
  const others = data.candidates.filter((c) => !c.selected);
  return (
    <div className="space-y-2.5 text-[12px]">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-[var(--color-faint)]">class</span>
        <TaxonomyChips t={data.taxonomy} />
      </div>
      {!data.enabled && <div className="text-[11.5px] text-[var(--color-faint)]">Library examples and lessons are off for this build.</div>}
      {data.enabled && (
        <>
          {data.examples.length ? (
            <div className="space-y-1.5">
              {data.examples.map((e) => (
                <div key={e.agentId} className="rounded-md border border-[var(--color-line)] px-2.5 py-1.5">
                  <div className="flex items-center gap-2">
                    <BookOpen size={12} className="text-[var(--color-ember)]" />
                    <Link to={`/agents/${e.agentId}`} className="font-medium hover:text-[var(--color-ember)]">
                      {e.name}
                    </Link>
                    <span className="mono text-[10.5px] text-[var(--color-faint)]">v{e.version}</span>
                    <span className="mono ml-auto text-[10.5px] text-[var(--color-muted)]">
                      {e.forced ? "selected by you" : `similarity ${e.similarity?.toFixed(2)}`} · score {e.score?.toFixed(2) ?? "—"}
                    </span>
                  </div>
                  {(e.classes.length > 0 || e.sources.length > 0) && (
                    <div className="mono mt-0.5 truncate text-[10.5px] text-[var(--color-faint)]">
                      {[...e.classes, ...e.sources.map((s) => s.url ?? s.classType ?? "")].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11.5px] text-[var(--color-faint)]">No tested library agent of this class is similar enough. The build starts without an example.</div>
          )}
          {others.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[11px] text-[var(--color-faint)]">{others.length} other candidate(s)</summary>
              {others.map((c) => (
                <div key={c.agentId} className="mono mt-0.5 flex gap-2 text-[10.5px] text-[var(--color-faint)]">
                  <span className="truncate">{c.name}</span>
                  <span className="ml-auto shrink-0">{c.reason}</span>
                </div>
              ))}
            </details>
          )}
          {(data.droppedLessons?.length ?? 0) > 0 && (
            <details>
              <summary className="cursor-pointer text-[11px] text-[var(--color-faint)]">{data.droppedLessons!.length} lesson(s) of the domain do not apply to this task</summary>
              {data.droppedLessons!.map((l, i) => (
                <div key={i} className="mono mt-0.5 flex gap-2 text-[10.5px] text-[var(--color-faint)]">
                  <span className="truncate">{l.text}</span>
                  <span className="ml-auto shrink-0">p {l.p.toFixed(2)}</span>
                </div>
              ))}
            </details>
          )}
          {data.lessons.length > 0 && (
            <details open>
              <summary className="cursor-pointer text-[11px] text-[var(--color-faint)]">
                {data.lessons.length} lesson(s) of the domain "{data.taxonomy.domain.replace(/_/g, " ")}"
              </summary>
              <div className="divide-y divide-[var(--color-line)]">
                {data.lessons.map((l) => (
                  <LessonRow key={l.id} l={l} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
