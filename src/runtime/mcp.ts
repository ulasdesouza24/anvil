import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { CustomClassDef, McpCaller } from "../core/customClass.js";
import type { JSONSchema } from "../core/types.js";
import type { FileStore } from "../store/fileStore.js";
import type { ClassManager } from "./classes.js";

/**
 * MCP hub: connects Anvil to external MCP servers and turns every tool they
 * expose into a custom node class (x_mcp_<server>_<tool>) — so agents, the
 * architect and the composer can use any MCP tool like a built-in class.
 *
 * Credentials never live in the config: env values and headers may reference
 * ${ENV_VAR}, resolved from the process environment at connect time.
 */

export const McpServerConfigZ = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,23}$/, "server name must be snake_case (max 24 chars)"),
  transport: z.enum(["stdio", "http"]),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigZ>;

export interface McpServerStatus {
  config: McpServerConfig;
  connected: boolean;
  tools: { name: string; type: string; description?: string; readOnly: boolean; approved: boolean }[];
  error?: string;
  serverInfo?: { name?: string; version?: string };
}

interface Connection {
  client: Client;
  tools: McpTool[];
  serverInfo?: { name?: string; version?: string };
}

interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

const NS = "mcp_servers";

function expandVars(v: string, env: Record<string, string | undefined>): string {
  return v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => {
    const val = env[name];
    if (val === undefined) throw new Error(`environment variable ${name} is not set (add it to .env)`);
    return val;
  });
}

