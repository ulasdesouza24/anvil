# Health checks of live data agents

A source can change or break after the build. At an interval, Anvil runs the tests of each live data agent and marks a broken agent with the cause. The code is in `src/runtime/health.ts`.

## Which agents

An agent gets checks when all of these are true:

- It is not a system agent.
- Its current version has tests.
- It reads live data: a data need in its task, or a step that reaches the web (`http`, `web_fetch`, `web_search`, `browser`, `mcp`, a class with one of these, or an agent step with a web tool).

## One check

1. Run the tests of the current version. The runs read fresh data: the live fetch cache is off.
2. Compare the score with `ANVIL_HEALTH_MIN_SCORE` and with the score of the last evaluation of the version (the baseline).
3. Save the result in the history of the agent (KV namespace `health`).

| Result | Status |
|---|---|
| The score is below the minimum | `broken` |
| The score falls more than `ANVIL_HEALTH_MAX_DROP` below the baseline | `broken` |
| The environment (for example a rate limit) stops every test | the status does not change. The cause starts with "not measured". |
| Other | `healthy` |

The cause of a broken check names the failed tests and their errors, failure classes, or failed items.

## A fix

With `ANVIL_HEALTH_EVOLVE=on`, a newly broken agent starts one evolve run. Evolve saves the fix as a **draft** version: the current version stays. A person examines the draft and publishes it (the Versions tab of the agent, or `POST /api/agents/:id/current`).

## Config

| Variable | Default | Meaning |
|---|---|---|
| `ANVIL_HEALTH_EVERY` | `1d` | the interval between two checks of one agent. `off` turns the checks off. |
| `ANVIL_HEALTH_MIN_SCORE` | 0.6 | an agent with a lower score is broken |
| `ANVIL_HEALTH_MAX_DROP` | 0.25 | an agent whose score falls more than this value below its baseline is broken |
| `ANVIL_HEALTH_BUDGET_USD` | 0.3 | the most money for one check |
| `ANVIL_HEALTH_EVOLVE` | off | start evolve for a newly broken agent |
| `ANVIL_HEALTH_HISTORY` | 30 | the checks that the history of one agent keeps |

## Use

| Where | How |
|---|---|
| Server | the checks start with the server. The timer looks for due agents each hour, so the first check runs in the first hour. |
| CLI | `anvil health` checks each live data agent. `anvil health <agentId>` checks one. |
| API | `GET /api/health/agents`, `GET /api/health/agents/:id`, `POST /api/health/agents/:id/check` |
| UI | the health on the agent list, and the history on the agent page |
