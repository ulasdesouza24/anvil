import { z } from "zod";
import { checkAction, specRules } from "../actionGate.js";
import type { NodeClass } from "../registry.js";

/**
 * action_gate (docs/GATE.md): put it before a step that changes something. The "pass" port runs the action,
 * the "block" port gives the reason to a reply step. One Jev call checks the confirmation of the user (in a
 * conversation) and each important rule of the task.
 */
const GateConfig = z.object({
  action: z.string().min(1).describe('What the action does, with its values: "refund {{nodes.check.output.amount}} USD for the order {{nodes.extract.output.order_id}}"'),
  args: z.unknown().optional().describe("The arguments of the action step"),
  facts: z.unknown().optional().describe("The data that the rules need, for example the order from a lookup step"),
  conversation: z.unknown().optional().describe("The turns. Default: the messages of the run input."),
  rules: z.array(z.string()).optional().describe("The rules to check. Default: the important rules of the task."),
  requireConfirmation: z.boolean().optional().describe("Default: true when the run has turns"),
});

export const ActionGateNode: NodeClass<z.infer<typeof GateConfig>> = {
  type: "action_gate",
  title: "Action gate",
  category: "decision",
  description:
    'Checks an action before a step that changes something: in a conversation, the last user message must confirm this action with these values, and the action must keep each important rule of the task. Ports: "pass" (run the action) and "block". Output: {allowed, confirmed, broken, reason}.',
  whenToUse: "Before each step with side effects (a refund, a cancellation, a booking, a sent message) in a conversation agent or an agent with rules.",
  configSchema: GateConfig,
  example: { action: "refund {{nodes.policy.output.amount_usd}} USD for the order {{nodes.extract.output.order_id}}", args: { order_id: "{{nodes.extract.output.order_id}}", amount_usd: "{{nodes.policy.output.amount_usd}}" }, facts: "{{nodes.get_order.output}}" },
  ports: () => ["pass", "block"],
  outputSchema: () => ({
    type: "object",
    properties: { allowed: { type: "boolean" }, confirmed: { type: ["boolean", "null"] }, broken: { type: "array", items: { type: "string" } }, reason: { type: "string" } },
    required: ["allowed", "confirmed", "broken", "reason"],
  }),
  async execute(ctx) {
    const c = ctx.config;
    const r = await checkAction(
      ctx.brain,
      {
        action: c.action,
        args: c.args,
        facts: c.facts,
        conversation: c.conversation ?? (ctx.input as { messages?: unknown } | null | undefined)?.messages,
        rules: c.rules ?? specRules(ctx.spec),
        requireConfirmation: c.requireConfirmation,
      },
      ctx.brain.config.thresholds.actionGate,
    );
    ctx.log(`action gate: ${r.allowed ? "pass" : "block"} — ${r.reason}`, r.probabilities, r.allowed ? "info" : "warn");
    return { output: { allowed: r.allowed, confirmed: r.confirmed, broken: r.broken, reason: r.reason }, ports: [r.allowed ? "pass" : "block"] };
  },
};
