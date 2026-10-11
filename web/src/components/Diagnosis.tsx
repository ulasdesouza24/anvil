import { BLAME_TEXT, isTestBlame } from "@core/quality";
import type { EvaluationReport, FailureDiagnosis, TestResult } from "@core/types";

/** The diagnosis of one failed item of a test result, when the evaluation made one. */
export function findBlame(r: TestResult | undefined, kind: "criterion" | "check", item: string): FailureDiagnosis | undefined {
  return r?.diagnosis?.find((d) => d.kind === kind && d.item === item);
}

const colorOf = (d: FailureDiagnosis) =>
  d.disputed ? "var(--color-s2)" : d.blame === "agent" ? "var(--color-bad)" : isTestBlame(d.blame) ? "var(--color-warn)" : "var(--color-faint)";

/** A small label: who is wrong for a failed item, how sure the diagnosis is, and what to do. */
export function BlameChip({ d }: { d: FailureDiagnosis }) {
  const t = BLAME_TEXT[d.blame];
  const pct = `${Math.round(d.confidence * 100)}%`;
  return (
    <div className="mt-0.5 text-[11px]">
      <span className="rounded border px-1.5 py-px" style={{ color: colorOf(d), borderColor: colorOf(d) }} title={`${t.meaning} ${t.action}`}>
        {d.disputed ? "Disputed" : t.label} · {pct}
      </span>
      {d.disputed ? (
        <span className="ml-1.5 text-[var(--color-muted)]">
          Jev: {t.label}. Second opinion: {d.secondOpinion ? BLAME_TEXT[d.secondOpinion].label : "none"}. Decide yourself: compare the output with the requirement.
        </span>
      ) : (
        <span className="ml-1.5 text-[var(--color-faint)]">{t.meaning}</span>
      )}
      {d.reason && <div className="mt-0.5 text-[var(--color-faint)]">Reason: {d.reason}</div>}
    </div>
  );
}

/** One box above the tests: how many failures come from the agent and from the tests, and what to do. */
export function DiagnosisSummary({ report }: { report: EvaluationReport | undefined }) {
  const agent = report?.agentProblems ?? 0;
  const tests = report?.testProblems ?? 0;
  const disputed = report?.disputedProblems ?? 0;
  if (!agent && !tests && !disputed) return null;
  return (
    <div className="mt-3 rounded-lg border border-[var(--color-line-2)] p-3 text-[12px]">
      <div className="font-medium">
        Failed items: <span style={{ color: "var(--color-bad)" }}>{agent} in the agent</span> · <span style={{ color: "var(--color-warn)" }}>{tests} in the tests</span>
        {disputed > 0 && (
          <>
            {" "}
            · <span style={{ color: "var(--color-s2)" }}>{disputed} disputed</span>
          </>
        )}
      </div>
      <ul className="mt-1 list-disc pl-4 text-[var(--color-muted)]">
        {agent > 0 && <li>Agent errors: {BLAME_TEXT.agent.action}</li>}
        {tests > 0 && <li>Test errors: the agent can be correct. Change or remove these tests in Edit &amp; refine, then run the tests again.</li>}
        {disputed > 0 && <li>Disputed items: the two opinions do not agree. Evolve does not change them. Decide yourself, then fix the agent or the test in Edit &amp; refine.</li>}
      </ul>
    </div>
  );
}
