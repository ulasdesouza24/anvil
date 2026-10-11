# Send the results

An agent can send its result to Slack, by email, or to a webhook. The builder adds a send step only when the request asks to send, post, email, or notify. The code is in `src/core/nodes/send.ts`.

| Step | What it does | Secrets |
|---|---|---|
| `send_slack` | posts `text` to a Slack channel with an incoming webhook | `SLACK_WEBHOOK_URL` (another name with `webhookSecret`) |
| `send_email` | sends `subject` and `text` (and `html`) to `to` over SMTP | `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_SECURE` (true for 465). Another prefix with `smtp`. |
| `send_webhook` | sends `body` as JSON to `url`, or to the URL of the secret `urlSecret` | header values can name secrets: `Bearer ${NAME}` |

## Rules

- A config names a secret. It never has a webhook URL with a key, a server password, or a token. Enter the secrets on the Connections page (docs/SECRETS.md) or in `.env`.
- The steps have side effects. The compiler warns when no `human_approval` step comes before them.
- An evaluation run (tests, evolve, a health check) does not send. The step gives `{"sent": false, "dryRun": true, "preview": ...}`.
- A closed build (docs/TOOLS.md) cannot use them.
- A missing secret stops the step with the name to set. An HTTP error stops the step with the status.
- The Connections page lists the secrets that the send steps of your agents need.

## Example: send the BIST summary to Slack

1. In Slack, make an incoming webhook for the channel.
2. On the Connections page, save the secret `SLACK_WEBHOOK_URL` with the webhook URL.
3. Build: "Find the BIST 100 stocks with the best opening today and send a short summary to Slack."
4. Run the agent. The output has `"sent": true`, and the message is in the channel.
