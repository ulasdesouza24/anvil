# Conversation agents

A conversation agent talks with a user over many turns. Examples: a support agent that asks for an order id, or a booking assistant that confirms before it books.

## The contract

| Part | Value |
|---|---|
| Input of one turn | `{"messages": [{"role": "user" \| "assistant", "content": "..."}], "session_id": "..."}` |
| Output of one turn | `{"reply": "<the next message to the user>", "done": <true when the conversation is finished>}` |
| Spec | `meta.interaction` is `"conversation"` |

Each user message runs the agent once with all turns so far. The `agent` node gets the turns with `"conversation": "{{input.messages}}"`. Its answer is the next reply.

## How the builder makes one

| Step | What changes |
|---|---|
| Analysis | sets `interaction` in the task spec. `conversation` gives the input `messages` (required) and `session_id`, and the outputs `reply` and `done`. Other inputs stay, but they are not required. |
| Architect and compose | follow CONVERSATION AGENTS in the IR guide (`src/builder/guide.ts`) |
| Acceptance | the harness checks only the fields of one turn. A success criterion is about all turns, so the tests judge it. |
| Testgen | writes a `conversation` for each test: `persona`, `goal`, `firstMessage`, `facts`, `maxTurns` |
| Evaluation | a simulated user talks with the agent (`converseTest` in `src/builder/evaluate.ts`). The criteria judge the full transcript. The checks apply to the last output. |

## Sessions

A session keeps the turns (`src/runtime/sessions.ts`, KV namespace `sessions`). The `session_id` is the same in each turn. Thus a `mock` tool keeps its state for the session: a seat that the agent books in turn 2 stays booked in turn 3.

| Call | What it does |
|---|---|
| `POST /api/agents/:id/sessions` `{version?, message?}` | starts a session, and with a message, gets the first reply |
| `POST /api/sessions/:sid/messages` `{content}` | sends a message and gives `{reply, done, runId, status}` |
| `GET /api/sessions/:sid` | gives the session with its turns |
| `GET /api/agents/:id/sessions` | lists the sessions of an agent |
| `DELETE /api/sessions/:sid` | deletes a session |

The agent page shows a chat panel for a conversation agent.

## The tool rules of a turn

Each conversation agent step gets these rules in its system message (`CONVERSATION_TOOL_RULES` in `src/core/nodes/ai.ts`):

- Call a tool only with facts that the user or a tool result gave. When a fact is missing, ask for it.
- Ask the user only for a fact that a tool parameter or a rule needs. Do not ask for other data, for example an account number, before an action.
- Do each action at most one time in a turn (docs/EFFECTS.md).

The harness does not run a call with an empty required argument. The agent gets "Not run: <field> is empty ... Ask the user for it." A call that the harness did not run has `"rejected": true` in the steps of the agent. The evaluation does not show it to the judge as an action.

## The smoke test of a conversation

A conversation test that ran to its end shows a working agent, also with a low score. So a failed smoke conversation stops the other tests only when the agent run failed. A test of one input still stops the others below `ANVIL_EVAL_SMOKE_MIN_SCORE`.

## The tool results of earlier turns

Each turn is a new run. Before, the agent got only the text of the earlier turns, so it lost the ids that a tool gave. For example, it put a name in place of the account id that the verification gave. Now an assistant turn keeps its tool calls (`toolCalls`: tool, arguments, and the start of the result). The next turns get them in the system message under "TOOL RESULTS OF THE EARLIER TURNS". The newest calls stay when the list is longer than `ANVIL_TOOL_DATA_CHARS`.

A chat session stores the tool calls of each reply. A conversation test sends them with the turns.

## The acceptance of a turn

In a conversation, the harness checks in each turn only the reply field (`reply`, `answer`, `message`, or `text`) and `done`. An end field, for example an outcome, comes only in the last turns, so an empty end field in a turn does not make the turn partial.

## A request to stop is not a closing

A conversation agent often starts with a decision: does the last message ask for something new, or does it only close the call? A collections agent sent "stop calling me" to the closing reply, because its criteria said "ends the call". The closing reply has no tools, so the request was lost. Now the builder guide says: a message that only thanks or says goodbye is a closing. A request to stop, cancel, or opt out asks for an action, and the agent step handles it.

## Actions and confirmations

The turn rules of each conversation agent also say: never say that an action is done when no tool call did it, say the exact values of an action in the message that asks for its confirmation, and do not quote the rules to the user.

The acceptance judge of a turn meets a rule that limits an action ("at most 14 days", "only after") when the turn does not do that action.

## No rule judge in a turn

A conversation agent has no rule judges in its acceptance. A judge of one turn cannot see if a rule of the full conversation holds. In a collections test, it failed "after 2 failed checks, end the call" in a turn that only recorded a promise (p=0.33). The turn became partial, and a correct conversation failed. The action gate already checks the rules before each action, with the full conversation (docs/GATE.md), and the tests check them at the end. The harness also skips the rule judges of an agent that was built before this change.

## A claimed action without a tool call

The turn rules say "never say that an action is done when no tool call did it", but a model can still do it. In a hard collections test, the agent said "your promise is recorded" and did not call the tool. Now, when a conversation turn did no action with a side effect, Jev checks the reply: does it say that an action is done now? When it does (p at or above `ANVIL_TH_ACTION_GATE`), the reply goes back to the agent one time: it calls the tool when the user confirmed, or it writes a reply without the claim. The trace has the harness event `action_claim_without_call`.
