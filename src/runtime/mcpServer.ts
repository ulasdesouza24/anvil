import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JSONSchema } from "../core/types.js";
import type { Anvil } from "./anvil.js";

/**
 * Anvil as an MCP server: every published agent becomes a tool, plus meta-tools
 * that let an MCP client (Claude Code, Claude Desktop, Cursor…) build, refine
 * and run agents. Works over a backend so the same server can run in-process
 * (HTTP endpoint) or proxy a running Anvil instance (stdio entry point).
 */

export interface AgentToolInfo {
  id: string;
  name: string;
  description: string;
  inputSchema: JSONSchema;
  score: number | null;
  sideEffects: boolean;
}

export interface RunResult {
  runId: string;
  status: string;
  output?: unknown;
  error?: string;
  costUsd?: number;
}

export interface AnvilBackend {
  listAgents(): Promise<AgentToolInfo[]>;
  runAgent(agentId: string, input: unknown): Promise<RunResult>;
  build(req: { request: string; evaluate?: boolean; optimize?: boolean; maxCostUsd?: number }): Promise<RunResult>;
  refine(agentId: string, instruction: string): Promise<RunResult>;
}

const META_TOOLS = ["anvil_build", "anvil_refine", "anvil_list_agents", "anvil_run_agent"];

/** Tool names must be unique and ≤ 64 chars of [a-zA-Z0-9_-]. */
export const toolNameFor = (agentId: string) => agentId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);

export function createAnvilMcpServer(backend: AnvilBackend): Server {
  const server = new Server(
    { name: "anvil", version: "1.0.0" },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        "Anvil builds, tests and runs AI agents. Call anvil_list_agents to see available agents (each is also a tool), anvil_build to create a new agent from a plain-language description, anvil_refine to change one.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const agents = await backend.listAgents();
    return {
      tools: [
        {
          name: "anvil_build",
          title: "Build a new agent",
          description:
            "Design, compile, test and publish a new Anvil agent from a plain-language description of a process (inputs, outputs, rules). Takes 1-5 minutes. Returns the new agent's id and test score; the agent then appears as its own tool.",
          inputSchema: {
            type: "object" as const,
            properties: {
              request: { type: "string", description: "What the agent should do" },
              evaluate: { type: "boolean", description: "Synthesize and run tests (default true)" },
              optimize: { type: "boolean", description: "Improve the agent from failing tests (default false for speed)" },
              maxCostUsd: { type: "number", description: "Do not build when the cost estimate is above this value (default 2)" },
            },
            required: ["request"],
          },
          annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        },
        {
          name: "anvil_refine",
          title: "Change an agent",
          description: "Apply a plain-language change to an existing agent; it is recompiled, re-tested and published as a new version.",
          inputSchema: { type: "object" as const, properties: { agentId: { type: "string" }, instruction: { type: "string" } }, required: ["agentId", "instruction"] },
          annotations: { readOnlyHint: false, destructiveHint: false },
        },
        {
          name: "anvil_list_agents",
          title: "List agents",
          description: "List the agents available in Anvil with their inputs and test scores.",
          inputSchema: { type: "object" as const, properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: "anvil_run_agent",
          title: "Run an agent by id",
          description: "Run any Anvil agent by id with an input object (useful for agents created during this session).",
          inputSchema: { type: "object" as const, properties: { agentId: { type: "string" }, input: { type: "object" } }, required: ["agentId"] },
          annotations: { readOnlyHint: false, openWorldHint: true },
        },
        ...agents
          .filter((a) => !META_TOOLS.includes(toolNameFor(a.id)))
          .map((a) => ({
            name: toolNameFor(a.id),
            title: a.name,
            description: `${a.description}${a.score !== null ? ` (Anvil test score ${Math.round(a.score * 100)}/100)` : ""}`.slice(0, 1000),
            inputSchema: { ...(a.inputSchema as Record<string, unknown>), type: "object" as const },
            annotations: { readOnlyHint: !a.sideEffects, openWorldHint: true },
          })),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const reply = (r: RunResult | Record<string, unknown>, isError = false) => ({
      content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }],
      structuredContent: r as Record<string, unknown>,
      isError,
    });
    try {
      switch (name) {
        case "anvil_list_agents": {
          const agents = await backend.listAgents();
          return reply({
            agents: agents.map((a) => ({
              id: a.id,
              tool: toolNameFor(a.id),
              name: a.name,
              description: a.description,
              inputs: Object.keys(a.inputSchema.properties ?? {}),
              score: a.score,
            })),
          });
        }
        case "anvil_build": {
          const r = await backend.build({
            request: String(args.request ?? ""),
            evaluate: args.evaluate !== false,
            optimize: args.optimize === true,
            maxCostUsd: typeof args.maxCostUsd === "number" ? args.maxCostUsd : undefined,
          });
          return reply(r, r.status !== "completed");
        }
        case "anvil_refine": {
          const r = await backend.refine(String(args.agentId ?? ""), String(args.instruction ?? ""));
          return reply(r, r.status !== "completed");
        }
        case "anvil_run_agent": {
          const r = await backend.runAgent(String(args.agentId ?? ""), args.input ?? {});
          return reply(r, r.status !== "completed");
        }
        default: {
          const agent = (await backend.listAgents()).find((a) => toolNameFor(a.id) === name);
          if (!agent) return reply({ error: `Unknown tool "${name}"` }, true);
          const r = await backend.runAgent(agent.id, args);
          if (r.status !== "completed") return reply(r, true);
          const out = r.output;
          return {
            content: [{ type: "text" as const, text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }],
            ...(out && typeof out === "object" && !Array.isArray(out) ? { structuredContent: out as Record<string, unknown> } : {}),
          };
        }
      }
    } catch (e) {
      return reply({ error: (e as Error).message }, true);
    }
  });

  return server;
}

