import type { Brain } from "../llm/brain.js";
import type { AgentSpec } from "./types.js";

/**
 * The action gate (docs/GATE.md). An action that changes something (a refund, a cancellation,
 * a booking, a sent message) runs only when one Jev call says yes to each question:
 * - in a conversation: the last user message confirms this action with these values, after the agent stated them;
 * - for each important rule of the task: the action keeps the rule.
 * The structure, not a prompt, stops an action without confirmation or against a rule.
 */

export interface GateRequest {
  /** What the action does, in words: "refund 80 USD for the order A-100". */
  action: string;
  /** The arguments of the call. */
  args?: unknown;
  /** The data that the rules need (for example the order). */
  facts?: unknown;
  /** The turns of the conversation. Without turns, no confirmation is asked (a scheduled agent has no user). */
  conversation?: unknown;
  /** The rules that the action must keep. */
  rules: string[];
  /** Ask for the confirmation of the user. Default: true when the request has turns. */
  requireConfirmation?: boolean;
}

export interface GateResult {
  allowed: boolean;
  /** null: no confirmation was asked. */
  confirmed: boolean | null;
  /** The rules that the action breaks. */
  broken: string[];
  /** One sentence for the user or the trace. */
  reason: string;
  /** The probability of each answer (confirmed, rule_0, ...). */
  probabilities: Record<string, number>;
}

/** The turns of a conversation, or [] when the value is not a conversation. */
export function turnsOf(v: unknown): { role: string; content: string }[] {
  let list = v;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((m): m is { role: string; content: unknown } => !!m && typeof m === "object" && typeof (m as { role?: unknown }).role === "string")
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") }));
}

/** The important rules of the task of a spec (docs/POLICY.md). */
export function specRules(spec: AgentSpec | undefined): string[] {
  const rules = (spec?.meta?.taskSpec as { rules?: { rule: string; important?: boolean }[] } | undefined)?.rules ?? [];
  return rules.filter((r) => r.important && typeof r.rule === "string" && r.rule.trim()).map((r) => r.rule);
}

/** The probability below which an answer of the gate is "no". */
export async function checkAction(brain: Brain, req: GateRequest, threshold: number): Promise<GateResult> {
  const turns = turnsOf(req.conversation);
  const confirm = req.requireConfirmation ?? turns.length > 0;
  const lastUser = [...turns].reverse().find((t) => t.role === "user")?.content ?? null;
  const questions: Record<string, { type: "noul"; instructions: string; criteria: { true: string; false: string } }> = {};
  if (confirm)
    questions.confirmed = {
      type: "noul",
      instructions:
        "Does the LAST user message clearly confirm THIS action with THESE values (the same item and the same amount)? It confirms when the user says yes to the action and the values that the agent stated in an earlier turn, or when the user tells the agent to do this exact action with these exact values. Giving information (an id, an item, a choice between options), a question, or a yes to something else is not a confirmation.",
      criteria: {
        true: "The last user message confirms this exact action and its values.",
        false: "The user did not confirm this exact action, or the values are different, or the agent did not state them first.",
      },
    };
  // A second, narrow question: a message that only gives a fact or picks an option is not a confirmation.
  if (confirm)
    questions.only_information = {
      type: "noul",
      instructions:
        'Does the LAST user message only give information or pick an option (an id, an item, a date, a flight, "it is the sweater"), without a yes to the action and without telling the agent to do it?',
      criteria: { true: "The message only gives information or picks an option.", false: "The message says yes to the action or tells the agent to do it." },
    };
  req.rules.forEach((rule, i) => {
    questions[`rule_${i}`] = {
      type: "noul",
      instructions: `Does this action keep this rule: "${rule}"? Use the facts and the arguments. When the rule is not about this kind of action (for example a rule about payments, and the action only records a note or an outcome), it keeps the rule. A rule that asks for the confirmation of the user (say the values, get a yes) is kept when the last user message confirms this action with its values, also when the agent said them in the turn before. A payment "now" or "today" has the date of today (see "today"). A range of days ("in the last 30 days", "within 14 days") includes today.`,
      criteria: { true: "The action keeps the rule, or the rule does not apply.", false: "The action breaks the rule." },
    };
  });
  if (!Object.keys(questions).length) return { allowed: true, confirmed: null, broken: [], reason: "no confirmation and no rule to check", probabilities: {} };
  const answers = await brain.decide({
    purpose: `action gate: ${req.action.slice(0, 80)}`,
    state: {
      action: req.action,
      arguments: req.args ?? null,
      facts: req.facts ?? null,
      last_user_message: lastUser,
      conversation: turns.slice(-8),
      today: new Date().toISOString().slice(0, 10),
    },
    questions,
  });
  const p = (id: string) => {
    const a = answers[id];
    return a?.type === "noul" ? a.noul : 0;
  };
  const probabilities = Object.fromEntries(Object.keys(questions).map((id) => [id, Math.round(p(id) * 1000) / 1000]));
  const confirmed = confirm ? p("confirmed") >= threshold && p("only_information") < threshold : null;
  const broken = req.rules.filter((_, i) => p(`rule_${i}`) < threshold);
  const allowed = confirmed !== false && broken.length === 0;
  const reason = allowed
    ? "the action is confirmed and keeps the rules"
    : [confirmed === false ? "the user did not confirm this action with these values" : "", ...broken.map((r) => `it breaks the rule "${r}"`)].filter(Boolean).join(", and ");
  return { allowed, confirmed, broken, reason, probabilities };
}
