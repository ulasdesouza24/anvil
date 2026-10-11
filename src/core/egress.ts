/**
 * The egress policy for programs in the sandbox (docs/SANDBOX.md, section 2.7).
 *
 * A program can send data out only through the tool bridge. Each outbound
 * request goes through these rules before the host sends it:
 * - the domain must be on the allowlist of the run,
 * - a request that sends data (POST, PUT, PATCH, DELETE) needs a person,
 * - the request must not contain a secret,
 * - the request must not send more than the size limit.
 */

export interface EgressPolicy {
  /** The domains that the run can contact. A subdomain of an allowed domain is also allowed. */
  allowDomains: Set<string>;
  /** The most bytes that one request can send (URL query and body). */
  maxBody: number;
  /** Evaluation runs never send data out. */
  evaluation: boolean;
  /** Secret values of the host that must never leave (from the environment). */
  secretValues: string[];
}

export interface EgressRequest {
  tool: string;
  url: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export type EgressDecision = { allowed: true; needsApproval: boolean; host: string; bytes: number } | { allowed: false; reason: string; host: string; bytes: number };

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Patterns of common credentials. A match blocks the request. */
const SECRET_PATTERNS: [string, RegExp][] = [
  ["an API key (sk-...)", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["a Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["a JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["a bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
];

/** The name of a secret variable: KEY, TOKEN, SECRET, PASSWORD, or WEBHOOK in the name. */
export const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|WEBHOOK/i;

/** The secret values of the host environment: variables with KEY, TOKEN, SECRET, PASSWORD, or WEBHOOK in the name. */
export function hostSecretValues(env: Record<string, string | undefined> = process.env): string[] {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_ENV_NAME.test(k) && typeof v === "string" && v.length >= 12)
    .map(([, v]) => v as string);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** True when the host is an allowed domain or a subdomain of one. */
export function domainAllowed(host: string, allow: Set<string>): boolean {
  if (!host) return false;
  for (const d of allow) if (host === d || host.endsWith(`.${d}`)) return true;
  return false;
}

/** Finds a secret in the text of a request. Returns its kind, or null. */
export function findSecret(text: string, secretValues: string[]): string | null {
  for (const v of secretValues) if (v && text.includes(v)) return "a secret of the Anvil host";
  for (const [kind, re] of SECRET_PATTERNS) if (re.test(text)) return kind;
  return null;
}

export function checkEgress(req: EgressRequest, policy: EgressPolicy): EgressDecision {
  const host = hostOf(req.url);
  const method = (req.method || "GET").toUpperCase();
  let query = "";
  try {
    query = new URL(req.url).search;
  } catch {
    return { allowed: false, reason: "the URL is not valid", host, bytes: 0 };
  }
  const body = req.body === undefined || req.body === null ? "" : typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  const bytes = Buffer.byteLength(query) + Buffer.byteLength(body);
  if (!/^https?:$/.test(new URL(req.url).protocol)) return { allowed: false, reason: "only http and https are allowed", host, bytes };
  if (!domainAllowed(host, policy.allowDomains))
    return { allowed: false, reason: `the domain ${host || "(none)"} is not on the allowlist of this run. A person can add it on the Sandbox tab of the agent.`, host, bytes };
  const secret = findSecret(`${req.url}\n${body}\n${JSON.stringify(req.headers ?? {})}`, policy.secretValues);
  if (secret) return { allowed: false, reason: `the request contains ${secret}`, host, bytes };
  if (bytes > policy.maxBody) return { allowed: false, reason: `the request sends ${bytes} bytes. The limit is ${policy.maxBody} bytes.`, host, bytes };
  const write = WRITE_METHODS.has(method);
  if (write && policy.evaluation) return { allowed: false, reason: `${method} requests send data. Evaluation runs never send data out.`, host, bytes };
  return { allowed: true, needsApproval: write, host, bytes };
}