export function classTypeFor(server: string, tool: string): string {
  const base = `x_mcp_${server}_${tool}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/_$/, "");
  if (base.length <= 48) return base;
  const hash = crypto.createHash("sha1").update(`${server}/${tool}`).digest("hex").slice(0, 6);
  return `${base.slice(0, 41)}_${hash}`;
}

/** Converts an MCP tool into a custom class definition. */
export function toolToClassDef(server: string, t: McpTool): Record<string, unknown> {
  const readOnly = t.annotations?.readOnlyHint === true;
  const input = t.inputSchema && typeof t.inputSchema === "object" ? { ...t.inputSchema, type: "object" } : { type: "object", properties: {} };
  if (!input.properties) (input as JSONSchema).properties = {};
  const structured = !!(t.outputSchema && (t.outputSchema as JSONSchema).type === "object" && (t.outputSchema as JSONSchema).properties);
  const outputSchema = structured
    ? t.outputSchema!
    : {
        type: "object",
        properties: {
          text: { type: "string", description: "Text content returned by the tool" },
          json: { description: "The text parsed as JSON when possible" },
          structured: {},
          content: { type: "array" },
        },
      };
  const title = t.title ?? t.annotations?.title ?? t.name;
  return {
    type: classTypeFor(server, t.name),
    title: `${title} (${server})`.slice(0, 80),
    category: "tool",
    description: `MCP tool "${t.name}" from the "${server}" server. ${t.description ?? ""}`.trim().slice(0, 800),
    whenToUse: `When the agent needs "${t.name}" from ${server}${t.description ? `: ${t.description.split(/[.\n]/)[0].slice(0, 160)}` : ""}.`,
    configSchema: input,
    outputSchema,
    example: {},
    sideEffects: !readOnly,
    secrets: [],
    impl: { kind: "mcp", server, tool: t.name, structured },
    tests: [],
    createdBy: `mcp:${server}`,
    status: "untested",
  };
}

export interface McpHubOptions {
  store: FileStore;
  classes: ClassManager;
  /** Injectable transport factory (tests use in-memory transports). */
  createTransport?: (cfg: McpServerConfig) => Transport | Promise<Transport>;
  env?: Record<string, string | undefined>;
}

export class McpHub {
  private conns = new Map<string, Connection>();
  private errors = new Map<string, string>();
  private connecting = new Map<string, Promise<Connection>>();

  constructor(private opts: McpHubOptions) {}

  private get env() {
    return this.opts.env ?? process.env;
  }

  async configs(): Promise<McpServerConfig[]> {
    const raw = await this.opts.store.list(NS);
    return Object.values(raw).map((c) => McpServerConfigZ.parse(c));
  }

  async config(name: string): Promise<McpServerConfig | undefined> {
    const raw = await this.opts.store.get(NS, name);
    return raw ? McpServerConfigZ.parse(raw) : undefined;
  }

  private async transportFor(cfg: McpServerConfig): Promise<Transport> {
    if (this.opts.createTransport) return this.opts.createTransport(cfg);
    if (cfg.transport === "stdio") {
      if (!cfg.command) throw new Error("stdio servers need a command");
      const env = { ...getDefaultEnvironment(), ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, expandVars(v, this.env)])) };
      return new StdioClientTransport({ command: cfg.command, args: cfg.args, env, stderr: "ignore" });
    }
    if (!cfg.url) throw new Error("http servers need a url");
    const headers = Object.fromEntries(Object.entries(cfg.headers).map(([k, v]) => [k, expandVars(v, this.env)]));
    return new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers } });
  }

  /** Connect (once) to a configured server. */
  async connect(name: string): Promise<Connection> {
    const existing = this.conns.get(name);
    if (existing) return existing;
    const pending = this.connecting.get(name);
    if (pending) return pending;
    const p = (async () => {
      const cfg = await this.config(name);
      if (!cfg) throw new Error(`MCP server "${name}" is not configured`);
      if (!cfg.enabled) throw new Error(`MCP server "${name}" is disabled`);
      const client = new Client({ name: "anvil", version: "1.0.0" });
      client.onerror = (e) => this.errors.set(name, e.message);
      const transport = await this.transportFor(cfg);
      transport.onclose = () => this.conns.delete(name);
      await client.connect(transport, { timeout: 30_000 });
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
        tools.push(...(page.tools as McpTool[]));
        cursor = page.nextCursor;
      } while (cursor);
      const conn: Connection = { client, tools, serverInfo: client.getServerVersion() };
      this.conns.set(name, conn);
      this.errors.delete(name);
      return conn;
    })();
    this.connecting.set(name, p);
    try {
      return await p;
    } catch (e) {
      this.errors.set(name, (e as Error).message);
      throw e;
    } finally {
      this.connecting.delete(name);
    }
  }

  async disconnect(name: string) {
    const c = this.conns.get(name);
    this.conns.delete(name);
    await c?.client.close().catch(() => undefined);
  }

  /** (Re)connect and sync the server's tools into the class library. Returns the class types. */
  async sync(name: string): Promise<{ added: string[]; updated: string[]; removed: string[]; failed: { tool: string; error: string }[] }> {
    await this.disconnect(name);
    const conn = await this.connect(name);
    const before = new Set(
      this.opts.classes
        .list()
        .filter((c) => c.impl.kind === "mcp" && c.impl.server === name)
        .map((c) => c.type),
    );
    const added: string[] = [];
    const updated: string[] = [];
    const failed: { tool: string; error: string }[] = [];
    for (const t of conn.tools) {
      const def = toolToClassDef(name, t);
      const type = String(def.type);
      const r = await this.opts.classes.save(def, { test: false, createdBy: `mcp:${name}` });
      if (!r.def) {
        failed.push({ tool: t.name, error: r.diagnostics.map((d) => d.message).join("; ") });
        continue;
      }
      (before.has(type) ? updated : added).push(type);
      before.delete(type);
    }
    // Tools the server no longer offers: remove unless an agent still uses them.
    const removed: string[] = [];
    for (const type of before) {
      if (!this.opts.classes.usedBy(type).length && (await this.opts.classes.remove(type))) removed.push(type);
    }
    return { added, updated, removed, failed };
  }

  async addServer(raw: unknown) {
    const cfg = McpServerConfigZ.parse(raw);
    if (cfg.transport === "stdio" && !cfg.command) throw new Error("stdio servers need a command");
    if (cfg.transport === "http" && !cfg.url) throw new Error("http servers need a url");
    await this.opts.store.set(NS, cfg.name, cfg);
    try {
      return await this.sync(cfg.name);
    } catch (e) {
      throw new Error(`Saved, but could not connect: ${(e as Error).message}`);
    }
  }

  async removeServer(name: string, force = false) {
    const types = this.opts.classes
      .list()
      .filter((c) => c.impl.kind === "mcp" && c.impl.server === name)
      .map((c) => c.type);
    const used = types.flatMap((t) => this.opts.classes.usedBy(t).map((a) => `${a} (${t})`));
    if (used.length && !force) throw Object.assign(new Error(`Tools of "${name}" are used by: ${used.join(", ")}`), { status: 409 });
    await this.disconnect(name);
    for (const t of types) await this.opts.classes.remove(t);
    await this.opts.store.delete(NS, name);
  }

  /** Approve every side-effecting tool of a server at once. */
  async approveAll(name: string, approved = true): Promise<number> {
    let n = 0;
    for (const c of this.opts.classes.list()) {
      if (c.impl.kind === "mcp" && c.impl.server === name && c.sideEffects && c.approved !== approved) {
        await this.opts.classes.approve(c.type, approved);
        n++;
      }
    }
    return n;
  }

  call: McpCaller = async (server, tool, args, signal) => {
    let conn: Connection;
    try {
      conn = await this.connect(server);
    } catch (e) {
      throw new Error(`MCP server "${server}" unavailable: ${(e as Error).message}`);
    }
    const res = await conn.client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: 120_000 });
    return res as { content?: unknown[]; structuredContent?: unknown; isError?: boolean };
  };

  async status(): Promise<McpServerStatus[]> {
    const classes = this.opts.classes.list().filter((c): c is CustomClassDef & { impl: { kind: "mcp"; server: string; tool: string } } => c.impl.kind === "mcp");
    return (await this.configs()).map((config) => {
      const conn = this.conns.get(config.name);
      return {
        config: {
          ...config,
          env: Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, /\$\{/.test(v) ? v : "•••"])),
          headers: Object.fromEntries(Object.entries(config.headers).map(([k, v]) => [k, /\$\{/.test(v) ? v : "•••"])),
        },
        connected: !!conn,
        serverInfo: conn?.serverInfo,
        error: this.errors.get(config.name),
        tools: classes
          .filter((c) => c.impl.server === config.name)
          .map((c) => ({ name: c.impl.tool, type: c.type, description: c.description, readOnly: !c.sideEffects, approved: c.approved })),
      };
    });
  }

  /** Connect enabled servers in the background at boot (tools are already registered from disk). */
  async connectAll() {
    for (const c of await this.configs()) if (c.enabled) void this.connect(c.name).catch(() => undefined);
  }

  async closeAll() {
    for (const name of [...this.conns.keys()]) await this.disconnect(name);
  }
}
