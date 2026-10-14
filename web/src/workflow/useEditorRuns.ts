import { useEffect, useRef, useState, type Dispatch, type RefObject } from "react";
import { useSearchParams } from "react-router-dom";
import type { Diagnostic, JSONSchema } from "@core/types";
import { api, type WorkflowRunMode } from "../lib/api";
import { useRun } from "../lib/useRun";
import type { Action, EditorState } from "./store";
import { defaults } from "./runData";
interface Options {
  agentId: string;
  initialInput: unknown;
  schema: JSONSchema;
  current: RefObject<EditorState>;
  publishing: RefObject<boolean>;
  readOnly: boolean;
  dispatch: Dispatch<Action>;
  onNode: (id: string) => void;
  onDiagnostic: (d: Diagnostic) => void;
  onProblems: () => void;
  toast: (message: string) => void;
}
export function useEditorRuns(p: Options) {
  const [params, setParams] = useSearchParams();
  const runId = params.get("run") ?? undefined;
  const [liveId, setLiveId] = useState<string>();
  const followedId = liveId ?? runId;
  const followed = useRun(followedId);
  const run = runId === followedId && runId ? followed : undefined;
  const chatRun = followedId ? followed : undefined;
  useEffect(() => {
    if (liveId && ["completed", "failed", "cancelled"].includes(followed.status)) setLiveId(undefined);
  }, [liveId, followed.status]);
  const [testInput, setTestInput] = useState<unknown>(p.initialInput ?? defaults(p.schema) ?? {});
  const inputRef = useRef(testInput);
  const inputChanged = useRef(false);
  const [inputRevision, setInputRevision] = useState(0);
  const currentInputRevision = useRef(inputRevision);
  currentInputRevision.current = inputRevision;
  const [dryRun, setDryRun] = useState(true);
  const [testOpen, setTestOpen] = useState(false);
  const [executionsOpen, setExecutionsOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const startLock = useRef(false);
  const [outputRequest, setOutputRequest] = useState(0);
  const [modes, setModes] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(`workflow-modes:${p.agentId}`) ?? "{}");
    } catch {
      return {};
    }
  });
  const active = !!followedId && !["completed", "failed", "cancelled"].includes(followed.status);
  const selectRun = (id?: string) => {
    if (active && id && id !== followedId) {
      p.toast("Stop the active run before loading another run");
      return;
    }
    if (active && !id) setLiveId(followedId);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set("run", id);
        else next.delete("run");
        return next;
      },
      { replace: true },
    );
  };
  const updateInput = (value: unknown) => {
    inputChanged.current = true;
    inputRef.current = value;
    setTestInput(value);
    setInputRevision((n) => n + 1);
  };
  useEffect(() => {
    if (p.initialInput !== undefined) return;
    let alive = true;
    void api
      .runs({ agentId: p.agentId, origin: "editor", limit: 1 })
      .then(async (runs) => {
        if (!runs[0]) return;
        const r = await api.runRecord(runs[0].id);
        if (alive && !inputChanged.current) {
          inputRef.current = r.input;
          setTestInput(r.input);
        }
      })
      .catch((e) => p.toast(e.message));
    return () => {
      alive = false;
    };
  }, [p.agentId]);
  const waitingKey = run?.pending.map((x) => x.nodeId).join("|");
  useEffect(() => {
    const waiting = run?.pending[0];
    if (waiting) {
      p.onNode(waiting.nodeId);
      p.toast("A step waits for you");
    }
  }, [runId, waitingKey]);
  const start = async (input: unknown = inputRef.current, mode: WorkflowRunMode = "full", target?: string): Promise<string | undefined> => {
    if (p.readOnly || startLock.current || active || p.publishing.current) return;
    startLock.current = true;
    window.dispatchEvent(new Event("workflow:flush"));
    setStarting(true);
    try {
      // Let the panel's reducer update reach the snapshot after flushing its form.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const snapshot = p.current.current;
      updateInput(input);
      const result = await api.runWorkflow({
        agentId: p.agentId,
        spec: snapshot.spec,
        input,
        mode,
        target,
        pinData: snapshot.pinData,
        reuseRunId: mode === "node_only" ? runId : undefined,
        dryRun,
      });
      const next = { ...modes, [result.runId]: mode === "full" ? "Full" : mode === "node_only" ? `Step ${target} only` : `To step ${target}` };
      setModes(next);
      try {
        sessionStorage.setItem(`workflow-modes:${p.agentId}`, JSON.stringify(next));
      } catch {
        /* Storage can be unavailable. */
      }
      setLiveId(result.runId);
      selectRun(result.runId);
      setExecutionsOpen(true);
      if (target) {
        p.onNode(target);
        setOutputRequest((n) => n + 1);
      }
      return result.runId;
    } catch (e) {
      const diagnostics = (e as { data?: { diagnostics?: Diagnostic[] } }).data?.diagnostics;
      if (diagnostics) {
        p.dispatch({
          type: "inspect",
          value: {
            nodes: p.current.current.inspection?.nodes ?? {},
            valid: false,
            errors: diagnostics.filter((d) => d.severity === "error").length,
            warnings: diagnostics.filter((d) => d.severity === "warning").length,
            diagnostics,
          },
        });
        p.onProblems();
        const first = diagnostics.find((d) => d.severity === "error");
        if (first) p.onDiagnostic(first);
      }
      p.toast((e as Error).message);
    } finally {
      startLock.current = false;
      setStarting(false);
    }
  };
  const test = () => {
    if (active && followedId) void api.cancel(followedId).catch((e) => p.toast(e.message));
    else if (!p.readOnly) setTestOpen(true);
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !(e.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"],.cm-editor')) {
        e.preventDefault();
        test();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active, followedId, p.readOnly]);
  return {
    run,
    runId,
    chatRun,
    chatRunId: followedId,
    testInput,
    setTestInput,
    inputRef,
    inputChanged,
    inputRevision,
    currentInputRevision,
    updateInput,
    dryRun,
    setDryRun,
    testOpen,
    setTestOpen,
    executionsOpen,
    setExecutionsOpen,
    starting,
    outputRequest,
    modes,
    active,
    selectRun,
    start,
    test,
  };
}
