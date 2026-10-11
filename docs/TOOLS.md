# Given tools

A build can come with the tools that its agent must use. Then the build is **closed**: the agent gets and changes data only with these tools. It does not search the web, and the source plan does not look for other sources.

## Formats

The build input `tools` (or the `tools` field of a task file) takes one of these, as an object, a list, JSON text, or YAML text. A task file can also give the path of a JSON or YAML file.

| Format | Example | Becomes |
|---|---|---|
| OpenAPI 3 | `{"openapi": "3.0.0", "servers": [...], "paths": {...}}` | an `http` class for each operation |
| OpenAI functions | `[{"type": "function", "function": {"name", "description", "parameters"}}]` | a `tool` class |
| Anthropic tools | `[{"name", "description", "input_schema"}]` | a `tool` class |
| Plain functions | `[{"name", "description", "parameters"}]` or `{"tools": [...]}` | a `tool` class |

- An OpenAPI operation gets its arguments from the path, query, and header parameters, and `body` for a JSON request body. Local `$ref` values are resolved. `x-base-url` replaces the server URL.
- A function definition can give `sideEffects` (true or false), `endpoint`, `adapter`, `mock`, and `returns`. Without `sideEffects`, a name that starts with a verb such as create, update, delete, cancel, book, or send has side effects.
- Each tool becomes a class `x_tool_<name>_<hash>`. The hash keeps two different tools with the same name apart. Given tools are approved: a person or a platform gave them.

## Call adapters

A `tool` class has no URL of its own. A call adapter does the call (`src/core/toolAdapters.ts`):

| Adapter | What it does | Config |
|---|---|---|
| `http` | POST of the arguments as JSON to the endpoint of the tool, or to `<ANVIL_TOOL_ENDPOINT>/<name>` | `ANVIL_TOOL_ENDPOINT` |
| `mock` | runs the `mock` JS body of the tool with `args` and `state`. The state is kept for each run, so a booking stays booked. Without a body, it gives back the arguments. | |

`ANVIL_TOOL_ADAPTER` selects the adapter for tools that do not name one. A platform can register its own adapter with `registerToolAdapter(name, fn)`. Only this layer depends on the platform.

## The closed build

| Step | What changes |
|---|---|
| Given tools (`anvil_tools`) | reads the definitions and saves the classes |
| Analysis | sees the tools, and has no data needs for the source plan |
| Architect | uses only the given tools as steps, or gives them to an `agent` step in `classes` |
| Compose and the compiler | `CLOSED_TOOLS` rejects web steps (`web_search`, `web_fetch`, `browser`, `http`), web tools of agent steps, and classes that are not given |
| Testgen | writes inputs that the tools can answer, and an input that they do not know |
| Harness | skips the strategies that reach the web |

An `agent` step calls classes as functions: `{"type": "agent", "config": {"task": "...", "classes": ["x_tool_getorder_ab12cd"]}}`. The name of the function is the class type. Its parameters are the config of the class.
