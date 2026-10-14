import { currentEnv } from "../scope.js";
import nodemailer from "nodemailer";
import { z } from "zod";
import { isDryRun, NotSentError, runEffect } from "../effects.js";
import type { NodeClass, NodeContext } from "../registry.js";

/**
 * Steps that send the results of an agent (docs/SEND.md): Slack, email, and a
 * general webhook. They have side effects. Their addresses and passwords are secrets (docs/SECRETS.md):
 * a config names the variable, never the value. An evaluation run does not send: it gives a dry run.
 */

/** A value of a secret variable. A missing variable stops the step with the name to set. */
function secretOf(name: string, what: string): string {
  const v = currentEnv()[name];
  if (!v) throw new Error(`Set the secret ${name} (${what}) on the Connections page or in .env`);
  return v;
}

/** Header values can name secrets: "Bearer ${NAME}". */
function withSecrets(headers: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, n: string) => secretOf(n, `header ${k}`))]));
}

/** An evaluation run (tests, evolve, a health check) and a dry run of the editor never send: the result shows what it would send. */
const dryRun = (ctx: NodeContext<unknown>) => isDryRun(ctx.services);

/**
 * One POST. The Idempotency-Key header lets a receiver drop a second copy (docs/EFFECTS.md).
 * A 429 answer or a network error before the request shows that nothing went out (NotSentError): a retry is safe.
 */
async function post(
  url: string,
  body: unknown,
  opts: { method?: string; headers?: Record<string, string>; timeoutMs: number; signal: AbortSignal; idempotencyKey?: string },
): Promise<{ status: number; text: string }> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const res = await fetch(url, {
    method: opts.method ?? "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "AnvilAgent/1.0",
      ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}),
      ...(opts.headers ?? {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.any([opts.signal, timeout]),
  });
  const text = (await res.text()).slice(0, 2000);
  if (res.status === 429) throw new NotSentError(`HTTP 429 from ${new URL(url).host}: ${text.slice(0, 300)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 300)}`);
  return { status: res.status, text };
}

/** The key of one action of a run: the same for each retry and for a replay after a restart. */
const idempotencyKeyOf = (ctx: NodeContext<unknown>) => `anvil-${ctx.services.rootRunId ?? ctx.runId}-${ctx.node.id}`;

/* ------------------------------- send_slack ------------------------------- */

const SlackConfig = z.object({
  text: z.string().min(1).describe("The message. Slack mrkdwn: *bold*, _italic_, <url|label>."),
  /** The secret variable with the incoming webhook URL of the channel. */
  webhookSecret: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .default("SLACK_WEBHOOK_URL"),
  timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
});

export const SendSlackNode: NodeClass<z.infer<typeof SlackConfig>> = {
  type: "send_slack",
  title: "Send to Slack",
  category: "tool",
  description: "Posts a message to a Slack channel with an incoming webhook. The webhook URL is a secret (default SLACK_WEBHOOK_URL). Output: {sent, channel, dryRun?, preview}.",
  whenToUse: "The request asks to send, post, or notify the result to Slack.",
  configSchema: SlackConfig,
  example: { text: "*Daily report*\n{{nodes.summary.output.text}}" },
  sideEffects: () => true,
  defaultRetry: { maxAttempts: 2, backoffMs: 2000 },
  outputSchema: () => ({
    type: "object",
    properties: { sent: { type: "boolean" }, channel: { type: "string" }, dryRun: { type: "boolean" }, preview: { type: "string" } },
    required: ["sent", "channel"],
  }),
  async execute(ctx) {
    const c = ctx.config;
    const preview = c.text.slice(0, 500);
    if (dryRun(ctx)) return { output: { sent: false, channel: "slack", dryRun: true, preview } };
    const url = secretOf(c.webhookSecret, "the Slack webhook URL");
    return runEffect(ctx, "send_slack", c, async () => {
      await post(url, { text: c.text }, { timeoutMs: c.timeoutMs, signal: ctx.signal });
      ctx.log(`sent a Slack message (${c.text.length} characters)`);
      return { output: { sent: true, channel: "slack", preview } };
    });
  },
};

/* ------------------------------- send_email ------------------------------- */

const EmailConfig = z.object({
  to: z.union([z.string().min(3), z.array(z.string().min(3)).min(1)]).describe("One address or a list"),
  subject: z.string().min(1),
  text: z.string().min(1).describe("The plain text body"),
  html: z.string().optional().describe("An HTML body. The text body stays for mail apps without HTML."),
  /** The prefix of the SMTP variables: <prefix>_HOST, _PORT, _USER, _PASSWORD, _FROM, _SECURE. */
  smtp: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .default("SMTP"),
});

