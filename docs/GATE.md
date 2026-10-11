# The action gate

An action that changes something (a refund, a cancellation, a booking, a sent message) runs only when the action gate says yes. The structure, not a prompt, stops an action without confirmation or against a rule. The code is in `src/core/actionGate.ts`.

## What the gate checks

One Jev call answers each question:

| Question | When |
|---|---|
| Does the last user message confirm this action with these values? A yes to the values that the agent stated, or a clear instruction to do this exact action, confirms. | the run has turns (a conversation) |
| Does the last user message only give information or pick an option (an id, an item, "it is the sweater")? A yes here means no confirmation. | the run has turns (a conversation) |
| Does the action keep this rule? (one question for each important rule of the task) | the task has important rules (docs/POLICY.md) |

An answer below `ANVIL_TH_ACTION_GATE` (default 0.6) blocks the action. The reason names the missing confirmation and each broken rule.

## Where the gate runs

| Place | How |
|---|---|
| The `action_gate` step | config: `action` (the action in words, with its values), `args`, `facts` (the data that the rules need), and optional `conversation`, `rules`, `requireConfirmation`. The defaults are the messages of the run input and the important rules of the task. Ports: `pass` runs the action, `block` goes to a reply step that reads `{{nodes.<gate>.output.reason}}`. With `requireConfirmation: false`, the gate checks only the rules: use it for an action that the rules say to do at once. |
| A given tool inside an `agent` step | a call of a class with side effects goes through the same check. A blocked call gives the agent an error with the reason, and the artifact `action_blocked`. A class in `noConfirmation` of the step gets no confirmation question: the gate checks only the rules. |

## The compiler

In a conversation agent or an agent with important rules, the error `UNGATED_ACTION` rejects:

- a step with side effects that a path from the input reaches without an `action_gate` step;
- a step with side effects after the `block` port of a gate.

The builder knows the gate from the IR guide (ACTION GATE). Compose always gets its config schema for a conversation or a task with rules. The repair loop adds a missing gate.

## Measured

The practice benchmark with best-of-N (3 runs, 999 test runs) gave 352 passes and 657 blocks. A block is the expected result when an agent tries an action before the confirmation. A scan of the passes found 2 weak confirmations, where the user only named an item. The question about information alone now blocks both of them, and 12 random real confirmations still pass.

## A confirmation rule and the date of today

A policy often has a rule like "say the amount and the date and get a clear yes before a payment". The gate checks the confirmation with its own question, so the rule question repeated it more strictly. In a hard collections test, the user said "Yes, I confirm the 60 dollar payment" (confirmed 0.93), but the rule question gave 0.44, and the gate blocked the payment two times. The same rule also blocked a call that only recorded the outcome. Now the rule question says: a confirmation rule is kept when the last user message confirms the action with its values, a payment "now" has the date of today (the gate gives "today"), and a rule about another kind of action does not apply.
