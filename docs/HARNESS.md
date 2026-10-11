# Anvil harness plan

**Goal:** when a built agent fails at its job, the harness finds the failure, fixes it, and tries again. It continues until the agent gets the required result. When a limit stops it, the harness returns an honest partial result.

Order of work: benchmark, cost limits, browser (Playwright), source plan, harness, STE (Simplified Technical English).

## 1. Definition of done

- Each agent and each critical step has a measurable "done" condition.
  - Example: "the fund list has one item or more, and each fund has return data".
- Anvil derives these conditions from the success criteria in the task spec.
- A condition has one of two kinds:
  - a deterministic check (the field is not empty, the value is a number)
  - a yes/no judgment by the decision model (Jev)
- In code: the spec gets an `acceptance` field. The compiler examines these conditions.

## 2. The loop: try, check, fix, try again

- The harness checks each attempt against the definition of done.
- Jev puts each failed attempt into one failure class:
  - no data
  - source blocked
  - rate limited: a source refuses more requests for some time (a rate limit, a quota, or HTTP 429). The harness finds this class from the error text, without a model call. Only a different source can help, because a retry hits the same limit.
  - bad format
  - tool error
  - timeout
  - wrong reasoning
- The harness selects the next strategy from the failure class. The strategy ladder:
  1. web search
  2. read the page
  3. open the page in a browser
  4. capture the API that the site itself calls
  5. find a public API
  6. use an alternative source
- The harness records each strategy that it tries. It does not select the same strategy again.
- Give-up detection:
  - An agent can try to finish while required fields are empty. The harness rejects that answer.
  - The harness tells the agent what is missing and which strategy is next.
- In code: the engine gets a harness layer at the node level. The tool loop of the `agent` node connects to this layer.

## 3. Context management

### Threshold and shares

- Summaries start only when the context goes above the threshold.
- The default threshold is 200,000 tokens. The real threshold is the smaller of two values: 200,000, or 60% of the model window.
- A recent-turn share is part of the threshold. The default share is 40% of the threshold.
- The harness also keeps an output reserve for the answer of the model.
- After compaction, the context is always below the threshold, and the answer has space.
- Settings: `ANVIL_CONTEXT_COMPACT_AT`, `ANVIL_RECENT_TURN_SHARE`.

### One very large part (an attachment, a large tool result, a long model output)

- Each single part has a size limit. A part above this limit does not go into the context as raw text.
- The harness keeps the raw content outside the prompt.
- The context gets a detailed summary of the part and a pointer to it.
- When the agent needs a detail, it reads the part page by page with `recall(step, range)`.
- The agent does not call the external tool again for this.

### Summaries in tiers

- When the recent turns fit in the recent-turn share, they stay as they are.
- When they do not fit, the recent turns get a detailed summary.
  - The detailed summary keeps the structure, numbers, quotes, decisions, and open questions.
- Older turns get a short summary.
  - The short summary also keeps numbers, URLs, and identifiers without change.
- Two things never get a summary: the last message and the current goal of the agent.

### Call ledger

- The context keeps a short record of each tool call.
  - The record holds the tool, the arguments, a summary of the result, and the status.
- The harness never removes this record. Thus the agent knows its calls after a compaction.

### Guard against repeated calls

- A call with the same tool and the same arguments does not go to the external service again.
- The harness returns the recorded result with a note: "you called this at step N".
- This call costs nothing and takes no time.

### History that the prompt cache can use

- Below the threshold, the history only grows at the end.
- The harness never rewrites the history.
- Thus the prompt cache can read the repeated prefix at a low price.

## 4. Honest stop conditions

- Each loop has limits: the number of attempts, a budget in USD, and a time limit.
- When a limit is reached, the agent does not return an empty list.
- The agent returns `status: partial` with the partial result, the list of gaps, and the cause.
- The evaluation counts a partial result separately. A partial result is not a pass. But an honest partial result gets a better score than a silent empty result.

## 5. The harness at build time

- The critic in the evolve stage sees the failure class.
- When the class is "source blocked" or "no data", the critic does not rewrite the prompt.
- A test can meet every test item while an acceptance rule of the agent rejects its output (for example, a rule wants a note, and the note is correctly empty). The test items are the stronger evidence. The smoke test does not stop the other tests for it, and evolve removes such rules and evaluates again. A rule for an empty output or a failed run always stays.
- A test that fails because of a rate limit has no score. The pass rate does not count it, the diagnosis does not examine it, and the critic does not get it. The test shows "not scored" with the evidence. When a rate limit stops all tests, the quality of the version is "untested", and the version cannot win over another version.
- The critic asks for a new capability:
  - a browser class
  - an `http` class made from a captured API
  - the fallback source from the source plan
- Anvil tries a new capability with one smoke test first. The full test suite runs only when this test passes.

## 6. Measurement

The benchmark reports these numbers for each run:

| Number | Why |
|---|---|
| Repeated tool calls | Shows forgetting and waste |
| Tokens for each step | Shows context growth |
| Prompt cache hit rate | Shows if the append-only history helps |
| Pages read with `recall` | Shows use of the call ledger |
| Parts above the size limit | Shows if the part limit is correct |
| Detailed summaries | Shows if the recent-turn share is correct |
| Strategy steps used | Shows which step of the ladder helps |
| Partial-result rate and cost | Shows the value and the price of the harness |

Anvil sets the thresholds from these numbers, not from estimates.

## Parts that the harness needs

The harness cannot use the top steps of the ladder without these parts:

- **Browser (Playwright):** steps 3 and 4.
- **Source plan:** steps 5 and 6, and the preflight check before the build.
