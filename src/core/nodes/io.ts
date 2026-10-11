import { z } from "zod";
import type { NodeClass } from "../registry.js";

export const InputNode: NodeClass<Record<string, never>> = {
  type: "input",
  title: "Input",
  category: "io",
  description: "Entry point. Emits the agent's input object (validated against the agent's inputSchema). Reference fields as {{input.<field>}} anywhere downstream.",
  whenToUse: "Exactly one per agent, as the first node.",
  configSchema: z.object({}).passthrough() as never,
  example: {},
  outputSchema: (_c, ctx) => ctx.spec.inputSchema,
  async execute(ctx) {
    return { output: ctx.input };
  },
};

export const OutputNode: NodeClass<{ value: unknown }> = {
  type: "output",
  title: "Output",
  category: "io",
  description: "Final result of the agent. `value` is a template object/string built from upstream outputs; it becomes the agent's return value. Put the output node last.",
  whenToUse: "Exactly one per agent (or one per mutually-exclusive branch), at the end.",
  configSchema: z.object({ value: z.unknown().describe('Template object, e.g. {"summary": "{{nodes.write.output.text}}"}') }),
  example: { value: { answer: "{{nodes.answer.output.text}}" } },
  async execute(ctx) {
    return { output: ctx.config.value };
  },
};
