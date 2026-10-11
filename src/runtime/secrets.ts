import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hostSecretValues, SECRET_ENV_NAME } from "../core/egress.js";
import { setExtraHostHeaders } from "../core/liveFetch.js";

/**
 * Secrets from the UI (docs/SECRETS.md). A person enters API keys and host
 * headers on the Connections page. The values are on disk with AES-256-GCM encryption. The key
 * is ANVIL_SECRETS_KEY in .env. At the start, the values go into the environment of the process,
 * so classes ({{secrets.NAME}}), host headers (${NAME}), and the sandbox read them as before.
 * Run events never show a secret value.
 */

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

interface SecretFile {
  version: 1;
  secrets: Record<string, { value: string; updatedAt: number }>;
  /** host → header name → template. A template can use ${NAME}. */
  hostHeaders: Record<string, Record<string, string>>;
}

export interface SecretView {
  name: string;
  /** "ui": entered on the Connections page. "env": set in the environment (.env). */
  source: "ui" | "env";
  updatedAt?: number;
  /** The last 4 characters, so a person can tell two values apart. */
  hint: string;
}

const empty = (): SecretFile => ({ version: 1, secrets: {}, hostHeaders: {} });

/** The key: 64 hex characters, or a passphrase that scrypt makes into 32 bytes. */
function keyOf(raw: string): Buffer {
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  return crypto.scryptSync(raw, "anvil-secrets", 32);
}

export function encrypt(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return JSON.stringify({ alg: "aes-256-gcm", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") });
}

export function decrypt(text: string, key: Buffer): string {
  const o = JSON.parse(text) as { iv: string; tag: string; data: string };
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(o.iv, "base64"));
  d.setAuthTag(Buffer.from(o.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(o.data, "base64")), d.final()]).toString("utf8");
}

const MASK = "[secret]";

/** Replaces each secret value of the environment in a value (an event, an output) with "[secret]". */
export function redactSecrets<T>(value: T, secrets: string[] = hostSecretValues()): T {
  if (!secrets.length || value === undefined || value === null) return value;
  const text = JSON.stringify(value);
  if (text === undefined || !secrets.some((s) => text.includes(s))) return value;
  let out = text;
  // A long value first: a short value can be a part of a long value.
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join(MASK);
  // The value goes through JSON: a secret with a quote or a backslash also appears escaped.
  for (const s of secrets) {
    const escaped = JSON.stringify(s).slice(1, -1);
    if (escaped !== s) out = out.split(escaped).join(MASK);
  }
  return JSON.parse(out) as T;
}

export class SecretService {
  private file: string;
  private key: Buffer | null;
  private data: SecretFile = empty();
  /** The names that this service put into the environment: only these are removed again. */
  private applied = new Set<string>();

  constructor(dataDir: string, rawKey: string | undefined, private env: NodeJS.ProcessEnv = process.env) {
    this.file = path.join(dataDir, "secrets.enc.json");
    this.key = rawKey ? keyOf(rawKey) : null;
  }

  get enabled(): boolean {
    return !!this.key;
  }

  /** Reads the file and puts the values into the environment. A wrong key stops the start, with the reason. */
  load(): this {
    if (!this.key || !fs.existsSync(this.file)) return this.apply();
    try {
      this.data = { ...empty(), ...(JSON.parse(decrypt(fs.readFileSync(this.file, "utf8"), this.key)) as SecretFile) };
    } catch (e) {
      throw new Error(`Cannot read ${this.file}: the ANVIL_SECRETS_KEY is wrong, or the file is damaged (${(e as Error).message})`);
    }
    return this.apply();
  }

  private apply(): this {
    for (const [name, s] of Object.entries(this.data.secrets)) {
      this.env[name] = s.value;
      this.applied.add(name);
    }
    setExtraHostHeaders(this.data.hostHeaders);
    return this;
  }

