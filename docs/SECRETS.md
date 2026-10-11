# Secrets in the UI

A person enters API keys, tokens, and host headers on the Connections page. The code is in `src/runtime/secrets.ts`.

## Set the key

1. Make a key: `openssl rand -hex 32`.
2. Put it in `.env`: `ANVIL_SECRETS_KEY=<the key>`. A passphrase also works: scrypt makes it into a key.
3. Start Anvil again.

Without the key, the Connections page shows the secrets of `.env` only, and the forms are off. Keep the key in a safe place. Without it, nobody can read the file.

## How it works

| Part | What it does |
|---|---|
| Storage | `data/secrets.enc.json`, encrypted with AES-256-GCM. The file mode is 0600. |
| Start | the values go into the environment of the process. Classes (`{{secrets.NAME}}`), host headers (`${NAME}`), and the sandbox read them as before. |
| Host headers | host → header → template. A template names a secret: `Authorization: Bearer ${GITHUB_TOKEN}`. A header of the UI wins over `ANVIL_HOST_HEADERS` for the same host. A literal credential in a header is rejected: save it as a secret. |
| Masking | run events, outputs, and errors never show the value of a secret variable (a name with KEY, TOKEN, SECRET, or PASSWORD, and a value of 12 characters or more). The value becomes `[secret]`. |
| API | the API never gives a value back. It gives the name, the source (`ui` or `env`), and the last 4 characters. |
| Needed secrets | the page lists the secrets that classes and host headers name, but that have no value. |

`ANVIL_SECRETS_KEY` and `ANVIL_API_TOKEN` stay in `.env`: the UI cannot set them.

## Example: the GitHub API without a rate limit

1. Save the secret `GITHUB_TOKEN` with your token.
2. Add the host `api.github.com` with the header `Authorization` = `Bearer ${GITHUB_TOKEN}`.
3. Run a GitHub agent again. Its requests now use the token, so the limit is 5000 requests each hour, not 60.

## API

| Call | What it does |
|---|---|
| `GET /api/secrets` | the state: `enabled`, `secrets`, `needed`, `hostHeaders`, `envHostHeaders` |
| `PUT /api/secrets/:name` `{value}` | saves a secret |
| `DELETE /api/secrets/:name` | deletes a secret of the UI |
| `PUT /api/host-headers/:host` `{headers}` | sets the headers of a host. Empty headers remove the host. |
