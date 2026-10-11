# Programmatic tool calling and the Python sandbox

**Goal:** an agent writes one Python program that calls Anvil tools and processes the data. Only the result goes back into the context of the model. The program runs in a Docker container that has no internet access.

## 1. Architecture

```
Anvil server (host)
 ├─ run_code tool / code_agent node
 │    └─ SandboxManager ──docker exec (stdin/stdout)──► sandbox container
 │                                                        ├─ runner.py + anvil SDK
 │                                                        └─ /work (temporary, one for each run)
 ├─ ToolBridge: runs the tool calls of the container with the Anvil rules
 └─ PackageGate: checks packages (OSV) and keeps them in a cache
                         ▲
 anvil-sandbox-net (internal: no route to the internet)
   ├─ sandbox containers
   └─ anvil-gate sidecar ──► PackageGate on the host ──► PyPI or Nexus
```

The container has two ways out:

1. **The tool bridge:** lines on stdin and stdout. It uses no network.
2. **The package gate:** the only address on the internal network. The gate sends the name and the version of a package out, never data.

## 2. Components

### 2.1 Base image (`anvil-sandbox:py312`)

- `python:3.12-slim` with these libraries: pandas, numpy, python-dateutil, beautifulsoup4, lxml, openpyxl, pydantic.
- `runner.py` and the `anvil` SDK are in the image.
- The user is not root (uid 10001).
- `npm run sandbox:build` builds the image.
- If the build stops at "load metadata", the Docker credential helper does not answer. The base image is public, so a Docker config without `credsStore` works: `DOCKER_CONFIG=<a folder with such a config.json> npm run sandbox:build`.

### 2.2 Limits of a container

| Setting | Default |
|---|---|
| File system | Read-only. Only `/work` (512 MB) and `/tmp` are writable. |
| Memory, CPU, processes | 512 MB, 1 CPU, 128 processes. An init process (`--init`) collects dead processes, so they do not fill the limit. |
| Privileges | `--cap-drop ALL`, `no-new-privileges` |
| Time | 60 seconds for each execution |
| Output | 1 MB. More output is cut, with a note. |

### 2.3 Life cycle

- The server keeps 2 containers ready (the pool).
- An agent run gets a container at its first `run_code` call. The next calls of the same run use the same container, so the files in `/work` stay.
- At the end of the run, the container is removed and the pool fills again.
- At start, the server removes old sandbox containers (label `anvil.sandbox`).

### 2.4 Protocol

1. The host starts `runner.py` with `docker exec -i` and sends the program on stdin.
2. A tool call of the program writes one line: `{"type":"call","id":1,"tool":"web_fetch","args":{...}}`.
3. The host runs the tool and writes the answer on stdin: `{"type":"result","id":1,"ok":true,"value":...}`.
4. At the end, the runner writes `{"type":"done","result":...,"stdout":"...","error":null}`.

The `print` output of the program goes to a buffer, not to the protocol.

### 2.5 SDK

```python
from anvil import tools, classes, result

page = tools.web_fetch(url="https://example.com/data")
rows = classes.x_src_rates(base="EUR")
pages = tools.parallel([("web_fetch", {"url": u}) for u in urls])
result({"count": len(rows["rates"])})
```

### 2.6 Tool bridge

Each call from the container goes through the Anvil rules: the tool allowlist of the agent, the paid search budget, robots.txt and block detection, the repeat guard and the call ledger, the approval for side effects, and the cost budget of the run. Secrets never go into the container.

### 2.7 Egress policy

| Rule | Default |
|---|---|
| Domain allowlist | The domains of the source plan, the domains in the request, and the domains that a person approves |
| Requests that send data (POST, PUT, PATCH, DELETE) | A person must approve. Always blocked in evaluation runs. |
| Content scan | A request with an API key, a token, or a secret pattern is blocked. |
| Size | 64 KB of data for each request |
| Audit | Each outbound request is in the timeline: domain, method, size, decision, reason. |

### 2.8 Package gate

1. pip in the container uses only `http://anvil-gate:3141/simple`.
2. The gate gets the package index from PyPI or from Nexus (`ANVIL_PACKAGE_INDEX`).
3. For each version: OSV vulnerability check, allow and deny lists, wheels only (no source packages), and a sha256 check.
4. Approved files stay in a cache (`data/package-cache`).
5. When OSV is not available, the gate blocks the install (fail-closed).

### 2.9 Network modes

| Mode | Effect |
|---|---|
| `isolated` (default) | Only the tool bridge and the package gate |
| `allowlist` | The container can reach allowlisted domains through a proxy |
| `open` | Full internet. Only for development. The UI shows a red warning. |

## 3. Integration

- The `run_code` agent tool and the `code_agent` node class.
- A rule in the IR guide: use `code_agent` or `run_code` for steps with many tool calls, loops, or data processing.
- A harness strategy: `write_code`.
- Usage gets `sandboxSeconds`. The policy gets `maxSandboxSeconds`.
- A `code_agent` step keeps its working program (`ANVIL_CODE_PROGRAM_CACHE`, on by default). The next inputs run the kept program without a model call. When the kept program fails for an input, the model gets the program and the error and writes a fixed program, which is then kept. The key of a kept program changes when the task, the tools, the packages, or the output schema of the step change.
- With kept programs, every value of the task goes to the program as DATA, also a small one. The SDK guide tells the model to read the values from DATA and the date from datetime, so a kept program works for other inputs.

## 4. Tests

- Unit: protocol, SDK, egress rules, package filter (fake PyPI and fake OSV).
- Integration (real Docker): a program calls a tool, `/work` stays between steps, the container goes away at the end of the run.
- Security: direct internet access, a vulnerable package, a source package, a domain that is not allowed, a request with a secret, a write outside `/work`, a fork bomb, a memory overflow, a timeout, secrets in the container environment.
- Benchmark: the same cases with and without the sandbox.
