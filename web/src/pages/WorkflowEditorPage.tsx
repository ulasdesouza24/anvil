import type { AgentSpec, Diagnostic, Edge, StoredAgent } from "@core/types";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { EditorToolbar } from "../workflow/EditorToolbar";
import { api, type NodeClassInfo, type SaveConflict, type WorkflowDraft, type PinData, type TriggerView } from "../lib/api";
import { Canvas } from "../workflow/Canvas";
import { Palette } from "../workflow/Palette";
import { NodePanel, type PanelTab } from "../workflow/NodePanel";
import { SpecSettings } from "../workflow/SpecSettings";
import { autoLayout } from "../workflow/layout";
import { initialState, reducer, removeNodes, renameNode, updateNode } from "../workflow/store";
import "../workflow/editor.css";
import { useEditorRuns } from "../workflow/useEditorRuns";
import { HumanPanel } from "../components/HumanDialog";
import { TestPanel } from "../workflow/TestPanel";
import { Executions } from "../workflow/Executions";
import { defaults, stepData } from "../workflow/runData";
import { TriggerPanel } from "../workflow/TriggerPanel";

import { EditorDialogs } from "../workflow/EditorDialogs";
import { History, Sparkles } from "lucide-react";
import { AssistPanel, type Proposal } from "../workflow/AssistPanel";
import { DiffCanvas } from "../workflow/DiffCanvas";
import { VersionsPanel } from "../workflow/VersionsPanel";
import { changedParts, diffSummary, diffView, placeNew } from "../workflow/diff";
import { JsonBlock } from "../components/ui";
import type { MergeResult } from "../lib/api";

