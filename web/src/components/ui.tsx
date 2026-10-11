import { type Quality, QUALITY_TEXT } from "@core/quality";
import type { NodeStatus } from "@core/types";
import { json } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { Check, Copy, Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";

const cmTheme = EditorView.theme(
  {
    "&": { backgroundColor: "transparent", color: "#d6dae2" },
    ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "#4b5261" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "rgba(255,255,255,0.025)" },
    ".cm-content": { fontFamily: "var(--font-mono)" },
    ".cm-cursor": { borderLeftColor: "#f97316" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "rgba(249,115,22,0.22) !important" },
    ".cm-matchingBracket": { backgroundColor: "rgba(249,115,22,0.18)", outline: "none" },
  },
  { dark: true },
);

export function JsonEditor({
  value,
  onChange,
  readOnly,
  height = "100%",
  minHeight,
}: {
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  height?: string;
  minHeight?: string;
}) {
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      editable={!readOnly}
      height={height}
      minHeight={minHeight}
      theme="dark"
      extensions={[json(), cmTheme, EditorView.lineWrapping]}
      basicSetup={{ foldGutter: true, lineNumbers: !readOnly, highlightActiveLine: !readOnly, highlightActiveLineGutter: !readOnly }}
    />
  );
}

export function JsonBlock({ value, max = 12000, className = "" }: { value: unknown; max?: number; className?: string }) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text === undefined) text = "undefined";
  if (text.length > max) text = `${text.slice(0, max)}\n… (${text.length - max} more chars)`;
  return (
    <pre className={`mono overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--color-bg)] p-3 text-[11.5px] leading-relaxed text-[#cfd4dc] ${className}`}>{text}</pre>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn btn-ghost !px-2 !py-1 text-xs"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />} {label}
    </button>
  );
}

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  healthy: { color: "#34d399", label: "healthy" },
  broken: { color: "#f87171", label: "broken" },
  unknown: { color: "#9097a4", label: "unknown" },
  running: { color: "#f97316", label: "running" },
  connecting: { color: "#9097a4", label: "connecting" },
  queued: { color: "#9097a4", label: "queued" },
  waiting: { color: "#fb7185", label: "needs you" },
  completed: { color: "#34d399", label: "completed" },
  done: { color: "#34d399", label: "done" },
  failed: { color: "#f87171", label: "failed" },
  cancelled: { color: "#9097a4", label: "cancelled" },
  skipped: { color: "#5d6472", label: "skipped" },
  pending: { color: "#5d6472", label: "pending" },
};

export function StatusBadge({ status }: { status: string | NodeStatus }) {
  const s = STATUS_STYLE[status] ?? { color: "#9097a4", label: status };
  const live = status === "running" || status === "waiting" || status === "connecting";
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium"
      style={{ borderColor: `${s.color}55`, color: s.color, background: `${s.color}14` }}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${live ? "pulse-dot" : ""}`} style={{ background: s.color }} />
      {s.label}
    </span>
  );
}

const QUALITY_STYLE: Record<Quality, { label: string; color: string }> = {
  passed: { label: "tests pass", color: "var(--color-ok)" },
  partial: { label: "some tests fail", color: "var(--color-warn)" },
  failed: { label: "no test passes", color: "var(--color-bad)" },
  untested: { label: "not evaluated", color: "var(--color-faint)" },
};

/** A small label for the quality of an agent version. */
export function QualityBadge({ quality }: { quality: Quality }) {
  const q = QUALITY_STYLE[quality];
  return (
    <span className="whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px]" style={{ color: q.color, borderColor: q.color }} title={QUALITY_TEXT[quality]}>
      {q.label}
    </span>
  );
}

/** A warning above an agent whose tests do not all pass. */
export function QualityWarning({ quality, report }: { quality: Quality; report?: { agentProblems?: number; testProblems?: number; disputedProblems?: number } }) {
  if (quality !== "failed" && quality !== "partial") return null;
  const color = quality === "failed" ? "248,113,113" : "251,191,36";
  const agent = report?.agentProblems ?? 0;
  const tests = report?.testProblems ?? 0;
  return (
    <div className="mt-2 rounded-lg border px-3 py-2 text-[12px]" style={{ borderColor: `rgba(${color},0.4)`, background: `rgba(${color},0.06)`, color: `rgb(${color})` }}>
      {QUALITY_TEXT[quality]}
      {(agent > 0 || tests > 0) && (
        <span className="text-[var(--color-muted)]">
          {" "}
          Diagnosis: {agent} failed item(s) in the agent, {tests} in the tests{report?.disputedProblems ? `, ${report.disputedProblems} disputed` : ""}.
          {agent === 0 && tests > 0 ? " The agent can be correct: fix the tests in Edit & refine." : " Open the Tests tab for details."}
        </span>
      )}
    </div>
  );
}

export function ScoreBadge({ score, passRate, size = "sm" }: { score: number | null | undefined; passRate?: number | null; size?: "sm" | "lg" }) {
  if (score === null || score === undefined) return <span className="text-[11px] text-[var(--color-faint)]">not evaluated</span>;
  // The pass rate limits the color: a high score with failed tests is not green.
  const byScore = score >= 0.85 ? "#34d399" : score >= 0.6 ? "#fbbf24" : "#f87171";
  const color = passRate === 0 ? "#f87171" : passRate !== undefined && passRate !== null && passRate < 1 && byScore === "#34d399" ? "#fbbf24" : byScore;
  return (
    <span className={`inline-flex items-center gap-2 whitespace-nowrap ${size === "lg" ? "text-sm" : "text-[11px]"}`}>
      <span className="mono rounded-md px-1.5 py-0.5 font-semibold" style={{ color, background: `${color}18` }}>
        {(score * 100).toFixed(0)}
      </span>
      {passRate !== undefined && passRate !== null && <span className="text-[var(--color-muted)]">{(passRate * 100).toFixed(0)}% tests pass</span>}
    </span>
  );
}

export function Stat({ label, value, sub, accent }: { label: string; value: ReactNode; sub?: ReactNode; accent?: string }) {
  return (
    <div className="card px-4 py-3">
      <div className="label">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums" style={{ color: accent }}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-[var(--color-muted)]">{sub}</div>}
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin" />;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      {icon && <div className="text-[var(--color-faint)]">{icon}</div>}
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="max-w-sm text-xs text-[var(--color-muted)]">{children}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, right }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-5 overflow-x-auto border-b border-[var(--color-line)] px-4">
      {tabs.map((t) => (
        <button key={t.id} className="tab shrink-0 whitespace-nowrap" data-active={value === t.id} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
      <div className="ml-auto shrink-0 whitespace-nowrap">{right}</div>
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-[13px]" title={hint}>
      <span
        className="relative inline-block h-[18px] w-8 rounded-full transition-colors"
        style={{ background: checked ? "#f97316" : "#2e3340" }}
        onClick={() => onChange(!checked)}
      >
        <span className="absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all" style={{ left: checked ? 16 : 2 }} />
      </span>
      <span className="text-[var(--color-muted)]">{label}</span>
    </label>
  );
}
