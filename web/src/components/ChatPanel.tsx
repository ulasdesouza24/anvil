import { MessageSquare, Plus, Send, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ago } from "../lib/format";
import { api, type Session } from "../lib/api";
import { Empty, Spinner } from "./ui";

function titleOf(session: Session): string {
  return session.turns.find((turn) => turn.role === "user")?.content ?? "Empty conversation";
}

function responseError(result: { status: string; error?: string }): string | null {
  if (result.error) return result.error;
  return result.status === "failed" ? "The agent failed to answer." : null;
}

export function ChatPanel({ agentId, version }: { agentId: string; version: number }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const selected = sessions.find((session) => session.id === selectedId) ?? null;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api
      .listSessions(agentId)
      .then((list) => {
        if (!active) return;
        setSessions(list);
        setSelectedId(list[0]?.id ?? null);
      })
      .catch((e: Error) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [agentId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [selected?.turns.length, sending]);

  const selectSession = async (sid: string) => {
    setSelectedId(sid);
    setError(null);
    try {
      const session = await api.getSession(sid);
      setSessions((current) => current.map((item) => (item.id === sid ? session : item)));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const send = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    setDraft("");
    try {
      const result = selectedId ? await api.sendMessage(selectedId, content) : await api.createSession(agentId, version, content);
      const session = result.session;
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      setSelectedId(session.id);
      if ("status" in result && typeof result.status === "string") {
        const resultError = "error" in result && typeof result.error === "string" ? result.error : undefined;
        setError(responseError({ status: result.status, error: resultError }));
      }
    } catch (e) {
      setDraft(content);
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const remove = async (sid: string) => {
    setError(null);
    try {
      await api.deleteSession(sid);
      const next = sessions.filter((session) => session.id !== sid);
      setSessions(next);
      if (selectedId === sid) setSelectedId(next[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-r border-[var(--color-line)] p-4">
        <div className="flex items-center gap-2">
          <div className="label">Conversations</div>
          <button
            className="btn ml-auto !px-2 !py-1 text-[11.5px]"
            onClick={() => {
              setSelectedId(null);
              setDraft("");
              setError(null);
            }}
          >
            <Plus size={13} /> New conversation
          </button>
        </div>
        <div className="mt-3 min-h-0 flex-1 space-y-1 overflow-auto">
          {loading ? (
            <div className="flex justify-center py-8 text-[var(--color-muted)]"><Spinner /></div>
          ) : sessions.length ? (
            sessions.map((session) => (
              <div
                key={session.id}
                className={`group flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                  selectedId === session.id
                    ? "border-[var(--color-line-2)] bg-[var(--color-panel-2)]"
                    : "border-transparent hover:bg-[var(--color-panel-2)]"
                }`}
              >
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => void selectSession(session.id)}>
                  <MessageSquare size={14} className="shrink-0 text-[var(--color-faint)]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px]">{titleOf(session)}</span>
                    <span className="mono block text-[10px] text-[var(--color-faint)]">v{session.version} · {ago(session.updatedAt)}</span>
                  </span>
                </button>
                <button
                  className="rounded p-1 text-[var(--color-faint)] opacity-0 hover:bg-[var(--color-line)] hover:text-[var(--color-bad)] focus:opacity-100 group-hover:opacity-100"
                  title="Delete conversation"
                  aria-label={`Delete ${titleOf(session)}`}
                  onClick={() => void remove(session.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          ) : (
            <div className="py-6 text-center text-[11.5px] text-[var(--color-faint)]">No conversations yet.</div>
          )}
        </div>
      </aside>

      <section className="flex min-h-0 flex-col">
        <div className="border-b border-[var(--color-line)] px-5 py-3">
          <div className="text-[15px] font-semibold">Conversation</div>
          <div className="mt-0.5 text-[11.5px] text-[var(--color-muted)]">
            {selected ? `Started ${ago(selected.createdAt)} · v${selected.version}` : "Start a new conversation with this agent."}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
          {!selected && !sending ? (
            <Empty icon={<MessageSquare size={22} />} title="New conversation">Send a message to begin.</Empty>
          ) : (
            <div className="mx-auto max-w-[820px] space-y-3">
              {selected?.turns.map((turn, index) => (
                <div key={`${turn.at}-${index}`} className={`flex ${turn.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`card max-w-[78%] px-4 py-3 ${
                      turn.role === "user" ? "border-[rgba(249,115,22,0.35)] bg-[rgba(249,115,22,0.08)]" : ""
                    }`}
                  >
                    <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{turn.content}</div>
                    <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-[var(--color-faint)]">
                      <span>{turn.role === "user" ? "You" : "Assistant"}</span>
                      <span>·</span>
                      <span className="mono">{ago(turn.at)}</span>
                      {turn.role === "assistant" && turn.runId && (
                        <Link className="ml-auto text-[var(--color-ember)]" to={`/runs/${turn.runId}`}>trace →</Link>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {sending && (
                <div className="flex justify-start">
                  <div className="card flex items-center gap-2 px-4 py-3 text-[12px] text-[var(--color-muted)]">
                    <Spinner /> Agent is answering…
                  </div>
                </div>
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>
        <div className="border-t border-[var(--color-line)] px-5 py-4">
          <div className="mx-auto max-w-[820px]">
            {selected?.done && <div className="mb-2 text-[11.5px] text-[var(--color-ok)]">Conversation finished</div>}
            {error && <div className="mb-2 text-[12px] text-[var(--color-bad)]">{error}</div>}
            <div className="flex items-end gap-2">
              <textarea
                className="input min-h-[42px] max-h-40 resize-y"
                rows={1}
                value={draft}
                placeholder="Write a message…"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <button className="btn btn-primary min-h-[42px]" onClick={() => void send()} disabled={sending || !draft.trim()}>
                {sending ? <Spinner /> : <Send size={14} />} Send
              </button>
            </div>
            <div className="mt-1.5 text-[10.5px] text-[var(--color-faint)]">Enter to send · Shift+Enter for a new line</div>
          </div>
        </div>
      </section>
    </div>
  );
}
