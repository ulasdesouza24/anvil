# Runs: the cost of nested runs

A run can start nested runs: a sub-agent, a best-of candidate, the test runs of an evaluation. The run manager is in `src/runtime/runManager.ts`.

## Live cost

Before, the cost and the token counts of a run grew only with its own LLM calls. A nested run added its cost to the parent only when it ended. A best-of build thus showed almost no cost for many minutes, because its candidates did all the work.

Now each LLM call and each decision of a nested run also goes to its parent run, and from there to the next parent:

1. The run manager adds the cost of the nested calls for each parent.
2. Each `ANVIL_LIVE_USAGE_MS` (default 2000), the parent gets one `usage` event with the sum. The event adds to the counters of the parent.
3. When the parent ends, its final usage replaces the live sum. The final usage counts each call one time.

An unrecorded nested run (a `subagent` step) also sends its cost. The UI adds the `usage` event to the cost, the calls, and the tokens of the run.
