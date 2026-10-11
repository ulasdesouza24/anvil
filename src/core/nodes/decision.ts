import { z } from "zod";
import type { NodeClass } from "../registry.js";
import type { Answer, JSONSchema, Question } from "../types.js";

const QuestionZ = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    instructions: z.string().min(3),
    criteria: z
      .record(z.string().regex(/^[a-z][a-z0-9_]*$/, "option keys must be snake_case"), z.string())
      .describe("option_key → description of when to pick it (2-255 options; add an 'other' option if the list may be incomplete)"),
  }),
  z.object({
    type: z.literal("score"),
    instructions: z.string().min(3),
    criteria: z.array(z.string()).min(2).max(10).describe("Ordered level descriptions from low (index 0) to high"),
  }),
  z.object({
    type: z.literal("noul"),
    instructions: z.string().min(3).describe("A yes/no question"),
    criteria: z.object({ true: z.string(), false: z.string() }).optional(),
  }),
]);

const DecisionConfig = z.object({
  state: z.unknown().describe('What to judge: a template string or object, e.g. {"ticket": "{{input.text}}"}'),
  questions: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), QuestionZ).describe("Independent questions answered in ONE parallel call"),
  route: z.string().optional().describe("Question id (choice or noul) whose answer selects the output port"),
  minConfidence: z.number().min(0).max(1).optional().describe("If set with route: answers below this confidence go to the 'uncertain' port"),
  yesThreshold: z.number().min(0.05).max(0.95).default(0.5).describe("For noul routing: probability ≥ threshold → 'yes'"),
  escalate: z.boolean().default(false).describe("Re-decide low-confidence answers with the reasoning model (System 2)"),
});
type DecisionConfig = z.infer<typeof DecisionConfig>;

function valueOf(a: Answer | undefined): unknown {
  if (!a) return null;
  if (a.type === "choice") return a.choice;
  if (a.type === "score") return a.score;
  return a.noul;
}

export const DecisionNode: NodeClass<DecisionConfig> = {
  type: "decision",
  title: "Decision (Jev)",
  category: "decision",
  description:
    "Fast, calibrated typed decisions by the System One model (Jev): choice (pick one option), score (ordered scale → number), noul (yes/no → probability). Many questions share one ~0.3s call. Output: {<questionId>: value, answers: {<questionId>: {…probabilities, confidence}}}. With `route`, branches by the answer: choice → one port per option key; noul → ports 'yes'/'no'; plus 'uncertain' if minConfidence is set.",
  whenToUse:
    "Classification, routing, triage, gating, moderation, relevance/quality checks — any step whose answer is one of a known set of values. Much cheaper and faster than asking an LLM, and it returns probabilities.",
  configSchema: DecisionConfig,
  example: {
    state: { message: "{{input.message}}" },
    questions: {
      intent: {
        type: "choice",
        instructions: "What does the customer want?",
        criteria: { refund: "Wants money back", support: "Needs help using the product", other: "Anything else" },
      },
      urgency: { type: "score", instructions: "How urgent is it?", criteria: ["Not urgent", "Soon", "Immediately"] },
      is_angry: { type: "noul", instructions: "Is the customer angry?" },
    },
    route: "intent",
    minConfidence: 0.5,
  },
  defaultRetry: { maxAttempts: 2, backoffMs: 500 },
  ports: (c) => {
    if (!c.route) return ["out"];
    const q = c.questions?.[c.route];
    if (!q) return ["out"];
    const base = q.type === "choice" ? Object.keys(q.criteria) : q.type === "noul" ? ["yes", "no"] : ["out"];
    return c.minConfidence !== undefined && q.type !== "score" ? [...base, "uncertain"] : base;
  },
  outputSchema: (c) => {
    const properties: Record<string, JSONSchema> = { answers: { type: "object" } };
    for (const [id, q] of Object.entries(c.questions ?? {})) {
      properties[id] = q.type === "choice" ? { type: "string", enum: Object.keys(q.criteria) } : { type: "number" };
    }
    if (c.route) properties.route = { type: "string" };
    return { type: "object", properties, required: Object.keys(properties) };
  },
  validate: (c) => {
    const issues: { message: string; path?: string; hint?: string }[] = [];
    for (const id of Object.keys(c.questions ?? {})) {
      if (id === "answers" || id === "route") issues.push({ message: `question id "${id}" is reserved`, path: `/questions/${id}` });
    }
    if (!Object.keys(c.questions ?? {}).length) issues.push({ message: "at least one question is required", path: "/questions" });
    for (const [id, q] of Object.entries(c.questions ?? {})) {
      if (q.type === "choice" && Object.keys(q.criteria).length < 2) issues.push({ message: `choice "${id}" needs at least 2 options`, path: `/questions/${id}/criteria` });
    }
    if (c.route) {
      const q = c.questions?.[c.route];
      if (!q) issues.push({ message: `route "${c.route}" is not a question id`, path: "/route", hint: `Use one of: ${Object.keys(c.questions ?? {}).join(", ")}` });
      else if (q.type === "score") issues.push({ message: "cannot route on a score question; use a choice or noul, or add a router node on the score", path: "/route" });
    }
    return issues;
  },
  async execute(ctx) {
    const c = ctx.config;
    const answers = await ctx.brain.decide({
      purpose: ctx.node.name ?? ctx.node.id,
      state: c.state ?? ctx.input,
      questions: c.questions as Record<string, Question>,
      escalate: c.escalate,
    });
    const output: Record<string, unknown> = { answers };
    for (const id of Object.keys(c.questions)) output[id] = valueOf(answers[id]);
    if (!c.route) return { output };

    const a = answers[c.route];
    let port: string;
    if (a?.type === "choice") {
      port = c.minConfidence !== undefined && a.confidence < c.minConfidence ? "uncertain" : a.choice;
    } else if (a?.type === "noul") {
      const margin = c.minConfidence !== undefined ? c.minConfidence / 2 : 0;
      if (margin && Math.abs(a.noul - c.yesThreshold) < margin) port = "uncertain";
      else port = a.noul >= c.yesThreshold ? "yes" : "no";
    } else port = "out";
    output.route = port;
    return { output, ports: [port] };
  },
};
