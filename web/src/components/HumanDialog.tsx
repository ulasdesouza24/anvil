import type { HumanRequest } from "@core/types";
import { Hand, UserCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Spinner } from "./ui";

/** Inline panel for a paused run: answer questions or approve/reject. */
export function HumanPanel({ runId, nodeId, request, onDone }: { runId: string; nodeId: string; request: HumanRequest; onDone?: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [payload, setPayload] = useState(typeof request.payload === "string" ? request.payload : JSON.stringify(request.payload ?? "", null, 2));
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setAnswers({});
    setPayload(typeof request.payload === "string" ? request.payload : JSON.stringify(request.payload ?? "", null, 2));
  }, [request]);

  const send = async (value: unknown) => {
    setBusy(true);
    try {
      await api.resume(runId, nodeId, value);
      onDone?.();
    } finally {
      setBusy(false);
    }
  };

  const parsedPayload = () => {
    if (typeof request.payload === "string") return payload;
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  };

  return (
    <div className="fade-in rounded-xl border border-[rgba(251,113,133,0.45)] bg-[rgba(251,113,133,0.06)] p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-[#fda4af]">
        {request.kind === "approval" ? <UserCheck size={16} /> : <Hand size={16} />}
        {request.title}
        <span className="mono ml-auto text-[10.5px] font-normal text-[var(--color-faint)]">node {nodeId}</span>
      </div>
      {request.message && <p className="mt-1 text-[13px] text-[var(--color-muted)]">{request.message}</p>}

      {request.kind === "input" ? (
        <div className="mt-3 space-y-3">
          {(request.questions ?? []).map((q) => (
            <div key={q}>
              <div className="mb-1 text-[13px]">{q}</div>
              <textarea className="input min-h-[52px] resize-y" value={answers[q] ?? ""} onChange={(e) => setAnswers({ ...answers, [q]: e.target.value })} />
            </div>
          ))}
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={() => send({ answers })}>
              {busy && <Spinner />} Continue
            </button>
            <button className="btn" disabled={busy} onClick={() => send({ answers: {}, skipped: true })}>
              Skip — use your assumptions
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div>
            <div className="label mb-1">Review (editable)</div>
            <textarea className="input mono min-h-[140px] resize-y text-[12px] leading-relaxed" value={payload} onChange={(e) => setPayload(e.target.value)} />
          </div>
          <input className="input" placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={() => send({ approved: true, comment, payload: parsedPayload() })}>
              {busy && <Spinner />} Approve
            </button>
            <button className="btn btn-danger" disabled={busy} onClick={() => send({ approved: false, comment })}>
              Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