/* -------------------------------- backends -------------------------------- */

/** In-process backend (used by the HTTP /mcp endpoint inside the Anvil server). */
export function localBackend(anvil: Anvil): AnvilBackend {
  const { store, runs, registry } = anvil;
  const toResult = (r: { id: string; status: string; output?: unknown; error?: string; usage?: { costUsd: number } }): RunResult => ({
    runId: r.id,
    status: r.status,
    output: r.output,
    error: r.error,
    costUsd: r.usage?.costUsd,
  });
  return {
    async listAgents() {
      return store
        .listAgents()
        .filter((a) => !a.system)
        .map((a) => {
          const v = a.versions.find((x) => x.version === a.currentVersion)!;
          const sideEffects = v.spec.nodes.some((n) => {
            const cls = registry.get(n.type);
            try {
              return !!cls?.sideEffects?.(n.config as never);
            } catch {
              return false;
            }
          });
          return { id: a.id, name: a.name, description: a.description, inputSchema: v.spec.inputSchema as JSONSchema, score: v.evaluation?.score ?? v.score ?? null, sideEffects };
        });
    },
    async runAgent(agentId, input) {
      if (!store.getAgent(agentId) || store.getAgent(agentId)?.system) return { runId: "", status: "failed", error: `agent "${agentId}" not found` };
      return toResult(await runs.run({ agentId }, input, { kind: "run" }));
    },
    async build(req) {
      // An MCP client cannot answer an approval. The build never asks and stops above the limit.
      const r = await runs.run(
        { agentId: "anvil-builder" },
        { request: req.request, clarify: false, evaluate: req.evaluate ?? true, optimize: req.optimize ?? false, askOnCost: false, confirmAboveUsd: req.maxCostUsd ?? 2 },
        { kind: "build" },
      );
      return { ...toResult(r), output: r.output };
    },
    async refine(agentId, instruction) {
      return toResult(await runs.run({ agentId: "anvil-refiner" }, { agentId, instruction, optimize: false }, { kind: "refine" }));
    },
  };
}

/** Backend that drives a running Anvil server over its REST API (used by the stdio entry point). */
export function remoteBackend(baseUrl: string): AnvilBackend {
  const j = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok && res.status !== 422) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  };
  const waitRun = async (runId: string): Promise<RunResult> => {
    for (;;) {
      const r = await j<{ id: string; status: string; output?: unknown; error?: string; usage?: { costUsd: number } }>(`/api/runs/${runId}`);
      if (!["running", "waiting", "queued"].includes(r.status)) return { runId, status: r.status, output: r.output, error: r.error, costUsd: r.usage?.costUsd };
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  };
  return {
    async listAgents() {
      const list = await j<{ id: string; name: string; description: string; system: boolean; score: number | null }[]>("/api/agents");
      const out: AgentToolInfo[] = [];
      for (const a of list.filter((x) => !x.system)) {
        const full = await j<{ currentVersion: number; versions: { version: number; spec: { inputSchema: JSONSchema } }[] }>(`/api/agents/${a.id}`);
        const spec = full.versions.find((v) => v.version === full.currentVersion)?.spec;
        out.push({ id: a.id, name: a.name, description: a.description, inputSchema: spec?.inputSchema ?? { type: "object", properties: {} }, score: a.score, sideEffects: false });
      }
      return out;
    },
    async runAgent(agentId, input) {
      const r = await j<{ runId: string; status: string; output?: unknown; error?: string; usage?: { costUsd: number } }>(`/api/agents/${agentId}/run`, {
        method: "POST",
        body: JSON.stringify({ input, wait: true }),
      });
      return { runId: r.runId, status: r.status, output: r.output, error: r.error, costUsd: r.usage?.costUsd };
    },
    async build(req) {
      const { runId } = await j<{ runId: string }>("/api/build", {
        method: "POST",
        body: JSON.stringify({
          request: req.request,
          clarify: false,
          evaluate: req.evaluate ?? true,
          optimize: req.optimize ?? false,
          askOnCost: false,
          confirmAboveUsd: req.maxCostUsd ?? 2,
        }),
      });
      return waitRun(runId);
    },
    async refine(agentId, instruction) {
      const { runId } = await j<{ runId: string }>(`/api/agents/${agentId}/refine`, { method: "POST", body: JSON.stringify({ instruction }) });
      return waitRun(runId);
    },
  };
}
