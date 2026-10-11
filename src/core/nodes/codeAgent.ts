import { createHash } from "node:crypto";
import { z } from "zod";
import { schemaErrors } from "../../llm/brain.js";
import type { ChatMessage } from "../../llm/openrouter.js";
import type { NodeClass } from "../registry.js";
import type { JSONSchema } from "../types.js";
import { AGENT_TOOL_NAMES, getTool } from "../tools/agentTools.js";
import { runProgram } from "../tools/codeBridge.js";
import { JsonSchemaField, ModelField, pickModel } from "./common.js";

/**
 * The code agent (docs/SANDBOX.md, section 3): the model writes one Python
 * program for the task, and the program runs in the sandbox. When the program
 * fails, the model gets the error and writes a fixed program. Only the result
 * of the program goes into the output, not the data that the tools returned.
 */

const CodeAgentConfig = z.object({
  task: z.string().min(1).describe("What the program must do, with templates for data"),
  tools: z
    .array(z.enum(AGENT_TOOL_NAMES.filter((t) => t !== "run_code") as [string, ...string[]]))
    .default([])
    .describe("The agent tools that the program can call with tools.<name>(...)"),
  packages: z.array(z.string()).max(10).default([]).describe("Packages to install before the program runs (checked wheels only), for example ['rapidfuzz==3.9.7']"),
  outputSchema: JsonSchemaField.optional().describe("If set, result(...) must match this JSON Schema"),
  maxAttempts: z.number().int().min(1).max(5).default(3).describe("How many times the model can fix a failed program"),
  model: ModelField,
});

const SDK_GUIDE = `Write one Python 3.12 program. It runs in a sandbox without internet.
- Start with: from anvil import tools, classes, install, result
- tools.<name>(**args) calls an agent tool. Only these tools are available:
{{TOOLS}}
- tools.parallel([(name, args), ...]) runs several calls at the same time and returns a list.
- classes.<x_name>(**config) calls a tested class of the Anvil library.
- install("name==version") installs a checked wheel. These are ready: pandas, numpy, beautifulsoup4, lxml, openpyxl, python-dateutil, pydantic.
- DATA is a dict with the structured and large input data of the task. The task names each item, for example DATA["d0"]. Read the data from DATA. Do not copy data into the code. Do not read a DATA item that the task does not name.
- Call result(value) one time with the final value. Only this value comes back. Use JSON types.
- A blocked tool call raises anvil.ToolError with the reason. Handle it, or let the program fail.
- Do not invent data. When the data is not available, put the reason in the result.
- The program runs again later for other inputs. Read each value of the task from DATA, and get the date of today with datetime. Do not write these values into the code.
Reply with only the program in one \`\`\`python block.`;

/** One line for each tool: its arguments and the shape of its return value. */
export function toolSignatures(names: string[]): string {
  if (!names.length) return "  (none)";
  return names
    .map((n) => {
      const t = getTool(n);
      if (!t) return `  - ${n}`;
      const props = Object.keys((t.parameters as { properties?: object }).properties ?? {});
      const req = new Set((t.parameters as { required?: string[] }).required ?? []);
      return `  - tools.${n}(${props.map((p) => (req.has(p) ? p : `${p}?`)).join(", ")}) returns ${t.returns}`;
    })
    .join("\n");
}

/** A short description of a value: its type, its size, and its first item or its keys. */
export function shapeOf(v: unknown): string {
  if (typeof v === "string") return `text of ${v.length} characters`;
  if (Array.isArray(v)) return `a list of ${v.length} items${v.length ? `. First item: ${JSON.stringify(v[0]).slice(0, 200)}` : ""}`;
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    return `an object with ${keys.length} keys: ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", …" : ""}`;
  }
  return JSON.stringify(v);
}

/** A result without data: null, an empty list or object, or an object whose values are all empty. */
export function emptyResult(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") {
    const values = Object.values(v as Record<string, unknown>);
    return values.length === 0 || values.every((x) => x === null || x === undefined || x === "" || (Array.isArray(x) && x.length === 0));
  }
  return false;
}

/** The KV namespace of the working programs of code_agent steps. */
export const PROGRAMS_NS = "code-programs";

/** The largest value that goes into the prompt as text. A larger value goes to the program as DATA. */
export const INLINE_LIMIT = 1500;

