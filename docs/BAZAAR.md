# The Agent Bazaar

A user shares an agent in the Agent Bazaar under the username. Other users add a copy of it to their own agents, and run the copy with their own OpenRouter key.

## Share an agent

1. Open the agent and click **Share**.
2. Give a title, a description, and tags.
3. Click **Share**. The listing shows the current version under your username.

A share is a snapshot of one version:

- It has the steps, the edges, the input schema, the policy, the triggers, and the library classes (`x_…`) that the steps use.
- It has no tests (their inputs can be private), no evaluation, no build history, no run data, and no secret values. A secret is only a name.

A new share of the same agent updates its listing. Only the owner can remove a listing. The copies of other users stay.

The Bazaar refuses two kinds of agents:

| Agent | Reason |
|---|---|
| An agent that calls other saved agents (`subagent`, `map` with mode `agent`, the `call_agent` tool) | The copy cannot call the agents of the owner. |
| An agent with a class of an MCP server | Other users cannot reach the MCP server of the owner. |

## Add an agent

1. Open **Agent Bazaar** and select a listing. The page shows the graph, the input fields, and the classes that come with it.
2. Click **Add to my agents**. The agent opens in your workspace.

The copy is yours: a later change of the owner does not change it. Its triggers start off: turn one on when you want the agent to run on its own with your key. Its classes go into your Node Library. A class with a side effect starts unapproved: approve it in the Node Library before it can change anything. When you already have a class with the same name and other content, the copy gets a free name (`x_name_2`) and the steps use it.

## The API

| Method and path | Use |
|---|---|
| `GET /api/bazaar?q=&sort=new\|popular&mine=true` | The listings |
| `GET /api/bazaar/:id` | One listing with its spec |
| `POST /api/bazaar` | `{agentId, version?, title?, description?, tags?}`: share |
| `DELETE /api/bazaar/:id` | Remove your listing |
| `POST /api/bazaar/:id/use` | Add a copy to your workspace → `{agentId, classes}` |

The listings are in `data/bazaar/listings.json`. The local Anvil has a Bazaar too, with the owner `local`.
