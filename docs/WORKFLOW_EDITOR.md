# The workflow editor

An Anvil agent is a typed graph: steps (`nodes`), edges with ports, and data that flows through `{{ template }}` references. The builder writes this graph from a plain-language request. The workflow editor lets a person open the same graph on a canvas, change it, test it, and save it as a new version. The AI stays in the loop: a person can ask the assistant for a change, and the builder can refine and evolve an edited agent.

The editor is at `/agents/:id/workflow`. The Graph tab of an agent stays read-only and has an **Edit** button.

## Use the editor

1. Open an agent and click **Edit workflow**. For a new agent, click **New workflow** on the Agents page, or **start from a blank workflow** on the Build page.
2. Add a step: click **+ Step** or press `Tab`. Drop a step on an edge, or click **+** on an edge, to put the step between two steps.
3. Click a step to open its panel: **Input** (the data that comes in), **Parameters** (the config, with a Fixed or Expression mode for each field), **Output** (the data of the last run, or pinned data).
4. Click **Test**. The test is a dry run unless you turn the dry run off. Right-click a step for **Execute step** and **Run to here**.
5. Click **Save**. The save makes a new version. The compiler must give zero errors.

Other tools of the top bar: **AI** (the assistant, `Ctrl/Cmd+K`), the history button (versions: compare or load), and the gear (the workflow settings: input fields, policy, acceptance rules).

