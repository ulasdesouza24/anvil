import { z } from "zod";
import type { NodeClass } from "../registry.js";

const ApprovalConfig = z.object({
  title: z.string().default("Approval required"),
  message: z.string().optional(),
  payload: z.unknown().optional().describe("What the human reviews, e.g. {{nodes.draft.output.text}}"),
});

export const HumanApprovalNode: NodeClass<z.infer<typeof ApprovalConfig>> = {
  type: "human_approval",
  title: "Human Approval",
  category: "human",
  description:
    "Pauses the run until a person approves or rejects (optionally editing the payload) in the Anvil UI or via the API. Ports: 'approved', 'rejected'. Output: {approved, comment, payload}.",
  whenToUse: "Before irreversible or external actions (sending emails, posting, paying, calling write APIs) or when stakes are high.",
  configSchema: ApprovalConfig,
  example: { title: "Send this reply?", payload: "{{nodes.draft.output.text}}" },
  ports: () => ["approved", "rejected"],
  outputSchema: () => ({ type: "object", properties: { approved: { type: "boolean" }, comment: { type: "string" }, payload: {} }, required: ["approved"] }),
  async execute(ctx) {
    const c = ctx.config;
    const res = (await ctx.waitForHuman({ kind: "approval", title: c.title, message: c.message, payload: c.payload })) as
      { approved?: boolean; comment?: string; payload?: unknown } | undefined;
    const approved = !!res?.approved;
    return { output: { approved, comment: res?.comment ?? "", payload: res?.payload ?? c.payload }, ports: [approved ? "approved" : "rejected"] };
  },
};

const InputConfig = z.object({
  title: z.string().default("Input needed"),
  message: z.string().optional(),
  questions: z.unknown().describe("Array of question strings (or a template resolving to one)"),
});

export const HumanInputNode: NodeClass<z.infer<typeof InputConfig>> = {
  type: "human_input",
  title: "Human Input",
  category: "human",
  description: "Pauses the run to ask a person one or more questions. Output: {answers: {question: answer}, skipped}. If there are no questions it continues immediately.",
  whenToUse: "Missing information only a person has (preferences, confirmation of assumptions, credentials-free choices).",
  configSchema: InputConfig,
  example: { title: "A few details", questions: ["Which tone should the post have?"] },
  outputSchema: () => ({ type: "object", properties: { answers: { type: "object" }, skipped: { type: "boolean" } }, required: ["answers"] }),
  async execute(ctx) {
    const c = ctx.config;
    const qs = (Array.isArray(c.questions) ? c.questions : c.questions ? [c.questions] : []).map(String).filter(Boolean);
    if (!qs.length) return { output: { answers: {}, skipped: true } };
    const res = (await ctx.waitForHuman({ kind: "input", title: c.title, message: c.message, questions: qs })) as
      { answers?: Record<string, string>; skipped?: boolean } | undefined;
    return { output: { answers: res?.answers ?? {}, skipped: !!res?.skipped || !res?.answers || !Object.values(res.answers).some((a) => String(a).trim()) } };
  },
};