/** A change that the person reviews on the canvas before it goes into the draft (an AI proposal, a merge, a version compare). */
interface Review {
  title: string;
  base: AgentSpec;
  next: AgentSpec;
  summary?: string;
  conflicts?: MergeResult["conflicts"];
  accept?: { label: string; run: () => void };
}
interface Loaded {
  agent: StoredAgent;
  classes: NodeClassInfo[];
  draft?: WorkflowDraft;
  spec: AgentSpec;
}
export function WorkflowEditorPage() {
  const { id } = useParams();
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoaded(undefined);
    setError("");
    void (async () => {
      const [agent, registry, custom] = await Promise.all([api.agent(id!), api.registry(), api.classes()]);
      const classes = registry.classes.map((c) => ({ ...c, sideEffects: custom.find((x) => x.type === c.type)?.sideEffects }));
      let draft: WorkflowDraft | undefined;
      try {
        draft = await api.draft(id!);
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e;
      }
      const spec = agent.versions.find((v) => v.version === agent.currentVersion)?.spec;
      if (!spec) throw Error("Current version not found");
      if (active) setLoaded({ agent, classes, draft, spec });
    })().catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [id]);
  return error ? <div className="p-6 wf-error">{error}</div> : loaded ? <Editor key={id} loaded={loaded} /> : <div className="p-6">Loading workflow…</div>;
}
export interface EditorSlots {
  toolbar?: ReactNode;
  bottomPanel?: ReactNode;
  rightTabs?: PanelTab[];
}
export function Editor({ loaded, toolbar, bottomPanel, rightTabs }: { loaded: Loaded } & EditorSlots) {
  const { agent, classes } = loaded;
  const [state, dispatch] = useReducer(reducer, loaded, (value) => initialState(autoLayout(value.draft?.spec ?? value.spec, true), value.draft?.pinData));
  const [base, setBase] = useState(loaded.draft?.baseVersion ?? agent.currentVersion);
  const [draftTime, setDraftTime] = useState(loaded.draft?.updatedAt);
  const [status, setStatus] = useState(loaded.draft ? "Saved draft" : "No changes");
  const [toast, setToast] = useState("");
  const [panel, setPanel] = useState<string>();
  const [settings, setSettings] = useState(false);
  const [palette, setPalette] = useState(false);
  const [insertEdge, setInsertEdge] = useState<Edge>();
  const [problems, setProblems] = useState(false);
  const [saveDialog, setSaveDialog] = useState(false);
  const [note, setNote] = useState("");
  const [conflict, setConflict] = useState<SaveConflict>();
  const [busy, setBusy] = useState(false);
  const [focusPath, setFocusPath] = useState<string>();
  const [secrets, setSecrets] = useState<string[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [triggerPanel, setTriggerPanel] = useState<string>();
  const [triggerMenu, setTriggerMenu] = useState(false);
  const [runtime, setRuntime] = useState<TriggerView[]>([]);
  const [savedSpec, setSavedSpec] = useState(loaded.spec);
  const [pinEditor, setPinEditor] = useState<string>();
  const [side, setSide] = useState<"assist" | "versions" | undefined>();
  const [review, setReview] = useState<Review>();
  const [reviewJson, setReviewJson] = useState(false);
  const [prefill, setPrefill] = useState<{ text: string; at: number }>();
  const [fresh, setFresh] = useState<StoredAgent>(agent);
  const [dismissedLatest, setDismissedLatest] = useState(0);
  const refreshTriggers = () => {
    void api
      .triggers(agent.id)
      .then(setRuntime)
      .catch((e) => setToast(e.message));
  };
  useEffect(refreshTriggers, [agent.id, base]);
  const readOnly = !!agent.system;
  const addRef = useRef<((c: NodeClassInfo, edge?: Edge) => void) | null>(null);
  const current = useRef(state);
  const sequence = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const publishing = useRef(false);
  const alive = useRef(true);
  const pendingForm = useRef(false);
  current.current = state;
  const savedInputRevision = useRef(0);
  const showDiagnostic = (d: Diagnostic) => {
    const id = d.nodeId ?? state.spec.nodes[Number(d.path?.split("/")[2])]?.id;
    if (id) {
      setPanel(id);
      setSettings(false);
      dispatch({ type: "select", ids: [id] });
      setFocusPath(d.path);
    }
  };
  const {
    run,
    runId,
    chatRun,
    chatRunId,
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
  } = useEditorRuns({
    agentId: agent.id,
    initialInput: loaded.draft?.testInput,
    schema: state.spec.inputSchema,
    current,
    publishing,
    readOnly,
    dispatch,
    onNode: (id) => {
      setPanel(id);
      setSettings(false);
      setTriggerPanel(undefined);
      dispatch({ type: "select", ids: [id] });
    },
    onDiagnostic: showDiagnostic,
    onProblems: () => setProblems(true),
    toast: setToast,
  });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    void api
      .secrets()
      .then((r) => setSecrets(r.secrets.map((s) => s.name)))
      .catch((e) => setToast(e.message));
    void api
      .agents()
      .then(setAgents)
      .catch((e) => setToast(e.message));
  }, []);
  // A newer version from elsewhere (a refine, an evolve, another tab): the editor offers a merge.
  useEffect(() => {
    const poll = () =>
      void api
        .agent(agent.id)
        .then((a) => alive.current && setFresh(a))
        .catch(() => undefined);
    const t = setInterval(poll, 15_000);
    return () => clearInterval(t);
  }, [agent.id]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !readOnly) {
        e.preventDefault();
        openSide("assist");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [readOnly]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const seq = ++sequence.current;
    const t = setTimeout(() => {
      api
        .inspect(state.spec)
        .then((value) => {
          if (seq === sequence.current && alive.current) dispatch({ type: "inspect", value });
        })
        .catch((e) => {
          if (seq === sequence.current) setToast(`Inspection failed: ${e.message}`);
        });
    }, 300);
    return () => {
      clearTimeout(t);
      sequence.current++;
    };
  }, [state.spec]);
  useEffect(() => {
    if (readOnly || (state.revision === state.savedRevision && inputRevision === savedInputRevision.current) || publishing.current) return;
    setStatus("Unsaved");
    saveTimer.current = setTimeout(() => {
      const snapshot = state;
      const inputSnapshot = inputRef.current;
      const inputVersion = inputRevision;
      queue.current = queue.current
        .catch(() => undefined)
        .then(async () => {
          if (publishing.current || !alive.current) return;
          setStatus("Saving…");
          try {
            const result = await api.saveDraft(agent.id, { spec: snapshot.spec, baseVersion: base, pinData: snapshot.pinData, testInput: inputSnapshot });
            if (alive.current) {
              savedInputRevision.current = inputVersion;
              dispatch({ type: "saved", revision: snapshot.revision });
              setDraftTime(result.updatedAt);
              setStatus(current.current.revision === snapshot.revision && currentInputRevision.current === inputVersion ? "Saved draft" : "Unsaved");
            }
          } catch (e) {
            if (alive.current) setStatus((e as Error).message);
          }
        });
    }, 1000);
    return () => clearTimeout(saveTimer.current);
  }, [state.revision, state.savedRevision, base, readOnly, inputRevision]);
  useEffect(() => {
    const pending = (e: Event) => {
      pendingForm.current = (e as CustomEvent<boolean>).detail;
      if (pendingForm.current) setStatus("Unsaved");
    };
    window.addEventListener("workflow:pending", pending);
    const handler = (e: BeforeUnloadEvent) => {
      if (
        pendingForm.current ||
        (inputChanged.current && savedInputRevision.current !== currentInputRevision.current) ||
        current.current.revision !== current.current.savedRevision
      ) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
      window.removeEventListener("workflow:pending", pending);
    };
  }, []);
  const edit = (spec: AgentSpec, group?: string) => {
    if (!readOnly && !busy) dispatch({ type: "edit", spec, group });
  };
  const rename = (id: string) => {
    const next = prompt("Step id", id);
    if (next === null) return;
    try {
      const spec = renameNode(current.current.spec, id, next);
      const pinData = { ...current.current.pinData };
      if (pinData[id]) {
        pinData[next] = pinData[id];
        delete pinData[id];
      }
      dispatch({ type: "edit", spec, pinData });
      dispatch({ type: "select", ids: [next] });
      setPanel(next);
    } catch (e) {
      setToast((e as Error).message);
    }
  };
  const openPalette = (edge?: Edge) => {
    setInsertEdge(edge);
    setPalette(true);
  };
  const publish = async (force = false) => {
    if (readOnly || publishing.current) return;
    window.dispatchEvent(new Event("workflow:flush"));
    publishing.current = true;
    setBusy(true);
    clearTimeout(saveTimer.current);
    try {
      await queue.current;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const snapshot = current.current;
      const result = await api.publishDraft(agent.id, snapshot.spec, base, note, force);
      const spec = { ...snapshot.spec, version: result.version };
      setBase(result.version);
      setSavedSpec(spec);
      dispatch({ type: "reset", spec, pinData: snapshot.pinData });
      setDraftTime(undefined);
      setStatus("No changes");
      setSaveDialog(false);
      setConflict(undefined);
      setToast(`Saved as v${result.version}`);
      void api
        .agent(agent.id)
        .then((a) => alive.current && setFresh(a))
        .catch(() => undefined);
      savedInputRevision.current = currentInputRevision.current;
      if (Object.keys(snapshot.pinData).length || inputChanged.current || loaded.draft?.testInput !== undefined) {
        try {
          const draft = await api.saveDraft(agent.id, { spec, baseVersion: result.version, pinData: snapshot.pinData, testInput: inputRef.current });
          setDraftTime(draft.updatedAt);
          setStatus("Saved draft");
        } catch (e) {
          setStatus(`Version saved. Draft data not saved: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      const data = (e as { data?: SaveConflict & { diagnostics?: Diagnostic[] } }).data;
      if (data?.conflict) setConflict(data);
      else if (data?.diagnostics) {
        dispatch({
          type: "inspect",
          value: {
            nodes: state.inspection?.nodes ?? {},
            valid: false,
            errors: data.diagnostics.filter((d) => d.severity === "error").length,
            warnings: data.diagnostics.filter((d) => d.severity === "warning").length,
            diagnostics: data.diagnostics,
          },
        });
        setProblems(true);
        const first = data.diagnostics.find((d) => d.severity === "error");
        if (first) showDiagnostic(first);
      }
      setToast((e as Error).message);
    } finally {
      publishing.current = false;
      setBusy(false);
    }
  };
  const discard = async () => {
    if (!confirm("Discard the draft and load the current version?")) return;
    publishing.current = true;
    setBusy(true);
    clearTimeout(saveTimer.current);
    try {
      await queue.current;
      await api.discardDraft(agent.id);
      const fresh = await api.agent(agent.id);
      const spec = fresh.versions.find((v) => v.version === fresh.currentVersion)!.spec;
      dispatch({ type: "reset", spec: autoLayout(spec, true) });
      setBase(fresh.currentVersion);
      setSavedSpec(spec);
      inputRef.current = defaults(spec.inputSchema) ?? {};
      setTestInput(inputRef.current);
      savedInputRevision.current = inputRevision;
      setDraftTime(undefined);
      setPanel(undefined);
      setStatus("No changes");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      publishing.current = false;
      setBusy(false);
    }
  };
  const data: PinData = { ...state.pinData, ...stepData(run) };
  const pin = (id: string, value: unknown, remove = false) => {
    if (readOnly) return;
    const pinData = { ...current.current.pinData };
    if (remove) delete pinData[id];
    else pinData[id] = { output: value };
    dispatch({ type: "edit", spec: current.current.spec, pinData });
  };
  const stepAction = (id: string, action: "node_only" | "to_node" | "pin" | "unpin" | "edit_pin") => {
    if (action === "node_only" || action === "to_node") void start(run?.record?.input ?? inputRef.current, action, id);
    else if (action === "unpin") pin(id, undefined, true);
    else if (action === "edit_pin") setPinEditor(id);
    else if (data[id]) pin(id, data[id].output);
    else setToast("Run this step first");
  };
  const openSide = (which: "assist" | "versions") => {
    setSide((cur) => (cur === which ? undefined : which));
    setPanel(undefined);
    setSettings(false);
    setTriggerPanel(undefined);
  };
  const latest = Math.max(...fresh.versions.map((v) => v.version));
  const newer = latest > base && latest !== dismissedLatest && !publishing.current;
  const reviewMerge = async () => {
    const theirs = fresh.versions.find((v) => v.version === latest)?.spec;
    const baseSpec = fresh.versions.find((v) => v.version === base)?.spec;
    if (!theirs) return;
    try {
      const m: MergeResult = baseSpec ? await api.mergeSpecs(baseSpec, current.current.spec, theirs) : { spec: theirs, conflicts: [] };
      const merged = placeNew({ ...m.spec, id: agent.id });
      setReview({
        title: `Merge v${latest} into the draft`,
        base: current.current.spec,
        next: merged,
        summary: m.conflicts.length ? "Both sides changed the listed items. The merge keeps the draft for them." : "No conflict.",
        conflicts: m.conflicts,
        accept: {
          label: "Use merged",
          run: () => {
            edit(merged);
            setBase(latest);
            setToast(`The draft now starts from v${latest}`);
          },
        },
      });
    } catch (e) {
      setToast((e as Error).message);
    }
  };
  const onProposal = (p: Proposal) =>
    setReview({
      title: "AI proposal",
      base: current.current.spec,
      next: p.spec,
      summary: p.summary || p.instruction,
      accept: { label: "Accept", run: () => edit(p.spec) },
    });
  const loadVersion = (spec: AgentSpec, version: number) => {
    if (state.revision !== 0 && !confirm(`Load v${version} into the draft? The changes of the draft go away (Undo brings them back).`)) return;
    edit(autoLayout({ ...spec, id: agent.id }, true));
    setBase(latest);
    setToast(`v${version} is in the draft. A save makes v${latest + 1}.`);
  };
  const titles = Object.fromEntries(classes.map((c) => [c.type, c.title]));
  const reviewView = review ? diffView(review.base, review.next) : undefined;
  const trigger = state.spec.triggers?.find((t) => t.id === triggerPanel);
  const node = state.spec.nodes.find((n) => n.id === panel);
  const errors = state.inspection?.errors ?? 0;
  return (
    <div className="wf-editor" aria-busy={busy}>
      <EditorToolbar
        agentId={agent.id}
        state={state}
        baseline={savedSpec}
        base={base}
        status={status}
        readOnly={readOnly}
        busy={busy}
        starting={starting}
        active={active}
        runId={runId}
        toolbar={
          <>
            {!readOnly && (
              <button className={`btn ${side === "assist" ? "btn-primary" : ""}`} title="AI assistant (Ctrl/Cmd+K)" onClick={() => openSide("assist")}>
                <Sparkles size={15} /> AI
              </button>
            )}
            <button className="btn" title="Versions" onClick={() => openSide("versions")}>
              <History size={15} />
            </button>
            {toolbar}
          </>
        }
        dispatch={dispatch}
        onEdit={edit}
        onProblems={() => setProblems(!problems)}
        onPalette={() => openPalette()}
        onSettings={() => {
          setSettings(!settings);
          setTriggerPanel(undefined);
          setPanel(undefined);
        }}
        onTest={test}
        onClearRun={() => selectRun()}
        onSave={() => setSaveDialog(true)}
      />
      {readOnly && <div className="wf-banner">System agents are read-only. Anvil manages these workflows.</div>}
      {newer && !readOnly && (
        <div className="wf-banner wf-row">
          v{latest} came after your base v{base}. Merge it now?
          <button className="btn btn-ghost" onClick={() => void reviewMerge()}>
            Review merge
          </button>
          <button className="btn btn-ghost" onClick={() => setDismissedLatest(latest)}>
            Later
          </button>
        </div>
      )}
      {draftTime && (
        <div className="wf-banner">
          Draft from {new Date(draftTime).toLocaleString()}
          {!readOnly && (
            <button className="btn btn-ghost" disabled={busy} onClick={() => void discard()}>
              Discard draft
            </button>
          )}
        </div>
      )}
      <div className="wf-workspace" style={busy ? { pointerEvents: "none" } : undefined}>
        {review && reviewView && (
          <>
            <DiffCanvas base={review.base} next={review.next} ports={Object.fromEntries(Object.entries(state.inspection?.nodes ?? {}).map(([id, n]) => [id, n.ports]))} />
            <div className="wf-review-bar card" role="region" aria-label={review.title}>
              <div className="wf-review-text">
                <div className="font-semibold">{review.title}</div>
                <div className="wf-hint !mt-0 truncate" title={review.summary}>
                  {diffSummary(reviewView.diff)}
                  {review.summary ? ` · ${review.summary}` : ""}
                </div>
                {!!review.conflicts?.length && (
                  <div className="wf-hint !mt-0 text-[var(--color-warn)]">
                    Conflicts: {review.conflicts.map((c) => `${c.kind === "node" ? "step" : "field"} ${c.id}`).join(", ")}
                  </div>
                )}
              </div>
              <button className="btn btn-ghost" onClick={() => setReviewJson(true)}>
                Show JSON diff
              </button>
              {review.accept && !readOnly && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    review.accept!.run();
                    setReview(undefined);
                  }}
                >
                  {review.accept.label}
                </button>
              )}
              <button className="btn" onClick={() => setReview(undefined)}>
                {review.accept ? "Reject" : "Close"}
              </button>
            </div>
          </>
        )}
        <div className="contents" style={review ? { display: "none" } : undefined}>
          <Canvas
            state={state}
            run={run}
            onTest={test}
            onAddTrigger={() => setTriggerMenu(true)}
            onTrigger={(id) => {
              setTriggerPanel(id);
              setPanel(undefined);
              setSettings(false);
            }}
            onStepAction={stepAction}
            dispatch={dispatch}
            readOnly={readOnly || busy || !!review}
            classes={classes}
            onPalette={openPalette}
            onOpen={(id) => {
              setPanel(id);
              setSettings(false);
              setTriggerPanel(undefined);
            }}
            onRename={rename}
            onSave={() => {
              if (!errors) setSaveDialog(true);
              else setToast("Fix compiler errors before saving");
            }}
            onClose={() => {
              setPanel(undefined);
              setSettings(false);
              setPalette(false);
              setTriggerPanel(undefined);
              setTestOpen(false);
            }}
            toast={setToast}
            addRef={addRef}
          />
        </div>
        {palette && !readOnly && (
          <Palette
            classes={classes}
            onClose={() => setPalette(false)}
            onAdd={(c) => {
              addRef.current?.(c, insertEdge);
              setPalette(false);
            }}
          />
        )}
        {side === "assist" && !readOnly && (
          <div className="contents" style={trigger || settings || node ? { display: "none" } : undefined}>
            <AssistPanel
              agentId={agent.id}
              spec={state.spec}
              selection={state.selection}
              titles={titles}
              prefill={prefill}
              onProposal={onProposal}
              onClose={() => setSide(undefined)}
            />
          </div>
        )}
        {side === "versions" && !trigger && !settings && !node && (
          <VersionsPanel
            agent={fresh}
            base={base}
            readOnly={readOnly}
            onCompare={(spec, label) => setReview({ title: label, base: autoLayout({ ...spec }, true), next: state.spec })}
            onLoad={loadVersion}
            onClose={() => setSide(undefined)}
          />
        )}
        {trigger ? (
          <TriggerPanel
            key={trigger.id}
            trigger={trigger}
            agentId={agent.id}
            saved={!!savedSpec.triggers?.some((t) => t.id === trigger.id)}
            agents={agents}
            diagnostics={(state.inspection?.diagnostics ?? []).filter(
              (d) => d.code.includes("TRIGGER") && (!d.path || d.path.startsWith(`/triggers/${state.spec.triggers?.findIndex((t) => t.id === trigger.id)}`)),
            )}
            onChange={(t) => edit({ ...state.spec, triggers: state.spec.triggers?.map((x) => (x.id === t.id ? t : x)) }, "trigger:" + t.id)}
            onDelete={() => {
              edit({ ...state.spec, triggers: state.spec.triggers?.filter((t) => t.id !== trigger.id) });
              setTriggerPanel(undefined);
            }}
            onClose={() => setTriggerPanel(undefined)}
            onInput={updateInput}
            onPin={(v) => pin(state.spec.nodes.find((n) => n.type === "input")?.id ?? "input", v)}
            readOnly={readOnly}
            runtime={runtime.find((v) => v.trigger.id === trigger.id)}
            onRuntime={refreshTriggers}
          />
        ) : settings ? (
          <SpecSettings spec={state.spec} onChange={(s) => edit(s, "settings")} onClose={() => setSettings(false)} readOnly={readOnly} />
        ) : (
          node && (
            <NodePanel
              key={node.id}
              spec={state.spec}
              node={node}
              classes={classes}
              inspection={state.inspection}
              pinData={state.pinData}
              data={data}
              input={run?.record?.input ?? testInput}
              readOnly={readOnly}
              secrets={secrets}
              agents={agents}
              onUpdate={(patch) => edit(updateNode(current.current.spec, node.id, patch), "node:" + node.id)}
              onRename={() => rename(node.id)}
              onDelete={() => {
                edit(removeNodes(state.spec, [node.id]));
                setPanel(undefined);
              }}
              onPin={(value, remove) => {
                const pinData = { ...state.pinData };
                if (remove) delete pinData[node.id];
                else pinData[node.id] = { output: value };
                dispatch({ type: "edit", spec: state.spec, pinData });
              }}
              onClose={() => setPanel(undefined)}
              extraTabs={rightTabs}
              focusPath={focusPath}
              outputRequest={outputRequest}
              onExecute={(mode) => void start(run?.record?.input ?? inputRef.current, mode, node.id)}
              onFixWithAI={() => {
                dispatch({ type: "select", ids: [node.id] });
                setPrefill({ text: `The step ${node.id} failed with: ${run?.nodeErrors[node.id]}. Fix the workflow.`, at: Date.now() });
                setPanel(undefined);
                setSide("assist");
              }}
              runError={run?.nodeErrors[node.id]}
              truncated={!!run?.record && run.record.origin !== "editor"}
              runContent={
                runId &&
                run?.pending.filter((p) => p.nodeId === node.id).map((p, i) => <HumanPanel key={`${runId}:${p.nodeId}:${i}`} runId={runId} nodeId={p.nodeId} request={p.request} />)
              }
            />
          )
        )}
      </div>
      <TestPanel
        visible={testOpen}
        active={active || starting}
        spec={state.spec}
        input={testInput && typeof testInput === "object" && !Array.isArray(testInput) ? (testInput as Record<string, unknown>) : {}}
        onInput={updateInput}
        dryRun={dryRun}
        onDryRun={async (value) => {
          if (value) {
            setDryRun(true);
            return;
          }
          try {
            const inspection = await api.inspect(current.current.spec);
            const effects = current.current.spec.nodes.filter((n) => inspection.nodes[n.id]?.sideEffects);
            if (!effects.length || confirm(`These steps will really send or change data: ${effects.map((n) => n.name || n.id).join(", ")}`)) setDryRun(false);
          } catch (e) {
            setToast((e as Error).message);
          }
        }}
        onStart={(input) => start(input)}
        run={chatRun}
        runId={chatRunId}
        onSelect={selectRun}
        onClose={() => setTestOpen(false)}
      />
      <Executions
        agentId={agent.id}
        run={run}
        runId={runId}
        modes={modes}
        open={executionsOpen}
        onOpen={setExecutionsOpen}
        onSelect={selectRun}
        onNode={(id) => {
          setPanel(id);
          setTriggerPanel(undefined);
          setSettings(false);
          dispatch({ type: "select", ids: [id] });
        }}
      />
      {bottomPanel && <div className="wf-bottom-panel">{bottomPanel}</div>}
      {review && reviewJson && (
        <div className="wf-overlay" onClick={() => setReviewJson(false)}>
          <section role="dialog" aria-label="JSON diff" className="card wf-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="wf-row">
              <h3>{review.title}: the changed parts</h3>
              <button className="btn ml-auto" onClick={() => setReviewJson(false)}>
                Close
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="wf-section-title mb-1">Before</div>
                <JsonBlock value={changedParts(review.base, review.next).before} />
              </div>
              <div>
                <div className="wf-section-title mb-1">After</div>
                <JsonBlock value={changedParts(review.base, review.next).after} />
              </div>
            </div>
          </section>
        </div>
      )}
      <EditorDialogs
        state={state}
        data={data}
        readOnly={readOnly}
        busy={busy}
        triggerMenu={triggerMenu}
        pinEditor={pinEditor}
        problems={problems}
        toast={toast}
        saveDialog={saveDialog}
        conflict={conflict}
        note={note}
        errors={errors}
        setTriggerMenu={setTriggerMenu}
        setTriggerPanel={setTriggerPanel}
        setPanel={setPanel}
        setSettings={setSettings}
        setPinEditor={setPinEditor}
        setProblems={setProblems}
        setSaveDialog={setSaveDialog}
        setConflict={setConflict}
        setNote={setNote}
        setBase={setBase}
        edit={edit}
        pin={pin}
        showDiagnostic={showDiagnostic}
        publish={publish}
        dispatch={dispatch}
      />
    </div>
  );
}