| Key | Action |
|---|---|
| `Tab` | Open the step palette |
| `Delete` / `Backspace` | Delete the selected steps (a step with one edge in and one edge out keeps the chain connected) |
| `Ctrl/Cmd+C`, `Ctrl/Cmd+V`, `Ctrl/Cmd+D` | Copy, paste, duplicate |
| `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, `Ctrl+Y` | Undo, redo |
| `Ctrl/Cmd+A` | Select all steps |
| `F2` | Rename the selected step (each reference to it changes too) |
| `D` | Disable or enable the selected steps |
| `Ctrl/Cmd+S` | Save |
| `Ctrl/Cmd+Enter` | Test |
| `Ctrl/Cmd+K` | AI assistant |
| `Escape` | Close the panel, clear the selection |
| Drag on the empty canvas | Pan |
| `Shift` + drag | Select the steps in a box |
| `Shift`/`Ctrl`/`Cmd` + click | Add a step to the selection |

## Concepts

| Concept | What it is |
|---|---|
| Draft | The unsaved work of the editor for one agent, in `data/drafts/<agentId>.json`. A draft is not a version: runs, triggers and the API use saved versions only. |
| Base version | The version that the draft started from. A save checks that no newer version came after it. |
| Save | The draft becomes a new version. The compiler must give zero errors. |
| Test run | A run of the draft, started from the editor (`origin: "editor"`). It keeps the full data of each step (`stepData`). |
| Dry run | The default for test runs. An action with a side effect gives a preview and does not go out. |
| Pinned data | A fixed output for a step. A test run does not run a pinned step. Pinned data stays in the draft and never goes into a version. |
| Disabled step | The step does not run. Its output is empty, and only its `out` edges stay active. |
| Locked step | The builder (the assistant, refine, evolve) does not change or remove the step. A person can still change it. |

## The IR fields of the editor

The editor adds optional fields. An agent without them works as before.

```jsonc
{
  "id": "draft_reply",
  "type": "llm",
  "config": { "prompt": "…" },
  "position": { "x": 240, "y": 120 }, // the place on the canvas
  "disabled": true,                   // the step does not run
  "notes": "Check the tone with legal", // a note of a person
  "locked": true                      // the builder does not change this step
}
```

`spec.meta.canvas` holds the sticky notes and the viewport: `{ "notes": [{ "id", "text", "position", "size", "color" }], "viewport": { "x", "y", "zoom" } }`. The engine does not read it.

## Rules of disabled steps

1. A disabled step does not run. The engine records `node.skipped` with the reason `disabled`.
2. Its `out` edges stay active, so the next steps run. A step with named ports (a router, a decision) fires no port, so the steps after it are skipped.
3. A template that reads a disabled step gets an empty value. The compiler gives the warning `DISABLED_NODE_REFERENCED`, unless the template has a fallback (`??`).
4. The `input` step and the `output` step cannot be disabled (`DISABLED_IO`).
5. A disabled `human_approval` step does not count as a gate. A step with a side effect after it gets `UNGATED_SIDE_EFFECT`. A disabled `action_gate` does not count as a gate.
6. A disabled step with a side effect does not count as a side effect.

## Rules of locked steps

1. The assistant and the refiner restore a locked step when a patch changes it. When the compiled result still changes it, the edit fails with a clear message.
2. Evolve rejects a candidate that changes or removes a locked step, as it rejects a candidate that removes a `human_approval` gate.
3. The position and the notes of a locked step can change.
4. The model prompts name the locked steps.

## Test runs

`POST /api/workflow/run` starts a test run of a draft. The draft must compile with zero errors.

| Mode | What runs |
|---|---|
| `full` | All steps. |
| `to_node` | The target step and the steps before it. The output of the run is the output of the target. |
| `node_only` | Only the target step. The steps before it use pinned data, or the data of the run `reuseRunId`. A step without data runs. |

A test run is a dry run unless the body has `"dryRun": false`. In a dry run:

- `send_slack`, `send_email` and `send_webhook` give `{sent: false, dryRun: true, preview}`.
- An `http` step with a method other than GET gives `{status: 0, ok: true, body: {dryRun: true, action, preview}}`.
- A library class with a side effect gives `{dryRun: true, action, preview}`. A class that stays inside Anvil runs: sandboxed code, a prompt skill, and a mock tool.
- The browser does not do `fill` and `press` actions.
- A program in the sandbox cannot send data out.
- Nested runs (sub-agents) are dry runs too.

A test run that waits for a person stops when the server stops: it uses an unsaved draft, so it cannot start again.

## Saves and merges

`POST /api/agents/:id/draft/save` saves the draft as a new version.

- When a newer version came after the base version, the answer is `409` with `merge`: a three-way merge by step id. A change of one side wins. When both sides change the same step or the same field in different ways, the merge keeps the draft and lists a conflict.
- When a refine or evolve run changes the agent now, the answer is `409`. Wait for the run to end.
- When the draft has errors, the answer is `400` with the diagnostics.

`PUT /api/agents/:id` (the JSON editor) accepts `baseVersion` and gives `409` for an old base.

## The AI assistant

`POST /api/workflow/assist` starts a run of the system agent `anvil-assistant`. The run changes the draft with `anvil_edit` and compiles it. It does not test or publish. Its output is `{spec, summary}`. The editor shows the change on the canvas as a diff. The person accepts or rejects it.

## The test webhook

`POST /api/agents/:id/triggers/:tid/listen` waits for the next request to a saved webhook trigger (default 120 s, max 300 s). The request gets the normal token or signature check. It starts no run, also when the trigger is off. The answer has the payload, the headers without secrets, the query, and the agent input that the trigger maps it to. The editor can pin this input.

## API summary

| Method and path | Use |
|---|---|
| `POST /api/workflow/inspect` | The diagnostics, and for each step: ports, output schema, side effects, category |
| `POST /api/workflow/diff` | Compare two specs |
| `POST /api/workflow/merge` | Three-way merge |
| `POST /api/agents/blank` | A new agent: input → output |
| `GET/PUT/DELETE /api/agents/:id/draft` | The draft |
| `POST /api/agents/:id/draft/save` | Save the draft as a version |
| `POST /api/workflow/run` | A test run of the draft |
| `POST /api/workflow/assist` | The AI assistant |
| `POST /api/agents/:id/triggers/:tid/listen` | The test webhook |
| `GET /api/runs?origin=editor` | The test runs of the editor (`!editor` leaves them out) |

The pure helpers of `src/core/workflow.ts` work in the server and in the browser: `renameNodeId`, `uniqueNodeId`, `diffSpecs`, `mergeSpecs`, `lockedViolations`, `restoreLocked`, `carryLayout`, `ancestorsOf`, `makesCycle`.
