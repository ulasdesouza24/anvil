# Consistent agents: pass^k and best-of-N

The practice benchmark showed that the same task can score 0.98 in one build and 0.49 in another. This page tells how Anvil measures the consistency of an agent, and how it selects the best of several builds.

## pass^k

An agent that passes a test only by chance is not ready. With `repeats` (k), the evaluation runs each test k times.

| Field | Meaning |
|---|---|
| `runs`, `passes` (each test) | the runs that counted, and the runs that passed. A run that the environment stopped (for example a rate limit) does not count. |
| `passed` (each test) | true only when every run passed |
| `score` (each test) | the mean score of the runs |
| `passRate` (report) | the share of the tests where every run passed (pass^k) |
| `passAny` (report) | the share of the tests with at least one run that passed |

A failed test shows the details of its first failed run. Each run of a conversation test has its own session, so mock tools start from their start state.

| Variable | Default | Used by |
|---|---|---|
| `ANVIL_EVAL_REPEATS` | 1 | the evaluation rounds of evolve |
| `ANVIL_SELECT_REPEATS` | 3 | the selection of best-of-N |

## Best-of-N with several builder models

Different models make different design mistakes. Anvil builds one candidate with each builder model and publishes the best one. The code is in `src/builder/bestOf.ts`, and the system agent is `anvil-best-of`.

| Step | What happens |
|---|---|
| 1. Model check | Each builder model gets a small JSON request. A model that does not answer is not used, with the reason in the log. The result stays for 30 minutes. |
| 2. Candidates | Each model builds one candidate in parallel, with `publish: false`. The builder model changes only the LLM calls of the builder (analyze, architect, compose, classgen, testgen, critic). Jev, the simulated user, and the run tiers of the agent do not change. A candidate that fails, gives no spec, or takes longer than `ANVIL_CANDIDATE_TIMEOUT_MS` is out, and its build run stops at once: it does not spend more money. When two candidates are ready, the others have `ANVIL_CANDIDATE_GRACE_MS` more: one slow model does not hold the build. |
| 3. Shared suite | The given tests, then the tests of the candidates in turn, without duplicates, at most `ANVIL_SELECT_MAX_TESTS`. The given tests always stay. A candidate runs the given tests, its own tests, and the tests of others whose input fits its input schema. In a test of another candidate, a check on an output field that this candidate does not give is removed: the criteria (the behavior) stay. |
| 4. pass^k | Each candidate runs its tests `ANVIL_SELECT_REPEATS` times. A given test has the weight `ANVIL_SELECT_GIVEN_WEIGHT`. The ranking is the weighted pass^k rate, then the weighted score. |
| 5. Decision | The best candidate wins when no other candidate is within `ANVIL_SELECT_MARGIN` on both the pass^k rate and the score. On the pass^k rate, the margin is at least the share of one test: one test that passes by chance does not decide. Else the judge model decides between the close candidates. |
| 6. Judge | The judge sees each close candidate under a letter in a random order, never the model name. It reads the failed items and the end of each transcript, and weighs the failures: severe (a rule break, an action without confirmation or with a wrong amount, an invented fact), medium (a wrong result or tool argument), light (format, tone, length). A choice more than 2 × the margin below the best scores is not accepted. When the judge does not answer, the best scores win. |
| 7. Publish | The winner is saved with the tests that it ran, `meta.selection`, and `meta.candidates`. The other candidates are not saved. |

### Use

| Where | How |
|---|---|
| Config | `ANVIL_BEST_OF=on`: each build is best-of-N |
| Build API | `POST /api/build` with `candidates`: a number, or `"auto"` for one candidate for each model. 1 is a normal build. |
| Task file | the field `candidates` |
| Benchmark | `npm run bench -- --best-of` (or `--best-of 2`). The report gives the wins of each builder model and the cases that the judge decided. |
| CLI | `anvil models check` checks the builder models and the judge |
| API | `GET /api/models/check` |

| Variable | Default |
|---|---|
| `ANVIL_BUILD_MODELS` | `z-ai/glm-5.3-flash,deepseek/deepseek-v4.1-flash` (minimax/minimax-m3 did not finish in time in the benchmark) |
| `ANVIL_SELECT_JUDGE_MODEL` | `moonshotai/kimi-k3` |
| `ANVIL_SELECT_MARGIN` | 0.05 |
| `ANVIL_SELECT_MAX_TESTS` | 12 |
| `ANVIL_SELECT_GIVEN_WEIGHT` | 2 |
| `ANVIL_CANDIDATE_TIMEOUT_MS` | 1800000 (30 minutes). A conversation build runs each test as many turns. |
| `ANVIL_CANDIDATE_GRACE_MS` | 180000 (3 minutes) |

## Measured

The practice benchmark (`bench/practice.json`, 5 cases, 13 hidden tests, the fast profile):

| | One build (6 runs) | Best-of-3 (3 runs) |
|---|---|---|
| Hidden tests: mean score of each run | 0.813, 0.648, 0.885, 0.768, 0.958, 0.867 | 0.963, 0.902, 0.941 |
| Mean | 0.823 | 0.935 |
| Range (max − min) | 0.310 | 0.061 |
| Cases that meet their expectations | 3/5 to 5/5 | 5/5 in each run |
| Cost of a run | about $0.10 | $1.11 to $1.80 |
| Time of a run | 5 to 12 minutes | about 24 minutes |

The one-build runs come from a time of many fixes, so a part of their spread comes from the fixes. The wins were z-ai/glm-5.3-flash 9 and deepseek/deepseek-v4.1-flash 6. The judge decided 4 of 15 cases. minimax/minimax-m3 did not finish in the grace time.
