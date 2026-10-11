import { z } from "zod";
import type { NodeClass, NodeContext } from "../core/registry.js";
import type { AgentSpec, JSONSchema } from "../core/types.js";
import { parseToolDefinitions, toolClassDraft } from "../core/toolDefs.js";

/**
 * The given tools of a build (docs/TOOLS.md). With a tool list, the build is
 * closed: the agent gets and changes data only with these tools. It does not
 * search the web, and the source plan does not look for other sources.
 */

/** Node types and agent tools that reach the web. A closed build cannot use them. */
export { CLOSED_NETWORK_NODES as NETWORK_NODE_TYPES, CLOSED_NETWORK_TOOLS as NETWORK_AGENT_TOOLS } from "../core/validator.js";
import { CLOSED_NETWORK_NODES as NETWORK_NODE_TYPES, CLOSED_NETWORK_TOOLS as NETWORK_AGENT_TOOLS } from "../core/validator.js";

export interface GivenToolView {
  /** The class type of the tool: the step type, or a name in "classes" of an agent step. */
  type: string;
  name: string;
  description: string;
  sideEffects: boolean;
  parameters: JSONSchema;
  /** The mock body of a tool: it shows the start data, so testgen can use ids that the tool knows. */
  mock?: string;
}

export interface ToolsOutput {
  closed: boolean;
  tools: GivenToolView[];
}

/** The given tools of a built spec (empty for an open build). */
export const givenToolsOf = (spec: AgentSpec | undefined): string[] => ((spec?.meta?.givenTools as string[] | undefined) ?? []).filter((t) => typeof t === "string");

/**
 * The data that the given tools know, for testgen: the start data of each mock tool, and the result of each
 * read-only tool that needs no arguments (a list of flights, the products). Tests then use real ids.
 */
export async function toolDataPrompt(ctx: NodeContext<any>, t: ToolsOutput | null | undefined, maxChars: number): Promise<string> {
  if (!t?.closed || !t.tools.length) return "";
  const parts: string[] = [];
  for (const x of t.tools) {
    if (x.mock) parts.push(`- ${x.name}: the mock body (its start data is in it): ${x.mock.slice(0, Math.floor(maxChars / t.tools.length))}`);
    const required = ((x.parameters as { required?: string[] }).required ?? []).length;
    if (x.sideEffects || required) continue;
    const cls = ctx.services.registry.get(x.type);
    if (!cls) continue;
    try {
      const r = await cls.execute({ ...ctx, config: {} } as never);
      parts.push(`- ${x.name}() gives: ${JSON.stringify(r.output).slice(0, Math.floor(maxChars / t.tools.length))}`);
    } catch (e) {
      ctx.log(`the tool ${x.name} did not answer a call without arguments: ${(e as Error).message}`, undefined, "warn");
    }
  }
  return parts.length ? `\nDATA THAT THE TOOLS KNOW (use these ids and values in the tests, not invented ones):\n${parts.join("\n")}` : "";
}

/** The prompt section about the given tools, for the analysis, the architect, compose, testgen, and the critic. */
export function toolsPrompt(t: ToolsOutput | null | undefined): string {
  if (!t?.closed || !t.tools.length) return "";
  return `\n\nGIVEN TOOLS (closed build): the agent gets and changes data ONLY with these tools. It does not search the web and uses no other source.
${t.tools.map((x) => `- ${x.type} (the tool "${x.name}"${x.sideEffects ? ", it changes data" : ""}): ${x.description.slice(0, 300)}\n  arguments: ${JSON.stringify(x.parameters).slice(0, 600)}`).join("\n")}
Call a tool as a step with its type, or give the types to an "agent" step in "classes" when the order of the calls depends on the data. Do not use ${NETWORK_NODE_TYPES.join(", ")} steps, and do not give ${NETWORK_AGENT_TOOLS.join(", ")} to agent steps.`;
}

const ToolsConfig = z.object({
  /** The tool definitions: OpenAPI 3, function definitions, or {tools: [...]}, as an object, a list, or text. */
  tools: z.unknown().optional(),
});

export const AnvilToolsNode: NodeClass<z.infer<typeof ToolsConfig>> = {
  type: "anvil_tools",
  title: "Given tools",
  category: "anvil",
  internal: true,
  defaultTimeoutMs: 0,
  description: "Reads the given tool definitions of the build (OpenAPI 3 or function definitions) and saves each tool as a library class. With tools, the build is closed: the agent uses only them.",
  whenToUse: "First step of a build.",
  configSchema: ToolsConfig,
  example: { tools: "{{input.tools}}" },
  async execute(ctx) {
    const raw = ctx.config.tools;
    const none = raw === undefined || raw === null || raw === "" || (Array.isArray(raw) && !raw.length) || (typeof raw === "object" && !Array.isArray(raw) && !Object.keys(raw as object).length);
    if (none) return { output: { closed: false, tools: [] } satisfies ToolsOutput };
    const defs = parseToolDefinitions(raw);
    if (!defs.length) throw new Error("The tool definitions give no tool");
    const classes = ctx.services.classes;
    if (!classes) throw new Error("The class library is not available");
    const tools: GivenToolView[] = [];
    for (const d of defs) {
      const draft = toolClassDraft(d);
      // The tools of the task are given: the class library saves them without a test (a call can change data).
      const saved = await classes.save(draft, { test: false, createdBy: "given" });
      if (!saved.def)
        throw new Error(`The tool "${d.name}" is not valid: ${saved.diagnostics.filter((x) => x.severity === "error").map((x) => x.message).join("; ")}`);
      tools.push({ type: saved.def.type, name: d.name, description: d.description, sideEffects: d.sideEffects, parameters: d.parameters, ...(d.mock ? { mock: d.mock } : {}) });
    }
    const output: ToolsOutput = { closed: true, tools };
    ctx.emit({ type: "artifact", kind: "givenTools", data: output });
    ctx.log(`${tools.length} given tool(s): ${tools.map((t) => t.name).join(", ")} — the build is closed`);
    return { output };
  },
};
