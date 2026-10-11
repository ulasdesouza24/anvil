import crypto from "node:crypto";

/** Paths that never need the API token: the health check, and webhooks (they have their own trigger token). */
const OPEN = [/^\/api\/health$/, /^\/api\/hooks\//];

const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Event streams: EventSource cannot send headers, so only these paths accept "?token=". A URL goes into logs and browser history. */
const STREAM = /\/events$/;

/**
 * Checks the API token of a request. Without a configured token, every request is allowed.
 * The token can come from "Authorization: Bearer" or "X-Anvil-Token". Only an event stream accepts "?token=".
 */
export function apiTokenOk(token: string, path: string, header: (name: string) => string | undefined, query: (name: string) => string | undefined): boolean {
  if (!token || OPEN.some((re) => re.test(path))) return true;
  const bearer = /^Bearer\s+(.+)$/i.exec(header("authorization") ?? "")?.[1];
  const given = bearer ?? header("x-anvil-token") ?? (STREAM.test(path) ? query("token") : undefined) ?? "";
  return same(given, token);
}
