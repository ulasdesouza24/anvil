# The hosted Anvil

Anvil runs in two modes:

| Mode | Use | Access | Model key |
|---|---|---|---|
| Local (default) | One person on one machine | Optional API token (`ANVIL_API_TOKEN`) | `OPENROUTER_API_KEY` in `.env`, or the key in Settings |
| Hosted (`ANVIL_HOSTED=on`) | A public site with many users | An account (username and password) | Each user adds an own key in Settings |

## What the hosted mode does

1. **Accounts.** A user signs up with a username and a password. The username is public: the Agent Bazaar shows it. Passwords are scrypt hashes. A session is a signed token (30 days). A password change or "Sign out everywhere" ends all other sessions. Sign-up and sign-in have a rate limit for each client address.
2. **One workspace for each user.** Each account has an own data folder (`data/users/<id>/`): agents, versions, drafts, runs, classes, secrets, files, triggers, and settings. A request runs in the workspace of its user. A run and a trigger keep the workspace of the user that started them.
3. **The key of each user.** Builds and runs use the OpenRouter key of the user. The key is encrypted on disk (AES-256-GCM) and the API gives only its last 4 characters. The server has no key.
4. **The settings of each user.** The Settings page shows each value that a user can change: the System 2 model, the tiers, best-of-N, the System 1 thresholds, budgets, limits, and the library. The System 1 model (Jev) is fixed. A change applies at once to new runs of that user only. The fields are in `src/core/userSettings.ts`.
5. **Secrets of each user.** A secret that a user enters goes to the workspace of that user only. The server keys leave the process environment at the start, so a secret name in a class or a step cannot read them.

## The security boundaries

| Risk | Control |
|---|---|
| A code step escapes to the server | Code steps, code classes, and mock tools run in QuickJS (WebAssembly): no Node, no file system, no network, a time limit, and a 64 MB memory limit. |
| A request reaches the server or its private network (SSRF) | Each `fetch` of the process goes through a guard at connect time. It blocks loopback, private ranges, link-local (the cloud metadata address), CGNAT, and multicast, also after a DNS lookup. |
| A user reads a secret of the server or of another user | Secrets of a workspace are in its own scope. The server keys are not in the environment. |
| A user starts a program on the server | stdio MCP servers are refused: only http MCP servers. |
| A Python program escapes its container | The program runs in gVisor (`runsc`): it talks to a kernel in user space, not to the kernel of the server. The container is read-only, runs as a non-root user, has no capabilities, has memory, CPU, and process limits, and is on an internal network with no route to the internet. |
| A bug in Anvil gives a user the Docker socket (root on the server) | Anvil never has the Docker socket. The **Docker guard** has it, with no network. It allows only the calls of the sandbox: a container of the sandbox image with all the settings above and the gVisor runtime, and start, exec, and remove only for sandbox containers. It refuses each other call (other images, host mounts, privileged containers, other containers, volumes) and limits the number of sandbox containers on the server. |
| A Python program reaches the private network | The sandbox network is internal. The package proxy (gate) is on an internal network too. In the allowlist mode, the gate refuses private, local, and metadata addresses after the DNS lookup, and a hosted Anvil approves only domain names, never IP addresses. |
| A page in the browser reaches the private network | Chromium runs in its own gVisor container, on an internal network. Each of its requests goes through the guarded proxy of Anvil, which connects only to public addresses on web ports. |
| A browser exploit reaches the data of the users | The browser container has no data, no secrets, and no route to anything but the guarded proxy. |
| A user reads or changes the data of another user | Each request runs in the workspace of its session. A shared agent is a copy. Only the owner can remove a listing. |

## Run the hosted API

The host needs Docker and gVisor. Install gVisor one time (Ubuntu or Debian):

```bash
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list
sudo apt-get update && sudo apt-get install -y runsc
sudo runsc install
sudo systemctl reload docker
```

`systemctl reload docker` reads the new runtime and does not stop the containers that run. Then build the image of the sandbox:

```bash
docker build -t anvil-sandbox:py312 sandbox
```

1. On the server, make two secrets:

   ```bash
   openssl rand -hex 32
   ```

2. Copy `deploy/hosted/.env.example` to `deploy/hosted/.env`, and set `ANVIL_SESSION_SECRET`, `ANVIL_SECRETS_KEY`, `ANVIL_CORS_ORIGINS` (the web address), and `ANVIL_PUBLIC_URL` (the API address).
3. Start the API, the Docker guard, and the browser. The API joins the Docker network of your Caddy (`EDGE_NETWORK`, default `deploy_default`):

   ```bash
   docker compose -f deploy/hosted/compose.yaml up -d --build
   ```

4. Put `deploy/hosted/anvil.caddy` where your Caddyfile imports sites, change the host name, and reload Caddy. Caddy gets the HTTPS certificate.
5. Check the API:

   ```bash
   curl https://<api-host>/api/app
   ```

   The answer is `{"hosted":true,…}`.

Keep `ANVIL_SECRETS_KEY` safe. Without it, the stored keys and secrets of the users cannot be read.

## Run the web app on Vercel

The web app is static. It calls the API at `VITE_API_BASE`.

1. Import the repository in Vercel.
2. Keep the root directory. `vercel.json` sets the build command (`npm run build`), the output (`dist`), and the page routes.
3. Add the environment variable `VITE_API_BASE` with the API address, for example `https://anvil-api.example.com`.
4. Deploy. Add the Vercel address to `ANVIL_CORS_ORIGINS` of the API if it does not match the pattern there.

## The API of accounts and settings

| Method and path | Use |
|---|---|
| `GET /api/app` | Public: is this Anvil hosted |
| `POST /api/auth/register`, `POST /api/auth/login` | `{username, password}` → `{account, token}` |
| `POST /api/auth/logout-all` | End each session of the account |
| `GET /api/me` | The account, the models, the key state, the setting fields, and their values |
| `PUT /api/me/settings` | `{values: {path: value}}`. A `null` value goes back to the default |
| `PUT /api/me/key` | `{apiKey}`. An empty key removes it |
| `PUT /api/me/username`, `PUT /api/me/password` | Change the username, or the password |
| `DELETE /api/me` | `{password}`: delete the account with its agents, runs, files, secrets, settings, key, and Bazaar listings. The copies that other users added stay. |

A hosted webhook URL names the workspace: `/api/hooks/u/<user id>/<agent>/<trigger>`. The MCP endpoint `/mcp` takes the session token as `Authorization: Bearer`.
