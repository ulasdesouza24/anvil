import type { AgentSpec } from "@core/types";
import { Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "../components/ui";
import { api } from "../lib/api";
import { money } from "../lib/format";
import { useRun } from "../lib/useRun";
import { explainWorkflow, placeNew } from "./diff";

const EXAMPLES = ["Add an approval before each step that sends", "Add error handling to the HTTP steps", "Explain what this workflow does"];
const EXPLAIN = EXAMPLES[2];

export interface Proposal {
  spec: AgentSpec;
  summary: string;
  instruction: string;
}

interface Props {
  agentId: string;
  spec: AgentSpec;
  selection: string[];
  titles: Record<string, string>;
  /** A prepared instruction (for example "Fix with AI" of a failed step). The panel shows it when the value changes. */
  prefill?: { text: string; at: number };
  onProposal: (p: Proposal) => void;
  onClose: () => void;
}

/**
 * The AI assistant of the editor (docs/WORKFLOW_EDITOR.md): a run of anvil-assistant changes the draft from an
 * instruction. The result comes back as a proposal: the editor shows it as a diff, and the person accepts or rejects it.
 */
export function AssistPanel({ agentId, spec, selection, titles, prefill, onProposal, onClose }: Props) {
  const [text, setText] = useState("");
  const [runId, setRunId] = useState<string>();
  const [error, setError] = useState("");
  const [explained, setExplained] = useState("");
  const [history, setHistory] = useState<{ text: string; result: string }[]>([]);
  const delivered = useRef<string>(undefined);
  const sent = useRef("");
  const run = useRun(runId);
  const active = !!runId && (run.status === "running" || run.status === "connecting" || run.status === "queued");

  useEffect(() => {
    if (prefill) setText(prefill.text);
  }, [prefill]);

  useEffect(() => {
    if (!runId || delivered.current === runId) return;
    if (run.status === "completed") {
      delivered.current = runId;
      const out = run.output as { spec?: AgentSpec; summary?: string } | null;
      if (!out?.spec) {
        setError("The assistant gave no workflow.");
        setHistory((h) => [{ text: sent.current, result: "no result" }, ...h]);
        return;
      }
      const proposal: Proposal = { spec: placeNew({ ...out.spec, id: spec.id, version: spec.version }), summary: out.summary ?? "", instruction: sent.current };
      setHistory((h) => [{ text: sent.current, result: proposal.summary || "proposal ready" }, ...h]);
      onProposal(proposal);
    } else if (run.status === "failed" || run.status === "cancelled") {
      delivered.current = runId;
      const msg = run.error ?? "The assistant run failed.";
      setError(/locked/i.test(msg) ? `${msg} Unlock the step or change the instruction.` : msg);
      setHistory((h) => [{ text: sent.current, result: "failed" }, ...h]);
    }
  }, [run.status, run.output, run.error, runId]);

  const send = async (instruction: string) => {
    const t = instruction.trim();
    if (!t || active) return;
    setError("");
    setExplained("");
    if (t === EXPLAIN) {
      // The summary comes from the steps in the browser: no AI call.
      setExplained(explainWorkflow(spec, titles));
      return;
    }
    sent.current = t;
    try {
      const r = await api.assist(
        agentId,
        spec,
        t,
        selection.filter((id) => spec.nodes.some((n) => n.id === id)),
      );
      setRunId(r.runId);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const recent = run.events.filter((e) => e.type === "llm" || (e.type === "log" && e.level !== "info") || e.type === "node.started").slice(-6);

  return (
    <aside className="wf-side" aria-label="AI assistant">
      <div className="wf-row">
        <Sparkles size={15} className="text-[var(--color-s2)]" />
        <h3 className="!m-0">AI assistant</h3>
        <button className="btn btn-ghost ml-auto" title="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <p className="wf-hint !mt-0">Describe a change. The assistant changes the draft and shows the change on the canvas. You accept or reject it. Locked steps do not change.</p>
      {selection.length > 0 && <div className="wf-chip wf-chip-warn w-fit">Applies to: {selection.join(", ")}</div>}
      <textarea
        className="input min-h-[96px]"
        placeholder="Describe the change"
        value={text}
        disabled={active}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(text);
        }}
      />
      <div className="wf-row">
        <button className="btn btn-primary" disabled={active || !text.trim()} onClick={() => void send(text)}>
          {active ? <Spinner /> : <Sparkles size={14} />} {active ? "Working…" : "Send"}
        </button>
        <span className="wf-hint !mt-0">Ctrl/Cmd+Enter</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map((x) => (
          <button key={x} className="btn btn-ghost text-[11px]" disabled={active} onClick={() => (x === EXPLAIN ? void send(x) : setText(x))}>
            {x}
          </button>
        ))}
      </div>
      {explained && <pre className="card whitespace-pre-wrap p-3 text-[12px] leading-relaxed">{explained}</pre>}
      {runId && (
        <div className="card p-3 text-[11.5px]">
          <div className="wf-row">
            <span className="text-[var(--color-muted)]">Run</span>
            <span className="mono">{run.status}</span>
            <span className="mono ml-auto">{money(run.usage.costUsd)}</span>
          </div>
          {active && (
            <ul className="mt-2 space-y-1 text-[var(--color-muted)]">
              {recent.map((e, i) => (
                <li key={i} className="truncate">
                  {e.type === "llm" ? `model call: ${e.purpose}` : e.type === "node.started" ? `step: ${e.nodeId}` : e.type === "log" ? e.message : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <p className="wf-error">{error}</p>}
      {history.length > 0 && (
        <div className="space-y-1.5">
          <div className="wf-section-title">This session</div>
          {history.map((h, i) => (
            <button key={i} className="wf-list-row w-full text-left" onClick={() => setText(h.text)} title="Use this instruction again">
              <span className="min-w-0 flex-1 truncate">{h.text}</span>
              <span className="wf-hint !mt-0 shrink-0">{h.result.slice(0, 40)}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
