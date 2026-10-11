# ⚒ Anvil

**Describe a process in plain language. Anvil designs, compiles, tests and evolves an agent for it, then serves it as an API.**

Anvil is an agentic system that builds agents. Agents are typed JSON workflows composed from a library of node classes, which makes them n8n-like but authored by AI. The meta-agent that builds them is **itself a Anvil agent**, written in the same JSON IR and executed by the same engine.

```
"Triage support emails, draft replies grounded in our help center, escalate angry customers"
      │
      ▼  anvil-builder  (a JSON workflow of anvil_* node classes)
 ┌──────────┐  ┌─────────┐  ┌───────────┐  ┌──────────────────┐  ┌──────────┐  ┌──────────────┐  ┌─────────┐
 │ Triage   │→ │ Analyze │→ │ Architect │→ │ Compose+Compile  │→ │ Testgen  │→ │ Eval⟳Evolve  │→ │ Publish │
 │ System 1 │  │ task    │  │ plan +    │  │ JSON → validate  │  │ suite w/ │  │ Jev-graded,  │  │ API +   │
 │ fan-out  │  │ spec    │  │ S1 tiers  │  │ → JSON-Patch fix │  │ criteria │  │ critic patch │  │ version │
 └──────────┘  └─────────┘  └───────────┘  └──────────────────┘  └──────────┘  └──────────────┘  └─────────┘
      ▲ (optional) human_input: clarifying questions via router → re-analyze
```

## Why it's different

| | n8n / Zapier style | "prompt → agent" toys | **Anvil** |
|---|---|---|---|
| Who authors the workflow | a human, by dragging | an LLM, as free text | an LLM, as a **typed IR** checked against a class registry |
| Correctness before running | none | none | **static compiler**: schema, ports, DAG, data refs, field types, and even JS inside code nodes |
| Does it work? | you find out in prod | you find out in prod | **synthesized test suite**, graded per criterion with calibrated probabilities |
| Improvement | manual | manual | **evolve loop**: critic reads per-node traces → JSON Patch → recompile → re-test → keep the best |
| Decisions | if/else on strings | "ask the LLM" | **System 1** (Jev: fast, typed, calibrated) + **System 2** (GLM: reasoning), with confidence-gated escalation |
| Meta level | – | – | the builder is itself a workflow of the same classes (**the builder builds itself**) |

## Core ideas

### 1. Node classes: the "class library"
Every building block is a class with a Zod config schema, output schema (static, may depend on config), ports, side-effect flag, retry policy, and builder-facing guidance (`description`, `whenToUse`, `example`). The registry serializes itself into a manifest. That manifest is what the builder reads, so **adding a class automatically teaches the builder a new skill.**

20 public classes across 7 categories:

- **io**: `input`, `output`
- **ai (System 2)**: `llm`, `llm_structured` (JSON-schema-validated, self-repairing), `agent` (ReAct tool loop with native tool calls), `refine` (draft → Jev critique → revise)
- **decision (System 1)**: `decision` (Jev choice/score/noul, many questions per ~0.3s call, optional routing by answer, `uncertain` port, System-2 escalation)
- **flow**: `router` (deterministic rules), `merge`, `map` (parallel fan-out over lists via llm / llm_structured / sub-agent / code), `subagent` (composition)
- **data**: `transform` (pure templates), `code` (sandboxed JS), `knowledge_search` (BM25 RAG), `memory` (persistent KV across runs)
- **tools**: `http`, `web_fetch` (HTML → readable text), `web_search` (provider chain: OpenRouter/Exa → Wikipedia → DuckDuckGo)
- **human**: `human_approval` (approve / reject / edit), `human_input` (questions)

The `agent` node has 10 tools: `web_search`, `fetch_url`, `http_request`, `calculator` (safe parser, no eval), `current_time`, `run_js`, `memory_get/set`, `call_agent` (delegate to another saved agent), `search_documents`.

There are also 9 internal `anvil_*` meta-classes (triage, analyze, architect, compose, testgen, evolve, publish, load, edit). The meta-agents are made from them.

### 2. The Agent IR (`anvil/v1`)
An agent is a versioned JSON document: `inputSchema`, `nodes[]`, `edges[]` (with ports for branching), `policy` (cost budget, max executions, timeout, approval requirement for side effects), `tests[]`, `meta`.

Data flows through a safe, eval-free **template language**:
```
{{input.question}}   {{nodes.search.output.results[0].url}}
{{nodes.a.output.text ?? nodes.b.output.text ?? "n/a"}}
{{nodes.extract.output.items | length}}   {{nodes.x.output | json}}   {{item.name | upper}}
```
A string that is exactly one expression keeps its raw type (arrays and objects pass through).