  private save(): void {
    if (!this.key) throw new Error("Set ANVIL_SECRETS_KEY in .env to store secrets (for example the output of: openssl rand -hex 32)");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, encrypt(JSON.stringify(this.data), this.key), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** The names of the secrets (never the values): from the UI, and the secret variables of the environment. */
  list(): SecretView[] {
    const hint = (v: string) => (v.length >= 8 ? `…${v.slice(-4)}` : "…");
    const ui = Object.entries(this.data.secrets).map(([name, s]) => ({ name, source: "ui" as const, updatedAt: s.updatedAt, hint: hint(s.value) }));
    const env = Object.entries(this.env)
      .filter(([k, v]) => !this.data.secrets[k] && SECRET_ENV_NAME.test(k) && typeof v === "string" && v.length > 0)
      .map(([name, v]) => ({ name, source: "env" as const, hint: hint(v as string) }));
    return [...ui, ...env].sort((a, b) => a.name.localeCompare(b.name));
  }

  set(name: string, value: string): SecretView {
    if (!SECRET_NAME.test(name)) throw new Error("A secret name is UPPER_SNAKE_CASE, for example GITHUB_TOKEN");
    if (!value) throw new Error("The value is empty");
    if (["ANVIL_SECRETS_KEY", "ANVIL_API_TOKEN"].includes(name)) throw new Error(`${name} must stay in .env`);
    this.data.secrets[name] = { value, updatedAt: Date.now() };
    this.save();
    this.env[name] = value;
    this.applied.add(name);
    return this.list().find((s) => s.name === name)!;
  }

  remove(name: string): void {
    if (!this.data.secrets[name]) throw new Error(`No secret "${name}" from the UI`);
    delete this.data.secrets[name];
    this.save();
    if (this.applied.has(name)) {
      delete this.env[name];
      this.applied.delete(name);
    }
  }

  /**
   * The secrets that classes, agents, and host headers name, and that have no value: a person sees what to enter.
   * uses: a label ("class x_weather", "agent daily-report") → the secret names that it needs.
   */
  needed(uses: Record<string, string[]>, envHostHeaders: Record<string, Record<string, string>>): { name: string; usedBy: string[] }[] {
    const use = new Map<string, Set<string>>();
    const add = (name: string, by: string) => (use.get(name) ?? use.set(name, new Set()).get(name)!).add(by);
    for (const [label, names] of Object.entries(uses)) for (const n of names) add(n, label);
    for (const [host, headers] of Object.entries({ ...envHostHeaders, ...this.data.hostHeaders }))
      for (const v of Object.values(headers)) for (const m of v.matchAll(/\$\{([A-Z0-9_]+)\}/g)) add(m[1], `host ${host}`);
    return [...use.entries()].filter(([n]) => !this.env[n]).map(([name, by]) => ({ name, usedBy: [...by].sort() })).sort((a, b) => a.name.localeCompare(b.name));
  }

  hostHeaders(): Record<string, Record<string, string>> {
    return structuredClone(this.data.hostHeaders);
  }

  /** Sets the headers of one host. Empty headers remove the host. A header value can name a secret: ${GITHUB_TOKEN}. */
  setHostHeaders(host: string, headers: Record<string, string>): void {
    const h = host.trim().toLowerCase();
    if (!/^[a-z0-9.-]+(:\d+)?$/.test(h)) throw new Error("Give a host name, for example api.github.com");
    for (const [k, v] of Object.entries(headers)) {
      if (!/^[A-Za-z0-9-]+$/.test(k)) throw new Error(`"${k}" is not a header name`);
      if (typeof v !== "string") throw new Error(`The value of "${k}" must be text`);
      // A literal credential belongs in a secret. The header names it: ${NAME}.
      if (/authorization|api[-_]?key|token/i.test(k) && !/\$\{[A-Z0-9_]+\}/.test(v)) throw new Error(`The header "${k}" looks like a credential. Save the value as a secret and use \${NAME} here.`);
    }
    if (Object.keys(headers).length) this.data.hostHeaders[h] = headers;
    else delete this.data.hostHeaders[h];
    this.save();
    setExtraHostHeaders(this.data.hostHeaders);
  }
}
