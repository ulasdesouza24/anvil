# Triggers: the queue and the webhook security

A trigger starts a run of an agent: a schedule, a webhook, a poll, or the end of another agent. The code is in `src/runtime/triggers.ts` and `src/server/webhooks.ts`.

## The queue

One run of a trigger is active at a time. An event that comes while the run is active does not go away:

1. The event goes into the queue of its trigger. The answer is `202` with `{queued: true, eventId, position}`.
2. When the active run ends, the oldest event of the queue starts.
3. The queue is on disk. After a restart, the server starts the waiting events.
4. A full queue (`ANVIL_TRIGGER_QUEUE_MAX`) rejects the event with `429`. The sender can send it again later.
5. An event that waits longer than `ANVIL_TRIGGER_QUEUE_TTL_MS` does not start a run.

A schedule keeps only one waiting event. A second scheduled event is the same work, so it does not go into the queue.

A poll trigger marks an item as seen when its run starts or when it goes into the queue. A full queue leaves the remaining items for the next check.

## The webhook security

Each webhook trigger has a secret. `GET /api/agents/:id/triggers/:tid/webhook` gives the URL and the secret (`?rotate=true` makes a new secret).

### The signature

A signed request has two headers:

| Header | Value |
|---|---|
| `X-Anvil-Timestamp` | the time of the request, in Unix seconds |
| `X-Anvil-Signature` | `sha256=` and the hex HMAC-SHA256 of `<timestamp>.<raw body>`, with the secret as the key |

The server calculates the signature of the raw body. A changed body or a wrong secret gives `401`.

### The replay protection

- A timestamp outside `ANVIL_WEBHOOK_TOLERANCE_MS` (default 5 minutes) gives `401`.
- The server keeps each signature for two times the window. The same signed request again gives `409`.

### The dedupe

A sender can give a delivery id in a header: `Idempotency-Key`, `X-Anvil-Delivery`, `X-Request-Id`, `X-GitHub-Delivery`, `Webhook-Id`, or `X-Webhook-Id` (`ANVIL_WEBHOOK_ID_HEADERS`). The same id again in `ANVIL_WEBHOOK_DEDUPE_TTL_MS` (default 24 hours) does not start a second run. The answer is `200` with `{duplicate: true, runId}`.

### The auth mode

`ANVIL_WEBHOOK_AUTH` sets what the server accepts:

| Value | Accepted |
|---|---|
| `either` (default) | a signed request, or the secret in `X-Anvil-Token` or `Authorization: Bearer` |
| `hmac` | only a signed request |
| `token` | only the secret in a header |

The URL never carries the secret: the server does not read `?token=` on a webhook. Use `hmac` when the sender can sign. A token header has no replay protection, so use a delivery id with it.

### The body limit

A body larger than `ANVIL_WEBHOOK_MAX_BODY_BYTES` (default 1 MB) gives `413`. A JSON body that is not valid gives `400`.

## The API token in a URL

`ANVIL_API_TOKEN` comes in the `Authorization: Bearer` header or the `X-Anvil-Token` header. Only an event stream (`/events`) accepts `?token=`, because a browser EventSource cannot send headers.

## Example

```bash
SECRET=...; BODY='{"order":42}'; TS=$(date +%s)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')"
curl -X POST http://127.0.0.1:8787/api/hooks/my-agent/in \
  -H 'Content-Type: application/json' -H "X-Anvil-Timestamp: $TS" -H "X-Anvil-Signature: $SIG" \
  -H 'Idempotency-Key: order-42' -d "$BODY"
```
