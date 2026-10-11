# Live data sources

Agents that get live data at run time are the most fragile kind: a source can be slow, busy, rate-limited, blocked, or changed.
This page lists what Anvil does about each problem. The code is in `src/core/liveFetch.ts`, `src/builder/sources.ts`, and `src/core/harness.ts`.

## 1. One way to call a source

Every http class, http node, `http_request` tool, page fetch (`fetch_url`, `web_fetch`), poll trigger, and source probe uses `liveFetch`.

| Problem | What liveFetch does | Config |
|---|---|---|
| A network error, a timeout, HTTP 408/425/429/5xx | A GET request gets new attempts, with a backoff that doubles. A POST is not sent again. | `ANVIL_LIVE_RETRIES` (2), `ANVIL_LIVE_BACKOFF_MS` (800) |
| A 429 or 503 with a short Retry-After | It waits for the Retry-After, then tries again. | `ANVIL_LIVE_MAX_RETRY_AFTER_MS` (15000) |
| A long Retry-After (a limit for the hour or the day) | It gives the answer back at once. The harness classifies it as `rate_limited`. | |
| No answer in time | It fails with "timed out after N s: host did not answer". The harness selects the timeout strategies. | the timeout of the class or the node |
| A low anonymous rate limit (for example GitHub: 60 requests an hour) | It sends configured headers to their exact host. A header value can read `.env`. | `ANVIL_HOST_HEADERS` |
| Evolve runs the same tests in each round | In evaluation runs, it caches good GET answers for a short time. | `ANVIL_LIVE_CACHE` (eval, all, off), `ANVIL_LIVE_CACHE_TTL_MS` (600000) |

Example for GitHub (5000 requests an hour instead of 60):

```bash
GITHUB_TOKEN=ghp_...
ANVIL_HOST_HEADERS={"api.github.com":{"Authorization":"Bearer ${GITHUB_TOKEN}"}}
```

The token stays on the host. It never goes into the Python sandbox, and it goes to no other host.

## 2. The source plan

- The probe uses `liveFetch`, so it sees the source as the agent sees it.
- A source that is slower than `ANVIL_SW_SLOW_MS` in the probe gets `ANVIL_SW_SLOW_FACTOR` in its score.
- When no candidate gives the data, the model gets each candidate with the reason it failed and proposes new candidates (`ANVIL_SOURCE_RETRY_ROUNDS`).
- The library keeps the sources that worked and the sources that did not, for each domain (docs/LIBRARY.md).

## 3. At run time

- The harness classifies a failure (`source_blocked`, `rate_limited`, `timeout`, `tool_error`, `no_data`) and selects the next strategy.
- A test that a rate limit stopped has no score. A benchmark case where the environment stopped every test is "not measured".
