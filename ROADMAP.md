# Anvil roadmap

**Mission:** anyone can turn a described process into a reliable, tested, continuously improving agent — without writing code.
**Vision:** a system that compounds. Every build leaves behind reusable capabilities (classes, agents, tests), and the builder itself gets better from every run, until "describe it" is the only interface anyone needs for automation.

Each item below says *why* it serves that mission, *what* it is, and *how* it plugs into the current architecture (node classes → typed IR → compiler → engine → evaluation → evolution, with the builder expressed as an Anvil agent).

---

## ✅ Shipped: self-extending node library (custom classes)
The builder now extends its own class library. When the architect finds a capability the library lacks — typically a specific service's API or a reusable specialized skill — it declares a `newClasses` entry. The `anvil_classgen` stage then writes a JSON-defined class of kind `http`, `code`, or `llm`. The class is validated statically (declared config fields, declared secrets, no literal credentials, side-effect rules), its tests are **executed for real**, it is repaired from the actual test report, and then it is registered live. Future agents reuse it (library compounding). Model-written classes that have side effects stay blocked until a person approves them. Secrets are resolved from `.env` and redacted from every trace. Also shipped:
- `map` in `mode: "node"` runs any library class per item.
- The `anvil-classsmith` meta-agent creates a single class from a description.
- The Node Library UI can generate, hand-write, approve, re-test, and delete classes.

---

## ✅ Shipped: triggers (autonomy)
Schedules (cron with timezones, or intervals), token-protected webhooks, polling (RSS/Atom, JSON, page changes) that loses no item, and agent-to-agent chains with loop protection. Triggers are compiled like the rest of the spec, the builder extracts them from the request, and they start disabled until you switch them on. See the README (section 8).

## ✅ Shipped: MCP bridge
Any MCP server's tools become typed node classes. Tools that aren't read-only need approval, and secrets are passed as env references. Anvil itself is an MCP server (HTTP and stdio), where every agent is a tool and `anvil_build` lets Claude and other clients build new agents. See the README (section 9).

## Next: making agents autonomous

### 1. Triggers & schedules *(shipped — see above)*
**Why:** until an agent runs on its own, the user still has to operate it.
**What:** cron schedules; incoming webhooks (`POST /hooks/:agentId/:secret`); pollers (RSS, IMAP inbox, a URL that changes); "run after agent X finishes" chaining.
**How:** a `trigger` block in the spec (`meta.triggers`), a scheduler service in the runtime, and run records tagged `kind: "trigger"`. The builder's analyzer already extracts "when" phrases ("every morning", "when an email arrives"), so it can fill triggers automatically.

### 2. MCP bridge, in both directions *(shipped — see above)*
**Why:** this is the fastest path from "the classes you have" to "every tool that exists".
**What:**
- **Consume.** Point Anvil at any MCP server. Each MCP tool becomes a custom class automatically: its schema becomes `configSchema`, and its side-effect hints decide whether approval is needed.
- **Expose.** Run Anvil as an MCP server. Every published agent becomes a tool that Claude, Cursor, and other clients can call.

**How:** a new custom-class `impl.kind: "mcp"`, plus an MCP server adapter over `/api/agents/:id/run`.

### 3. Chat & long-running agents
**Why:** many processes are conversations, not one-shot calls.
**What:** a session-scoped memory, a chat UI per agent, and agents that pause for days (approval SLAs, reminders).
**How:** a `session` input plus persistent run state. The engine already supports pausing and resuming. Paused runs need to be persisted so they survive restarts.

---

## Next: making agents trustworthy in production

### 4. Production monitoring & drift detection
**Why:** a 95 on day one means nothing if quality drifts silently.
**What:** sample real production runs, grade them with Jev against the agent's own success criteria (online evaluation), plot quality over time, and alert on drift. When quality drops below target, open an **evolve** run automatically.
**How:** reuse `evaluateSpec`'s criteria judging on recorded runs, add a `monitor` policy to the spec, and add a dashboard.

### 5. Human feedback → regression tests
**Why:** a user's corrections are the best test data that exists.
**What:** 👍/👎 and "correct this output" on every run. Corrections become new test cases (input + expected-property criteria). The evolver then trains on them, and they are never allowed to regress.
**How:** a feedback endpoint that writes to `spec.tests` with a `source: "feedback"` tag. Evolution requires those tests to stay green.

### 6. Governance & safety
**Why:** agents touch real data and real systems.
**What:**
- a policy engine (PII detection with Jev nouls, data-egress allowlists per agent, maximum spend per day)
- a secrets vault with per-class scoping
- an immutable audit log
- role-based approvers
- stronger isolation for code (`isolated-vm` or a WASM sandbox instead of `node:vm`)

**How:** policies live in the spec. The compiler gains policy checks, and the engine enforces them at node boundaries.

---

## Next: making the builder itself better (the builder improves itself)

### 7. Builder benchmark & self-evolution
**Why:** the builder's quality caps everything else.
**What:** a benchmark of around 50 build requests with golden tests. Nightly builder evaluation measures pass rate, cost, repair count, and time. The evolver is then applied to the **builder spec itself**, the same way it improves user agents, with prompts versioned in the spec.
**How:** the builder is already an Anvil agent, so it needs a test suite of build requests (graded by running the resulting agents), plus `anvil-evolver` pointed at `anvil-builder`.

### 8. Cost / latency optimizer
**Why:** a cheaper, faster agent that is just as good is strictly better.
**What:** per-node searches that try a lower model tier, a shorter prompt, or a Jev `decision` in place of an LLM classification, and keep the change only if the test score holds. Deterministic node outputs get cached. The result is reported as a Pareto front (score vs. $ vs. seconds).
**How:** a variant of the evolve loop whose objective includes cost, since each run already reports usage.

### 9. Pattern library & retrieval
**Why:** the best agents built so far are the best few-shot examples for new ones.
**What:** index published high-scoring agents by pattern and task, and retrieve the top matches as examples for the architect and composer.
**How:** embed task specs, and add similar-agent retrieval to the architect prompt. `agentsCatalog` already exposes agents for reuse.

---

## Next: reach

### 10. Visual editing & diffs
A drag-and-drop editor on the existing React Flow canvas with live compiler feedback, version-to-version diffs (graph and prompts), "explain this agent" summaries, and side-by-side A/B runs of two versions.

### 11. Knowledge bases
Document ingestion (PDF, URLs, Notion exports) into persistent, embedded knowledge bases that agents mount by name. This replaces passing documents inline to `knowledge_search`.

### 12. Datasets, batch runs & A/B traffic
Run an agent over a CSV, batch-evaluate versions on the same dataset, and split live traffic between versions with automatic promotion of the winner.

### 13. Deploy anywhere
Export an agent as a standalone package (TypeScript, Docker, Cloudflare Worker) that bundles the engine and the classes it uses, with typed SDK clients generated from `inputSchema` and `outputSchema`.

### 14. Multimodal inputs
Images, PDFs, and audio as first-class inputs (vision/OCR/speech classes), so "process these receipts" or "summarize this call" become buildable.

### 15. Teams, marketplace, cloud
Workspaces, auth, usage-based billing, and a shared marketplace of classes and agents with versioned dependencies. This is the business layer on top of the compounding library.

---

### Suggested order
~~1~~ → ~~2~~ → 5 → 4 → 7 → 8 (feedback-driven regression tests, production monitoring, then the builder improving itself), with 10 in parallel for the demo.