/** A structured value: an object or a list, also as JSON text (for example from the json filter). Else null. */
function structured(v: unknown): object | null {
  if (v !== null && typeof v === "object") return v;
  if (typeof v === "string" && /^\s*[[{]/.test(v)) {
    try {
      const parsed = JSON.parse(v);
      return parsed !== null && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolves the templates of the task one by one.
 * - A structured value (an object, a list, or JSON text) always goes to the
 *   program as DATA["dN"], as a parsed object. The task text names it. A small
 *   one also shows its content, a large one only its shape.
 * - Plain text goes into the task text when it is small, and to DATA when it is large.
 * So the program can always read structured data from DATA, and the model does not copy large data.
 */
export function splitTask(raw: string, resolve: (template: string) => unknown, opts: { allData?: boolean } = {}): { prompt: string; data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  let k = 0;
  // A path in plain text gives the program no data. It becomes a template when it names data of the run.
  const { text } = wrapBareRefs(raw, (path) => resolve(`{{${path}}}`) !== undefined);
  const prompt = text.replace(/\{\{[\s\S]*?\}\}/g, (tpl) => {
    const value = resolve(tpl);
    const obj = structured(value);
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
    // A kept program runs again for other inputs: then every value of the input goes to DATA, so the program reads it and does not copy it.
    if (!obj && text.length <= INLINE_LIMIT && !opts.allData) return text;
    const name = `d${k++}`;
    const stored = obj ?? value;
    data[name] = stored;
    const json = JSON.stringify(stored);
    return json.length <= INLINE_LIMIT ? `DATA["${name}"] (its content: ${json})` : `DATA["${name}"] (${shapeOf(stored)})`;
  });
  return { prompt, data };
}

/** A data path in plain text: nodes.<id>.output with an optional field path. */
const BARE_REF = /(?<![\w.{])nodes\.([A-Za-z_][\w-]*)\.output((?:\.[A-Za-z_][\w-]*|\[\d+\])*)/g;

/**
 * Puts a data path that a task names in plain text (for example "the rates are in
 * nodes.fetch.output.rates") into a template, so the program gets the data as DATA.
 * Text in a template stays as it is. `keep` decides for each path (for example: only
 * the ids of the spec). Returns the text and the paths that it wrapped.
 */
export function wrapBareRefs(text: string, keep: (path: string, nodeId: string) => boolean): { text: string; wrapped: string[] } {
  const wrapped: string[] = [];
  const out = text
    .split(/(\{\{[\s\S]*?\}\})/)
    .map((part) =>
      part.startsWith("{{")
        ? part
        : part.replace(BARE_REF, (m, id: string, rest: string) => {
            // A sentence can end after the path: the dot is not part of it.
            const path = `nodes.${id}.output${rest}`.replace(/\.$/, "");
            if (!keep(path, id)) return m;
            wrapped.push(path);
            return `{{${path}}}`;
          }),
    )
    .join("");
  return { text: out, wrapped };
}

/** The Python code in a reply: the first fenced block, or the whole reply. */
export function extractPython(reply: string): string {
  const m = /```(?:python|py)?\s*\n([\s\S]*?)```/i.exec(reply);
  return (m ? m[1] : reply).trim();
}

export const CodeAgentNode: NodeClass<z.infer<typeof CodeAgentConfig>> = {
  type: "code_agent",
  title: "Code agent (Python sandbox)",
  category: "ai",
  description:
    "The model writes one Python program for the task. The program runs in a sandbox without internet, calls the listed tools through the anvil SDK, and returns only its result. Failed programs are fixed and run again. Output: {result, code, attempts, stdout}.",
  whenToUse:
    "Steps with many tool calls, loops, or data processing: read many pages or API responses and combine them, parse and clean data, join tables, compute statistics, or check results in code.",
  configSchema: CodeAgentConfig,
  defaultTimeoutMs: 600_000,
  // The node resolves the templates of the task itself: large values go to the program as DATA.
  lazyFields: ["task"],
  example: {
    task: "Get the rates for {{input.base}} from https://api.frankfurter.app/latest and return the 3 currencies with the lowest rate.",
    tools: ["http_request"],
    model: "balanced",
  },
  outputSchema: (c) => ({
    type: "object",
    properties: { result: (c.outputSchema as JSONSchema) ?? {}, code: { type: "string" }, attempts: { type: "number" }, stdout: { type: "string" }, cached: { type: "boolean" } },
    required: ["result", "code", "attempts"],
  }),
  async execute(ctx) {
    const c = ctx.config;
    const { prompt: task, data } = splitTask(String(c.task), (tpl) => ctx.resolve(tpl), { allData: ctx.brain.config.sandbox.programCache });
    const m = await pickModel(ctx, c.model, task);
    const schema = c.outputSchema as JSONSchema | undefined;
    const install = c.packages.length ? `from anvil import install\ninstall(${c.packages.map((p) => JSON.stringify(p)).join(", ")})\n` : "";
    const messages: ChatMessage[] = [
      { role: "system", content: SDK_GUIDE.replace("{{TOOLS}}", toolSignatures(c.tools)) + (schema ? `\nThe value of result(...) must match this JSON Schema:\n${JSON.stringify(schema)}` : "") },
      { role: "user", content: `TASK:\n${task}\n\nToday is ${new Date().toISOString().slice(0, 10)}.` },
    ];
    let lastError = "";
    // The working program of this step is kept (docs/SANDBOX.md). The next inputs run it again without a model call.
    // The key changes when the task, the tools, the packages, or the output schema change.
    const useCache = ctx.brain.config.sandbox.programCache;
    const cacheKey = `${ctx.spec.id}:${ctx.node.id}:${createHash("sha256")
      .update(JSON.stringify([c.task, c.tools, c.packages, c.outputSchema ?? null]))
      .digest("hex")
      .slice(0, 16)}`;
    const kept = useCache ? ((await ctx.services.kv.get(PROGRAMS_NS, cacheKey)) as { code: string; at: number; runs: number } | undefined) : undefined;
    if (kept?.code) {
      const r = await runProgram(ctx, install + kept.code, { tools: c.tools, data });
      const problems = r.error ? [r.error] : schema ? schemaErrors(schema, r.result) : [];
      // An empty result can be a program that does not fit this input (for example a new format of the page). The model checks it.
      if (!problems.length && emptyResult(r.result)) problems.push("The kept program gave an empty result for this input. Check that it reads the data of this input, in its real format.");
      if (!problems.length) {
        await ctx.services.kv.set(PROGRAMS_NS, cacheKey, { ...kept, runs: (kept.runs ?? 0) + 1 });
        ctx.log("program from the cache: no model call");
        return { output: { result: r.result, code: kept.code, attempts: 0, stdout: r.stdout.slice(0, 4000), cached: true } };
      }
      // The kept program does not work for this input. The model fixes it: this is cheaper than a new program.
      lastError = problems.join("\n").slice(0, 4000);
      ctx.log("the cached program failed: the model fixes it", { error: lastError.slice(0, 500) }, "warn");
      messages.push({ role: "assistant", content: `\`\`\`python\n${kept.code}\n\`\`\`` });
      messages.push({ role: "user", content: `This program worked for earlier inputs, but it failed for this input:\n${lastError}\n\nFind the cause and write the complete fixed program. It must work for all inputs of the task.` });
    }
    for (let attempt = 1; attempt <= c.maxAttempts; attempt++) {
      const reply = await ctx.brain.chat({ purpose: `${ctx.node.name ?? ctx.node.id} · program ${attempt}`, messages, tier: m.tier, model: m.model, temperature: 0.2, maxTokens: 8000 });
      const code = extractPython(reply.content);
      const r = await runProgram(ctx, install + code, { tools: c.tools, data });
      const problems = r.error ? [r.error] : schema ? schemaErrors(schema, r.result) : [];
      // A reply that the token limit cut is a program that copies data. The feedback says how to fix it.
      if (reply.finishReason === "length") problems.unshift("Your reply was too long and the token limit cut it. Keep the program short. Read the input data from DATA. Do not copy data into the code.");
      if (!problems.length) {
        // Only a program that found data is kept: an empty result does not show that the program reads the data correctly.
        if (useCache && !emptyResult(r.result)) await ctx.services.kv.set(PROGRAMS_NS, cacheKey, { code, at: Date.now(), runs: 1 });
        return { output: { result: r.result, code, attempts: attempt, stdout: r.stdout.slice(0, 4000), cached: false } };
      }
      lastError = problems.join("\n").slice(0, 4000);
      ctx.log(`program ${attempt} failed`, { error: lastError.slice(0, 500) }, "warn");
      messages.push({ role: "assistant", content: reply.content });
      messages.push({
        role: "user",
        content: `The program failed:\n${lastError}${r.stdout ? `\n\nIts print output:\n${r.stdout.slice(0, 2000)}` : ""}\n\nFind the cause and write the complete fixed program.`,
      });
    }
    throw new Error(`The program failed ${c.maxAttempts} times. Last error: ${lastError.slice(0, 1000)}`);
  },
};
