#!/usr/bin/env tsx
/**
 * Anvil MCP server over stdio — for MCP clients that launch servers as
 * processes (Claude Desktop, Cursor, …).
 *
 * If an Anvil server is already running (ANVIL_URL, default http://127.0.0.1:8787)
 * this proxies it, so agents built here show up in the UI immediately.
 * Otherwise it runs an embedded Anvil on the same data directory.
 *
 * stdout carries the protocol only; all logs go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAnvilMcpServer, localBackend, remoteBackend, type AnvilBackend } from "./runtime/mcpServer.js";
import { guardProcess } from "./runtime/processGuard.js";

guardProcess("mcp");

console.log = (...a: unknown[]) => console.error(...a);

async function pickBackend(): Promise<AnvilBackend> {
  const url = process.env.ANVIL_URL ?? `http://127.0.0.1:${process.env.ANVIL_PORT ?? 8787}`;
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      console.error(`[anvil-mcp] proxying the running Anvil server at ${url}`);
      return remoteBackend(url);
    }
  } catch {
    /* not running */
  }
  console.error("[anvil-mcp] no running server found — starting an embedded Anvil");
  const { createAnvil } = await import("./runtime/anvil.js");
  return localBackend(await createAnvil());
}

const server = createAnvilMcpServer(await pickBackend());
await server.connect(new StdioServerTransport());
