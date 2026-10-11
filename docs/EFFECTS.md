# Effects: one action, one time

An action with a side effect changes the outside world: an email, a Slack message, a webhook, a POST of a class, or an `http_request` that is not GET. Anvil runs each such action one time for each run. The code is in `src/core/effects.ts`.

## No retry after an action

The engine does not run a step again after an error when the step did an action with a side effect in that attempt. A retry can send the same email two times.

A retry is safe only when the action did not go out:

- the receiver gave `429`, or
- a network error came before the request: `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`, a connect timeout, or the SMTP errors `ECONNECTION` and `EDNS`.

Such an error is a `NotSentError`, and the retry policy of the step applies to it. An HTTP 5xx or a timeout after the request is not clear: the receiver can have the action. The step fails, and it does not run again.

The harness also does not start a new attempt after an action ran (docs/HARNESS.md).

## One action of a tool in a turn

In a conversation, an agent step does each action of a tool at most one time in a turn (`ANVIL_EFFECTS_PER_TURN`, default 1, 0 turns it off). The harness does not run a second call of the same tool in the turn. The agent gets the message "already done in this turn", and it can ask the user for a second one in its reply. An agent step without a conversation has no limit, because a batch can need many actions.

## The effect record

Each action has a key: the root run, the step, the class, the resolved arguments, and the place of the call among the same calls of the run. The record of each key is in the store (namespace `effects`):

| Record | What happens when the same key comes again |
|---|---|
| `done` | The step gets the recorded result. The action does not go out again. |
| `started` | The step fails with a clear message. The earlier call has no clear result, so a person checks the receiver. |
| none | The action goes out. |

A call that did not go out (`NotSentError`) leaves no record. The record of a nested run uses the root run of the tree, so a sub-agent that runs again finds its records.

The records stay for `ANVIL_EFFECTS_TTL_MS` (default 7 days). An evaluation run keeps no record, because its sends are dry runs and its tools are mocks.

## The key for the receiver

`send_webhook` sends the header `Idempotency-Key: anvil-<root run>-<step>`. `send_email` uses `<anvil-<root run>-<step>@anvil>` as the Message-ID. A receiver that knows these values can drop a second copy.