export const SendEmailNode: NodeClass<z.infer<typeof EmailConfig>> = {
  type: "send_email",
  title: "Send an email",
  category: "tool",
  description:
    "Sends an email over SMTP. The SMTP settings are secrets: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM, and SMTP_SECURE (true for port 465). Output: {sent, channel, to, messageId?, dryRun?, preview}.",
  whenToUse: "The request asks to email the result to a person or a list.",
  configSchema: EmailConfig,
  example: { to: "{{input.email}}", subject: "Weekly summary", text: "{{nodes.summary.output.text}}" },
  sideEffects: () => true,
  defaultRetry: { maxAttempts: 2, backoffMs: 2000 },
  outputSchema: () => ({
    type: "object",
    properties: {
      sent: { type: "boolean" },
      channel: { type: "string" },
      to: { type: "array", items: { type: "string" } },
      messageId: { type: "string" },
      dryRun: { type: "boolean" },
      preview: { type: "string" },
    },
    required: ["sent", "channel", "to"],
  }),
  async execute(ctx) {
    const c = ctx.config;
    const to = (Array.isArray(c.to) ? c.to : c.to.split(/[,;]/)).map((x) => x.trim()).filter(Boolean);
    const bad = to.filter((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
    if (bad.length) throw new Error(`Not an email address: ${bad.join(", ")}`);
    const preview = `${c.subject}\n\n${c.text}`.slice(0, 500);
    if (dryRun(ctx)) return { output: { sent: false, channel: "email", to, dryRun: true, preview } };
    const p = c.smtp;
    const env = currentEnv();
    const port = Number(env[`${p}_PORT`] ?? 587);
    const transport = nodemailer.createTransport({
      host: secretOf(`${p}_HOST`, "the SMTP server"),
      port,
      secure: (env[`${p}_SECURE`] ?? String(port === 465)) === "true",
      ...(env[`${p}_USER`] ? { auth: { user: env[`${p}_USER`]!, pass: secretOf(`${p}_PASSWORD`, "the SMTP password") } } : {}),
    });
    const from = secretOf(`${p}_FROM`, "the sender address");
    return runEffect(ctx, "send_email", c, async () => {
      // The Message-ID is the same for each try: a mail server or a mail app can drop a second copy.
      const messageId = `<${idempotencyKeyOf(ctx)}@anvil>`;
      const info = await transport.sendMail({ from, to, subject: c.subject, text: c.text, messageId, ...(c.html ? { html: c.html } : {}) });
      ctx.log(`sent an email to ${to.length} address(es)`);
      return { output: { sent: true, channel: "email", to, messageId: String(info.messageId ?? messageId), preview } };
    });
  },
};

/* ------------------------------ send_webhook ------------------------------ */

const WebhookConfig = z
  .object({
    url: z.string().url().optional().describe("The URL. Use urlSecret when the URL itself is a secret."),
    /** The secret variable with the URL (for example a Zapier or Discord webhook). */
    urlSecret: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    method: z.enum(["POST", "PUT", "PATCH"]).default("POST"),
    body: z.unknown().describe("The JSON body (an object, or text)"),
    headers: z.record(z.string(), z.string()).optional().describe('Header values can name secrets: "Bearer ${NAME}"'),
    timeoutMs: z.number().int().min(1000).max(60_000).default(15_000),
  })
  .refine((c) => !!c.url !== !!c.urlSecret, { message: "give url or urlSecret, not both" });

export const SendWebhookNode: NodeClass<z.infer<typeof WebhookConfig>> = {
  type: "send_webhook",
  title: "Send to a webhook",
  category: "tool",
  description:
    "Sends the result as JSON to a webhook (Zapier, Make, Discord, Teams, your backend). The URL or a header can be a secret. Output: {sent, channel, status?, response?, dryRun?, preview}.",
  whenToUse: "The request asks to send or push the result to another system that has a webhook.",
  configSchema: WebhookConfig,
  example: { urlSecret: "REPORT_WEBHOOK_URL", body: { report: "{{nodes.summary.output}}" } },
  sideEffects: () => true,
  defaultRetry: { maxAttempts: 2, backoffMs: 2000 },
  outputSchema: () => ({
    type: "object",
    properties: {
      sent: { type: "boolean" },
      channel: { type: "string" },
      status: { type: "number" },
      response: { type: "string" },
      dryRun: { type: "boolean" },
      preview: { type: "string" },
    },
    required: ["sent", "channel"],
  }),
  async execute(ctx) {
    const c = ctx.config;
    const preview = (typeof c.body === "string" ? c.body : JSON.stringify(c.body ?? null)).slice(0, 500);
    if (dryRun(ctx)) return { output: { sent: false, channel: "webhook", dryRun: true, preview } };
    const url = c.url ?? secretOf(c.urlSecret!, "the webhook URL");
    const headers = withSecrets(c.headers);
    return runEffect(ctx, "send_webhook", c, async () => {
      const r = await post(url, c.body ?? null, { method: c.method, headers, timeoutMs: c.timeoutMs, signal: ctx.signal, idempotencyKey: idempotencyKeyOf(ctx) });
      ctx.log(`sent to a webhook (HTTP ${r.status})`);
      return { output: { sent: true, channel: "webhook", status: r.status, response: r.text.slice(0, 500), preview } };
    });
  },
};

export const SEND_NODE_CLASSES = [SendSlackNode, SendEmailNode, SendWebhookNode];

/** The secret variables that the send steps of a spec need (docs/SECRETS.md: the "needed" list). */
export function sendSecretsOf(nodes: { type: string; config: unknown }[]): string[] {
  const out = new Set<string>();
  for (const n of nodes) {
    const c = (n.config ?? {}) as Record<string, unknown>;
    if (n.type === "send_slack") out.add(String(c.webhookSecret ?? "SLACK_WEBHOOK_URL"));
    if (n.type === "send_email") for (const k of ["HOST", "FROM"]) out.add(`${String(c.smtp ?? "SMTP")}_${k}`);
    if (n.type === "send_webhook") {
      if (typeof c.urlSecret === "string") out.add(c.urlSecret);
      for (const v of Object.values((c.headers ?? {}) as Record<string, string>)) for (const m of String(v).matchAll(/\$\{([A-Z0-9_]+)\}/g)) out.add(m[1]);
    }
  }
  return [...out];
}
