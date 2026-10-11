# Given tests and the practice benchmark

A task can come with its own tests. Anvil reads the common formats and makes Anvil test cases (`src/core/externalTests.ts`).

## Formats

A list, `{"tests": [...]}`, `{"cases": [...]}`, or `{"tasks": [...]}`. A task file or a benchmark can give the path of a `.json`, `.jsonl`, or `.yaml` file. The build API accepts values only, not file paths.

| Format | Example | Becomes |
|---|---|---|
| Anvil test | `{"name", "input", "criteria", "checks", "conversation"}` | the same test |
| Input and expected output | `{"input": {...}, "expected_output": ...}` (also `expected`, `output`, `answer`) | a criterion that compares with the expected value, and an `equals` check for each simple field of an expected object |
| A question | `{"question": "...", "answer": "..."}` | the input `{"text": ...}` and a criterion |
| User scenario | `{"instruction": {"persona", "instructions", "known_info"}, "actions": [{"name", "arguments"}], "outputs": [...]}` | a conversation test: a simulated user plays the scenario. Each action becomes a criterion about the tool calls in the transcript. |
| Conversation | `{"messages": [...], "expected": ...}` | a conversation test with the user messages |

## Where tests come in

| Place | How |
|---|---|
| Build | the build input `tests`, or `tests` in a task file. Testgen puts the given tests (ids `g1`, `g2`, …) before the generated tests. Evolve never removes an item of a given test. |
| CLI | `anvil test <agentId> --tests tests.json [--out report.json]` scores an agent with the tests. |
| Benchmark | `givenTests` of a case goes to the builder. `hiddenTests` of a case scores the published agent after the build. The builder does not see them. |

## The practice benchmark

`bench/practice.json` has 5 cases: an airline (change and cancel), a shop (return and order status), and an expense check. The tools are mock tools with state (`bench/practice/*-tools.json`). Each case has hidden tests: user scenarios for the conversation agents and expected outputs for the others.

```bash
npm run bench -- --suite bench/practice.json
```

The report shows "hidden tests: mean score". A case meets its expectations when its hidden score reaches `expect.minHiddenScore`.

## Data that the tools know

Testgen sees the start data of each mock tool and the result of each read-only tool that needs no arguments. The tests then use ids that exist. `ANVIL_TOOL_DATA_CHARS` (default 4000) limits this text.

## The fast profile

`ANVIL_PROFILE=fast` gives short and cheap builds: 1 evolve round, an evaluation budget of 0.25 USD, 2 harness attempts, and shorter timeouts. A variable that you set still wins. `PROFILES` in `src/core/config.ts` has the values.