### 3. The engine
Executes the DAG with **dataflow semantics and dead-path elimination**:
- A node is ready when all incoming edges are resolved. It runs if at least one is active; otherwise it is skipped and propagates the skip. Branches re-join naturally, with no special "join" configuration.
- Branching nodes fire named ports. Every node also has an implicit `error` port, so failures can be routed to fallback branches.
- Independent nodes run in parallel (bounded). Per-node retry with backoff, per-node timeout, run-level **cost budget**, execution cap, and timeout.
- Human steps pause the run. It resumes over the API or UI. Human steps inside sub-agents surface on the parent run.
- Input is validated and coerced against `inputSchema`, with defaults applied.
- Every step emits a typed event (`node.*`, `llm`, `decision`, `artifact`, `run.*`) that is streamed over SSE and persisted as a trace.

### 4. The compiler loop
Model output → **deterministic auto-fix** (unwrap, `source/target` → `from/to`, snake_case ids with reference rewriting, config hoisting, dedup) → **static validation** → **targeted JSON-Patch repair** by the model, falling back to a full rewrite, repeated until zero errors. The loop keeps the best candidate it has seen.

The validator reports actionable diagnostics with JSON pointers and hints:
`UNKNOWN_NODE_TYPE` (did you mean…), `INVALID_CONFIG`, `UNKNOWN_CONFIG_KEY`, `EDGE_UNKNOWN_PORT` (valid ports: …), `CYCLE`, `UNREACHABLE_NODE`, `DEAD_END`, `UNCONNECTED_PORT`, `TEMPLATE_NOT_UPSTREAM`, `TEMPLATE_UNKNOWN_FIELD` (available fields: … — checked against each class's output schema), `TEMPLATE_UNKNOWN_INPUT`, `TEMPLATE_BAD_SCOPE`, `CODE_UNKNOWN_NODE` / `CODE_NOT_UPSTREAM` / `CODE_BAD_PATH` (references inside JavaScript), `UNGATED_SIDE_EFFECT`, `TEST_INPUT_INVALID`, …

### 5. System 1 + System 2
- **System 2**: `z-ai/glm-5.3-flash` via OpenRouter, in three tiers (`fast`, `balanced`, `deep`) that map to reasoning effort and token budget. All of this is configurable.
- **System 1**: `typesafe/jev-1.13` via OpenRouter's Decisions API. It returns typed answers with calibrated probabilities in about 0.3s, at $0.04 per million input tokens.

Where Jev is used: build triage (8 questions in one call); the plan quality gate; **model-tier routing for every AI step**; runtime `model: "auto"`; `decision` nodes; `refine` critiques; **grading every test criterion**; sanity-checking unfair test criteria during evolution.

When Jev's confidence falls below the threshold, the question is escalated to GLM (confidence-gated routing).

### 6. Evaluate ⟳ Evolve
Each build synthesizes a test suite: typical, edge, and adversarial cases, each with natural-language criteria plus deterministic checks. Every test runs as a recorded eval run (human steps auto-approved) and Jev grades each criterion.

When the pass rate is below target:
1. Jev flags criteria that are unfair for the task and drops them.
2. A critic LLM reads the failing outputs **and per-node traces**, diagnoses the root cause, and emits a JSON Patch.
3. The patch is recompiled and re-evaluated. The candidate replaces the current best only if it scores higher (hill climbing).

Every version keeps its evaluation report.

Guard rails that keep evolution honest:
- **Evaluation semantics are explicit.** During tests, human approvals are auto-approved and questions are skipped. The test synthesizer, the critic, and Jev's fairness check all know this.
- **Safety invariant.** A candidate that removes a `human_approval` gate is rejected deterministically, whatever its score.
- **Lenient patching.** JSON Patch operations are applied one at a time. Harmless slips (removing a path that doesn't exist, replacing a missing key) are tolerated, and the compiler checks the result.
- **Never lose a working agent.** A failed round keeps the best version so far. If evaluation crashes entirely, the builder's `error` port still publishes the compiled agent.

### 7. The library extends itself: custom classes
When a task needs a capability the library lacks (a specific service's API, a reusable specialized skill), the architect declares it in `newClasses`. The `anvil_classgen` stage then:
1. writes a JSON-defined class of kind `http` (a parameterized API call plus optional JS shaping), `code` (sandboxed JS), or `llm` (a schema-typed prompt skill)
2. validates it statically: only declared config fields and secrets are allowed in templates, no literal credentials, and non-GET requests must be marked as side effects
3. **executes its tests for real** and repairs it from the actual failure report
4. registers it live, so the composer and every future agent can use it. `map` with `mode: "node"` runs any class per item.

Secrets come from `.env` as `{{secrets.NAME}}` and are redacted from all traces. A model-written class with side effects is blocked until a person approves it in the Node Library. Classes live in `data/classes/*.json` with version history. The `anvil-classsmith` meta-agent creates a class from a single sentence, and the UI can also generate, hand-write, approve, re-test, and delete classes.

In the live runs, a currency class (frankfurter.app) came out correct on the first attempt in 5 seconds for $0.0005. For a weather agent, the builder generated Open-Meteo geocoding and forecast classes (the geocoder was repaired after a real test failure). A later price-localizer build **reused** the currency class, which is the library compounding.

### 8. Autonomy: triggers
Agents run on their own. Triggers are a versioned part of the spec, and every firing is an ordinary traced run (`kind: "trigger"`). There are four types:
- **schedule**: timezone-aware 5-field cron (`0 9 * * 1-5`, `@daily`, names, steps) or an interval (`every: "15m"`)
- **webhook**: `POST /api/hooks/:agentId/:triggerId` with an HMAC signature of the raw body or a per-trigger secret header, a replay window, a delivery-id dedupe, and a body limit, optionally answering synchronously with the agent output (see [docs/TRIGGERS.md](docs/TRIGGERS.md))
- **poll**: RSS/Atom, JSON lists, or page changes. Items are deduplicated and processed **one at a time, oldest first**, and an item only counts as seen once its run has actually started, so nothing is lost when a run is busy.
- **agent**: run after another agent completes or fails, with a chain-depth limit that stops loops

An event that comes while the run of its trigger is active waits in a queue on disk and starts when the run ends. A run that waits for a person continues after a restart (see [docs/RECOVERY.md](docs/RECOVERY.md)), and an action with a side effect runs one time for each run (see [docs/EFFECTS.md](docs/EFFECTS.md)).

Input mapping uses the event roots (`{{payload.*}}`, `{{item.*}}`, `{{output.*}}`, `{{trigger.firedAt}}`), and the compiler checks it: roots, cron, timezone, self-chains, and required inputs that aren't mapped. The builder extracts timing from the request ("every weekday at 9", "for each new post on …") and composes the trigger. **Triggers written by the builder start disabled** until a person enables them. The UI has an Automations page and a Triggers tab on each agent (enable/disable, fire now, webhook URL and token with rotation).

### 9. The MCP bridge (both directions)
- **Consume:** connect any MCP server, over Streamable HTTP or stdio, from the Connections page. Every tool becomes a custom class `x_mcp_<server>_<tool>`. Its config schema is the tool's input schema, and a tool that declares an output schema gets typed fields the compiler can check. Tools annotated `readOnlyHint` are usable immediately; everything else is locked until approved, either per tool or all at once for a server. Credentials are written as `${ENV_VAR}` references and resolved from `.env`.
- **Expose:** Anvil is itself an MCP server at `http://127.0.0.1:8787/mcp` (Streamable HTTP, with an optional `ANVIL_MCP_TOKEN`) and over stdio (`npm run mcp`, which proxies a running server when there is one). Every agent is a tool, alongside **`anvil_build`**, `anvil_refine`, `anvil_run_agent`, and `anvil_list_agents`, so Claude Code, Claude Desktop, or Cursor can run agents and **build new ones** without leaving the conversation:
  ```bash
  claude mcp add --transport http anvil http://127.0.0.1:8787/mcp
  ```

### 10. The agent library: classes, examples, and lessons
Each agent has a class with four axes: domain, pattern, source kind, and output kind. A new build finds the class of its task, and takes the best tested agents of the same class as **examples**: their graph, their library classes, and their tested sources. This is not inheritance. The new agent gets its own steps, so a change in an example never changes it. Each domain also keeps **lessons** from its builds: the sources that worked or did not, the agent errors that evolve fixed, and the test items that were wrong. The next build of the domain sees them. The Classes page shows the classes and the lessons. See [docs/LIBRARY.md](docs/LIBRARY.md).

### 11. Live data sources
Every call to a live source goes through one function: it tries a transient failure again with a backoff, respects a short Retry-After, reports a long one as a rate limit, names a timeout, sends configured tokens only to their host, and caches GET answers in evaluation runs. The source plan prefers fast sources and proposes new candidates when all candidates fail. See [docs/LIVE_DATA.md](docs/LIVE_DATA.md).

### 12. Meta-agents: the builder is an agent
`anvil-builder`, `anvil-refiner` (natural-language change → patch → recompile → retest → new version), `anvil-evaluator`, `anvil-evolver`, and `anvil-classsmith` are all ordinary Anvil specs (`src/builder/systemAgents.ts`). The builder's clarification step is a `router` → `human_input` → re-`analyze` branch that re-joins through `??` fallbacks, which is the same machinery user agents get.

## Quickstart

```bash
npm install
cp .env.example .env        # put your OPENROUTER_API_KEY in .env
npm run dev                 # API on :8787, UI on http://127.0.0.1:5173
```

### API keys

Anvil reads its keys from `.env`. Copy `.env.example` to `.env` and fill in the values. Do not commit `.env`.

| Variable | Needed | What it is for |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes | All model calls: the builder, the agents, and web search. Get a key at openrouter.ai. |
| `ANVIL_API_TOKEN` | No | Protects the HTTP API and MCP endpoint. Set it when the server is not only on 127.0.0.1. |
| `ANVIL_SECRETS_KEY` | No | Encrypts the secrets that a person enters on the Connections page. Make one with `openssl rand -hex 32`. |
| `SLACK_WEBHOOK_URL`, `SMTP_*` | No | Used only by agents that send results to Slack or by email. |
| `GITHUB_TOKEN` and other source tokens | No | Used only by agents that call these services. See docs/LIVE_DATA.md. |

Production-style (single port):
```bash
npm run build && npm start  # UI + API on http://127.0.0.1:8787
```

With Docker (Anvil, the Python sandbox, and Chromium in containers):
```bash
cp .env.example .env              # put OPENROUTER_API_KEY in .env (and ANVIL_API_TOKEN to protect the API)
docker compose up --build         # UI + API on http://127.0.0.1:8787
```
The compose file mounts the Docker socket: the Python sandbox starts its containers on the Docker of the host. The ports listen only on 127.0.0.1.

Build tasks from files, without a person (no questions, no approvals). A task file is JSON: `{"id": "...", "request": "...", "files": ["sample.csv"], "maxBuildUsd": 1}` (see `tasks/example-meeting-notes.json`). File paths are relative to the task file.
```bash
npm run anvil -- build --task tasks/example-meeting-notes.json --out out/meeting-notes.agent.json
npm run anvil -- build --tasks tasks/ --out out/ --concurrency 2      # each *.json of the folder; out/summary.json has the results
npm run anvil -- run --spec out/meeting-notes.agent.json --input input.json
docker compose run --rm --service-ports anvil npx tsx src/cli.ts build --tasks /tasks --out /tasks/out   # the same in Docker (stop the server first: it uses the same ports)
```
The exit code is 0 only when each task gave an agent.

With `ANVIL_API_TOKEN` set, each `/api` and `/mcp` request needs `Authorization: Bearer <token>` (the UI asks for the token once). Only an event stream accepts `?token=`. `/api/health` and the webhooks stay open: a webhook has its own secret.

CLI:
```bash
npm run anvil -- build "Turn meeting notes into decisions and owner-assigned action items"
npm run anvil -- run support-triage-example '{"message":"I was charged twice"}'
npm run anvil -- refine <agentId> "Also return a Turkish translation"
npm run anvil -- list
npm run anvil -- validate path/to/spec.json
npm run mcp       # Anvil as an MCP server over stdio
```

Tests (deterministic, no network):
```bash
npm test          # the full suite: compiler, engine, builder stages, harness, sandbox (needs Docker for the real-container tests), library, files, live data, tasks
npm run typecheck
```

## API

| Method | Path | |
|---|---|---|
| POST | `/api/build` | `{request, clarify?, evaluate?, optimize?, testCount?, useLibrary?, examples?, excludeExamples?}` → `{runId}` |
| POST | `/api/agents/:id/run` | `{input, version?, wait?}`: **every agent's instant endpoint** |
| POST | `/api/agents/:id/refine` | `{instruction, optimize?}` |
| POST | `/api/agents/:id/evaluate` · `/evolve` | re-test / self-improve |
| GET | `/api/runs/:id/events` | SSE: history replay, then live stream |
| POST | `/api/runs/:id/resume` | `{nodeId, value}`: answer a human step |
| POST | `/api/runs/:id/cancel` | |
| GET/POST/PUT/DELETE | `/api/agents[/:id]` | list, import, save a new version, delete |
| POST | `/api/validate` | compile a spec, return diagnostics |
| GET/POST/DELETE | `/api/classes[/:type]` | list, save (validated and tested), or delete custom classes |
| POST | `/api/classes/generate` · `/:type/approve` · `/:type/test` | classsmith, approve side effects, re-run tests |
| GET · POST/DELETE/PATCH | `/api/triggers` · `/api/agents/:id/triggers[/:tid]` | list, add, remove, enable/disable triggers · `/fire` · `/webhook` (URL and token) |
| POST | `/api/hooks/:agentId/:triggerId` | webhook entry point (`X-Anvil-Signature` and `X-Anvil-Timestamp`, or the secret in `X-Anvil-Token`) |
| GET/POST/DELETE | `/api/mcp/servers[/:name]` · `/refresh` · `/approve` | connected MCP servers |
| ALL | `/mcp` | Anvil as an MCP server (Streamable HTTP) |
| GET · POST · DELETE | `/api/library` · `/api/library/classify` · `/api/library/lessons/:domain/:id` | classes and lessons of the library, classify the agents, delete a lesson |
| GET | `/api/registry` · `/api/usage` · `/api/health` | class manifest, cost analytics, model/provider health |

## Configuration (`.env`)
`OPENROUTER_API_KEY` (required) · `ANVIL_LLM_MODEL` · `ANVIL_DECISION_MODEL` · `ANVIL_TIERS` (JSON) · `ANVIL_CONFIDENCE_THRESHOLD` · `ANVIL_EVOLVE_TARGET` · `ANVIL_EVOLVE_MAX_ROUNDS` · `ANVIL_REPAIR_MAX_ATTEMPTS` · `ANVIL_MAX_PARALLEL` · `ANVIL_PROVIDER_SORT` (throughput | latency | price | none) · `ANVIL_SLOW_CALL_MS` / `ANVIL_MIN_TOKENS_PER_SEC` / `ANVIL_PROVIDER_COOLDOWN_MS` (**self-calibrating provider health**: providers observed to be slow are skipped for a cooldown period) · `ANVIL_SEARCH_PROVIDERS` (default `openrouter,wikipedia,duckduckgo`: OpenRouter's server-side search with the same key, then Wikipedia's official API, then DuckDuckGo) · `ANVIL_NODE_TIMEOUT_MS` (default per-node timeout; classes can declare their own, and meta-steps are bounded only by the run policy) · `ANVIL_TH_*` (the decision thresholds of the builder and the harness, for example `ANVIL_TH_DIAGNOSIS_CONFIDENCE` and `ANVIL_TH_INTENT_KEEP`. `.env.example` lists all of them with their defaults) · `ANVIL_SW_*` (the weights of the source score in the source plan) · `ANVIL_LIBRARY_*` (the examples and the lessons of the library, see docs/LIBRARY.md).

## Layout
```
src/core/        IR types, template language, registry, validator (compiler), engine, graph utils
src/core/nodes/  the 20 public node classes
src/core/tools/  web fetch/search, BM25, safe calculator, JS sandbox, agent tools
src/llm/         OpenRouter client (chat + decisions, retries, provider health), Brain (S1+S2, structured JSON, escalation)
src/builder/     anvil_* meta-classes, compiler loop, evaluator, meta-agent specs, IR guide + few-shot example
src/runtime/     RunManager (lifecycle, SSE fan-out, HITL, nested runs), composition root
src/store/       atomic JSON file store (agents are git-diffable JSON)
src/server/      Hono REST + SSE
web/             React + TypeScript + React Flow UI
tests/           vitest suites with a fake model client
```

## Bundled agents
`data/agents/` ships a small library the builder produced end to end (meeting-notes distiller, lead scorer & router, contract risk reviewer with human approval, company research brief, job-posting analyzer with a refined v2, support triage example), each with its tests and evaluation report. Run logs (`data/runs`) and memory (`data/kv`) stay local.

## Roadmap
See [ROADMAP.md](ROADMAP.md): triggers and schedules, a two-way MCP bridge, production drift monitoring, feedback that becomes regression tests, governance, a builder self-evolution benchmark, a cost optimizer, and more.

## Notes
- Local-first. The API binds to 127.0.0.1. `code` nodes use `node:vm` with a timeout and no I/O bindings. That is isolation for operator-trusted code, not a hostile-code sandbox.
- Everything is on disk in `data/` as JSON: agents with their full version history, run traces, and memory.

## License

Copyright 2026 Ulaş Taylan Met. Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
