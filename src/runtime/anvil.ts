import { loadConfig, type AnvilConfig } from "../core/config.js";
import { createCoreRegistry } from "../core/nodes/index.js";
import type { Registry } from "../core/registry.js";
import { validateSpec } from "../core/validator.js";
import { EXAMPLE_SPEC } from "../builder/guide.js";
import { ANVIL_NODE_CLASSES } from "../builder/nodes.js";
import { AnvilSourcesNode } from "../builder/sources.js";
import { AnvilLibraryNode } from "../builder/library.js";
import { AnvilToolsNode } from "../builder/toolsStep.js";
import { AnvilBestOfNode } from "../builder/bestOf.js";
import { SYSTEM_AGENTS } from "../builder/systemAgents.js";
import type { ModelClient } from "../llm/brain.js";
import { OpenRouterClient } from "../llm/openrouter.js";
import { FileStore } from "../store/fileStore.js";
import { BrowserService } from "./browser.js";
import { SandboxManager } from "./sandbox.js";
import { FileService } from "./files.js";
import { ClassManager } from "./classes.js";
import { CostModel, featuresOf } from "./costModel.js";
import { McpHub, type McpHubOptions } from "./mcp.js";
import { RunManager } from "./runManager.js";
import { SecretService } from "./secrets.js";
import { TriggerManager } from "./triggers.js";

export interface Anvil {
  config: AnvilConfig;
  registry: Registry;
  store: FileStore;
  runs: RunManager;
  client: ModelClient;
  classes: ClassManager;
  triggers: TriggerManager;
  mcp: McpHub;
  browser: BrowserService;
  sandbox: SandboxManager;
  files: FileService;
  /** Secrets and host headers from the UI (docs/SECRETS.md). */
  secrets: SecretService;
}

export function createRegistry(): Registry {
  return createCoreRegistry().register(...ANVIL_NODE_CLASSES, AnvilSourcesNode, AnvilLibraryNode, AnvilToolsNode, AnvilBestOfNode);
}

export async function createAnvil(opts: { config?: Partial<AnvilConfig>; client?: ModelClient; mcpTransport?: McpHubOptions["createTransport"] } = {}): Promise<Anvil> {
  const config = { ...loadConfig(), ...(opts.config ?? {}) };
  const registry = createRegistry();
  const store = new FileStore(config.dataDir).init();
  // Secrets from the UI go into the environment before anything reads it (docs/SECRETS.md).
  const secrets = new SecretService(config.dataDir, process.env.ANVIL_SECRETS_KEY).load();
  const client = opts.client ?? new OpenRouterClient(config);

  // System agents are code-defined; refresh them on every boot. They must compile.
  for (const spec of SYSTEM_AGENTS) {
    const v = validateSpec(spec, registry, { allowInternal: true });
    if (!v.valid)
      throw new Error(
        `System agent ${spec.id} is invalid:\n${v.diagnostics
          .filter((d) => d.severity === "error")
          .map((d) => d.message)
          .join("\n")}`,
      );
    await store.upsertSystemAgent(v.spec!);
  }
  if (!store.getAgent(EXAMPLE_SPEC.id)) await store.saveVersion(EXAMPLE_SPEC, { note: "bundled example" });

  const classes = new ClassManager(store, registry);
  classes.loadAll();
  const costModel = new CostModel(store);
  const mcp = new McpHub({ store, classes, ...(opts.mcpTransport ? { createTransport: opts.mcpTransport } : {}) });
  // The browser starts only when a node uses it for the first time.
  const browser = new BrowserService({
    executablePath: config.browserPath,
    headless: config.browserHeadless,
    maxPages: config.browserMaxPages,
    navTimeoutMs: config.browserNavTimeoutMs,
    domainIntervalMs: config.browserDomainIntervalMs,
    respectRobots: config.browserRespectRobots,
  });
  classes.attach({ browser, mcp: mcp.call });
  // The sandbox starts its containers only when a program runs for the first time.
  const sandbox = new SandboxManager(config.sandbox);
  const files = new FileService(config.dataDir, config.files);
  const runs = new RunManager({ registry, client, store, config, classes, mcp, costModel, browser, sandbox, files });
  // Each finished build is one more sample for the cost estimate.
  runs.onFinished((r) => {
    if (r.agentId !== "anvil-builder" || r.status === "cancelled") return;
    const f = featuresOf(r);
    if (f) void costModel.record(f, r.usage.costUsd);
  });
  // Not started here: only the long-running server schedules; CLI/tests start it explicitly.
  const triggers = new TriggerManager({ store, runs, log: (m) => console.log(m) });
  return { config, registry, store, runs, client, classes, triggers, mcp, browser, sandbox, files, secrets };
}
