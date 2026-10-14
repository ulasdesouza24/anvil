import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendSecretsOf } from "../src/core/nodes/send.js";
import type { AgentSpec } from "../src/core/types.js";
import { validateSpec } from "../src/core/validator.js";
import { createRegistry } from "../src/runtime/anvil.js";
import { anvilWith, FakeClient } from "./helpers.js";

const posts: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
const mails: string[] = [];
let web: http.Server;
let smtp: net.Server;
let base = "";
let smtpPort = 0;

beforeAll(async () => {
  web = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      posts.push({ url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/fail") return res.writeHead(500).end("broken");
      res.writeHead(200).end("ok");
    });
  });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  // A small SMTP server: it accepts one message for each connection and keeps its data.
  smtp = net.createServer((s) => {
    let data = false;
    let buf = "";
    s.write("220 test ESMTP\r\n");
    s.on("data", (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line === ".") {
            data = false;
            s.write("250 OK queued\r\n");
          } else mails[mails.length - 1] += `${line}\n`;
        } else if (/^(EHLO|HELO)/i.test(line)) s.write("250-test\r\n250 OK\r\n");
        else if (/^DATA/i.test(line)) {
          data = true;
          mails.push("");
          s.write("354 go\r\n");
        } else if (/^QUIT/i.test(line)) s.end("221 bye\r\n");
        else s.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  smtpPort = (smtp.address() as AddressInfo).port;
});
afterAll(() => {
  web.close();
  smtp.close();
});

const one = (node: AgentSpec["nodes"][number]): AgentSpec => ({
  specVersion: "anvil/v1",
  id: "sender",
  name: "sender",
  description: "",
  version: 1,
  inputSchema: { type: "object", properties: {} },
  nodes: [{ id: "input", type: "input", config: {} }, node, { id: "output", type: "output", config: { value: `{{nodes.${node.id}.output}}` } }],
  edges: [
    { from: "input", to: node.id },
    { from: node.id, to: "output" },
  ],
  policy: { maxCostUsd: 1, maxNodeExecutions: 20, timeoutMs: 20_000, requireApprovalForSideEffects: false },
  tests: [],
  meta: {},
});

const withEnv = async <T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

describe("send steps", () => {
  it("send_slack posts the text to the webhook of the secret, and an evaluation run does not send", async () => {
    const anvil = await anvilWith(new FakeClient());
    const spec = one({ id: "slack", type: "send_slack", config: { text: "*Top gainers*: THYAO +4%" } });
    await withEnv({ SLACK_WEBHOOK_URL: `${base}/slack-hook` }, async () => {
      const r = await anvil.runs.run({ spec }, {});
      expect(r.output).toEqual({ sent: true, channel: "slack", preview: "*Top gainers*: THYAO +4%" });
      expect(posts.at(-1)).toMatchObject({ url: "/slack-hook", body: '{"text":"*Top gainers*: THYAO +4%"}' });
      const count = posts.length;
      const test = await anvil.runs.run({ spec }, {}, { kind: "eval" });
      expect(test.output).toMatchObject({ sent: false, dryRun: true });
      expect(posts).toHaveLength(count);
    });
    const missing = await anvil.runs.run({ spec }, {});
    expect(missing.status).toBe("failed");
    expect(missing.error).toMatch(/Set the secret SLACK_WEBHOOK_URL/);
  });

  it("send_webhook uses a secret URL and secret headers, and fails on an HTTP error", async () => {
    const anvil = await anvilWith(new FakeClient());
    await withEnv({ REPORT_WEBHOOK_URL: `${base}/hook`, REPORT_TOKEN: "tok-1234567890abcd" }, async () => {
      const r = await anvil.runs.run({ spec: one({ id: "hook", type: "send_webhook", config: { urlSecret: "REPORT_WEBHOOK_URL", body: { a: 1 }, headers: { Authorization: "Bearer ${REPORT_TOKEN}" } } }) }, {});
      expect(r.output).toMatchObject({ sent: true, channel: "webhook", status: 200 });
      expect(posts.at(-1)).toMatchObject({ url: "/hook", body: '{"a":1}' });
      expect(posts.at(-1)!.headers.authorization).toBe("Bearer tok-1234567890abcd");
      // The trace does not show the token.
      expect(JSON.stringify(r.events)).not.toContain("tok-1234567890abcd");
    });
    const bad = await anvil.runs.run({ spec: one({ id: "hook", type: "send_webhook", config: { url: `${base}/fail`, body: "x" } }) }, {});
    expect(bad.status).toBe("failed");
    expect(bad.error).toMatch(/HTTP 500/);
  });

  it("send_email sends over SMTP with the SMTP secrets, and rejects a bad address", async () => {
    const anvil = await anvilWith(new FakeClient());
    await withEnv({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtpPort), SMTP_SECURE: "false", SMTP_FROM: "anvil@example.com" }, async () => {
      const r = await anvil.runs.run({ spec: one({ id: "mail", type: "send_email", config: { to: "a@example.com, b@example.com", subject: "Weekly summary", text: "All good." } }) }, {});
      expect(r.error).toBeUndefined();
      expect(r.output).toMatchObject({ sent: true, channel: "email", to: ["a@example.com", "b@example.com"] });
      expect(mails.at(-1)).toMatch(/Subject: Weekly summary/);
      expect(mails.at(-1)).toMatch(/All good\./);
      const bad = await anvil.runs.run({ spec: one({ id: "mail", type: "send_email", config: { to: "not-an-address", subject: "x", text: "y" } }) }, {});
      expect(bad.error).toMatch(/Not an email address: not-an-address/);
    });
  });

  it("send steps have side effects, a closed build rejects them, and their secrets are listed", () => {
    const reg = createRegistry();
    const s = one({ id: "slack", type: "send_slack", config: { text: "x" } });
    expect(validateSpec(s, reg).diagnostics.some((d) => d.code === "UNGATED_SIDE_EFFECT")).toBe(true);
    expect(validateSpec({ ...s, meta: { givenTools: ["x_tool_a_000000"] } }, reg).diagnostics.some((d) => d.code === "CLOSED_TOOLS")).toBe(true);
    expect(
      sendSecretsOf([
        { type: "send_slack", config: { text: "x" } },
        { type: "send_email", config: { to: "a@b.co", subject: "s", text: "t", smtp: "MAIL" } },
        { type: "send_webhook", config: { urlSecret: "HOOK_URL", headers: { "X-Key": "${HOOK_KEY}" } } },
        { type: "llm", config: {} },
      ]),
    ).toEqual(["SLACK_WEBHOOK_URL", "MAIL_HOST", "MAIL_FROM", "HOOK_URL", "HOOK_KEY"]);
  });
});
