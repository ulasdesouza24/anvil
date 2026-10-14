import { REPLY_FIELDS, type AgentSpec } from "@core/types";
import { useEffect, useRef, useState } from "react";
import { Send, MessageSquare } from "lucide-react";
import { SchemaForm } from "../components/SchemaForm";
import type { RunState } from "../lib/useRun";
interface Turn {
  role: "user" | "assistant";
  content: string;
  runId?: string;
}
export function TestPanel({
  spec,
  input,
  onInput,
  dryRun,
  onDryRun,
  onStart,
  run,
  runId,
  onSelect,
  onClose,
  visible,
  active,
}: {
  spec: AgentSpec;
  input: Record<string, unknown>;
  onInput: (v: Record<string, unknown>) => void;
  dryRun: boolean;
  onDryRun: (v: boolean) => void;
  onStart: (input: Record<string, unknown>) => Promise<string | undefined>;
  run?: RunState;
  runId?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  visible: boolean;
  active: boolean;
}) {
  const conversation = spec.meta.interaction === "conversation" || !!spec.inputSchema.properties?.messages;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const pending = useRef<string | undefined>(undefined);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [turns]);
  useEffect(() => {
    if (!pending.current || runId !== pending.current || !run || !["completed", "failed", "cancelled"].includes(run.status)) return;
    const output = run.output;
    const field = output && typeof output === "object" ? REPLY_FIELDS.find((k) => Object.hasOwn(output, k)) : undefined;
    const reply = field ? (output as Record<string, unknown>)[field] : output;
    setTurns((t) => [
      ...t,
      {
        role: "assistant",
        content: run.status === "completed" ? (typeof reply === "string" ? reply : JSON.stringify(reply ?? null, null, 2)) : (run.error ?? `Run ${run.status}`),
        runId,
      },
    ]);
    pending.current = undefined;
  }, [runId, run?.status, run?.output]);
  const send = async () => {
    if (!message.trim() || sending || active) return;
    const next: Turn[] = [...turns, { role: "user", content: message.trim() }];
    setSending(true);
    const id = await onStart({ ...input, messages: next.map(({ role, content }) => ({ role, content })) });
    if (id) {
      pending.current = id;
      setTurns(next.map((t, i) => (i === next.length - 1 ? { ...t, runId: id } : t)));
      setMessage("");
    }
    setSending(false);
  };
  if (!visible) return null;
  return (
    <aside className={conversation ? "wf-chat card" : "wf-test card"} role="dialog" aria-label={conversation ? "Test conversation" : "Test workflow"}>
      <div className="wf-row">
        <MessageSquare size={16} />
        <h3>{conversation ? "Test conversation" : "Test workflow"}</h3>
        <button className="btn ml-auto" onClick={onClose}>
          Close
        </button>
      </div>
      <label className="wf-field">
        <input type="checkbox" checked={dryRun} onChange={(e) => onDryRun(e.target.checked)} /> Dry run
      </label>
      <p className="wf-hint">Actions with a side effect give a preview and do not go out</p>
      {conversation ? (
        <>
          <details>
            <summary>Other input fields</summary>
            <SchemaForm
              schema={{ ...spec.inputSchema, properties: Object.fromEntries(Object.entries(spec.inputSchema.properties ?? {}).filter(([k]) => k !== "messages")) }}
              value={input}
              onChange={onInput}
            />
          </details>
          <button
            className="btn my-3"
            disabled={active || sending}
            onClick={() => {
              setTurns([]);
              pending.current = undefined;
              setMessage("");
            }}
          >
            Reset chat
          </button>
          <div className="wf-chat-turns">
            {turns.map((t, i) => (
              <div key={i} className={`flex my-3 ${t.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`card max-w-[85%] px-4 py-3 ${t.role === "user" ? "border-[rgba(249,115,22,0.35)] bg-[rgba(249,115,22,0.08)]" : ""}`}>
                  <div className="whitespace-pre-wrap break-words">{t.content}</div>
                  <small>
                    {t.role === "user" ? "You" : "Assistant"}{" "}
                    {t.runId && (
                      <a
                        href={`?run=${t.runId}`}
                        className="text-[var(--color-ember)]"
                        onClick={(e) => {
                          e.preventDefault();
                          onSelect(t.runId!);
                        }}
                      >
                        View run
                      </a>
                    )}
                  </small>
                </div>
              </div>
            ))}
            <div ref={end} />
          </div>
          <div className="wf-row">
            <textarea
              className="input"
              aria-label="Chat message"
              placeholder="Write a message…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="btn btn-primary" disabled={active || sending || !message.trim()} onClick={() => void send()}>
              <Send size={14} />
              Send
            </button>
          </div>
        </>
      ) : (
        <>
          <SchemaForm schema={spec.inputSchema} value={input} onChange={onInput} />
          <button
            className="btn btn-primary mt-4"
            disabled={active || sending}
            onClick={async () => {
              setSending(true);
              const id = await onStart(input);
              setSending(false);
              if (id) onClose();
            }}
          >
            Start test
          </button>
        </>
      )}
    </aside>
  );
}
