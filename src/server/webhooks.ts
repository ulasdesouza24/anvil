import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { TriggerManager } from "../runtime/triggers.js";

/** Reads the body of a webhook request into an object: JSON, a form, or text. */
async function readPayload(req: Request, buf: ArrayBuffer, rawBody: string): Promise<{ payload: unknown } | { error: string }> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      return { payload: rawBody.trim() ? JSON.parse(rawBody) : {} };
    } catch {
      return { error: "the body is not valid JSON" };
    }
  }
  if (type.includes("application/x-www-form-urlencoded")) return { payload: Object.fromEntries(new URLSearchParams(rawBody)) };
  if (type.includes("multipart/form-data")) {
    const form = await new Request(req.url, { method: "POST", headers: { "content-type": type }, body: buf }).formData();
    return { payload: Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : v.name])) };
  }
  return { payload: { text: rawBody } };
}

/**
 * The public webhook entry point (docs/TRIGGERS.md): a signed request (X-Anvil-Signature and X-Anvil-Timestamp) or
 * the token header, by ANVIL_WEBHOOK_AUTH. The URL never carries the secret. The body has a size limit.
 */
export function mountWebhooks(app: Hono, triggers: TriggerManager, maxBodyBytes: number) {
  app.on(
    ["POST", "PUT"],
    "/api/hooks/:agentId/:triggerId",
    bodyLimit({ maxSize: maxBodyBytes, onError: (c) => c.json({ error: `the body is larger than ${maxBodyBytes} bytes` }, 413) }),
    async (c) => {
      const buf = await c.req.arrayBuffer();
      const rawBody = new TextDecoder().decode(buf);
      const read = await readPayload(c.req.raw, buf, rawBody);
      if ("error" in read) return c.json({ error: read.error }, 400);
      const r = await triggers.handleWebhook(c.req.param("agentId"), c.req.param("triggerId"), {
        rawBody,
        payload: read.payload,
        headers: c.req.header(),
        query: Object.fromEntries(Object.entries(c.req.query()).filter(([k]) => k !== "token")),
      });
      return c.json(r.body, r.status as 200);
    },
  );
}
