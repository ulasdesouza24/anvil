# Feedback becomes a test

A person can mark a run output as wrong and write why. The reason becomes a test, so the agent does not make the same mistake again. The code is in `src/runtime/feedback.ts`.

## Steps

1. On the run page, click "Wrong" next to the output. Write what is wrong. You can also write the expected output.
2. Anvil changes the reason into 1 to 3 criteria in STE (one model call). The new test has the input of the run. Its id is `f1`, `f2`, and so on.
3. The test goes into the tests of the current version. No new version is made: tests do not change what the agent does.
4. Click "Improve from feedback" on the agent page. Evolve runs all tests, also the feedback tests, and tries to pass them. It never removes an item of a feedback test.

## API

| Call | What it does |
|---|---|
| `POST /api/runs/:id/feedback` `{reason, expected?}` | saves the feedback and adds its test. Gives `{feedback, test}`. |
| `GET /api/agents/:id/feedback` | lists the feedback of an agent |
| `POST /api/agents/:id/improve` `{rounds?}` | starts evolve. The current version must have a feedback test. |
