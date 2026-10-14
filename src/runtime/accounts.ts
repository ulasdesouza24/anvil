import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { SettingsStore } from "./settingsStore.js";

/**
 * Accounts of a hosted Anvil (docs/HOSTING.md): a username and a password, and a signed session token.
 * The settings and the OpenRouter key of each user are in the SettingsStore.
 */

export interface Account {
  id: string;
  username: string;
  createdAt: number;
}

interface StoredAccount extends Account {
  /** scrypt hash and salt of the password, in hex. */
  hash: string;
  salt: string;
  /** A logout of all sessions increases it: older tokens stop working. */
  tokenVersion: number;
}

export const USERNAME = /^[a-zA-Z0-9_]{3,24}$/;
const RESERVED = new Set(["admin", "anvil", "system", "root", "support", "api", "bazaar", "local", "null", "undefined"]);
const TOKEN_DAYS = 30;

const hashPassword = (password: string, salt: string) => crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
const b64 = (s: string) => Buffer.from(s).toString("base64url");

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 409 | 429 = 400,
  ) {
    super(message);
  }
}

export class AccountService {
  private file: string;
  private accounts: StoredAccount[] = [];
  private sessionKey: Buffer;
  private secretsKey: Buffer;
  /** Failed logins and new accounts of each client address, for a simple rate limit. */
  private attempts = new Map<string, number[]>();

  constructor(
    private dataDir: string,
    sessionSecret: string,
    secretsKey: string,
  ) {
    if (sessionSecret.length < 32) throw new Error("ANVIL_SESSION_SECRET must have at least 32 characters (for example the output of: openssl rand -hex 32)");
    if (secretsKey.length < 32) throw new Error("ANVIL_SECRETS_KEY must have at least 32 characters (for example the output of: openssl rand -hex 32)");
    this.sessionKey = crypto.createHash("sha256").update(`session:${sessionSecret}`).digest();
    this.secretsKey = /^[0-9a-f]{64}$/i.test(secretsKey) ? Buffer.from(secretsKey, "hex") : crypto.scryptSync(secretsKey, "anvil-secrets", 32);
    this.file = path.join(dataDir, "accounts", "users.json");
  }

  load(): this {
    if (fs.existsSync(this.file)) this.accounts = (JSON.parse(fs.readFileSync(this.file, "utf8")) as { accounts: StoredAccount[] }).accounts ?? [];
    return this;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ accounts: this.accounts }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** At most `max` events of one kind for one client address in 10 minutes. */
  limit(kind: string, client: string, max: number): void {
    const key = `${kind}:${client}`;
    const now = Date.now();
    const recent = (this.attempts.get(key) ?? []).filter((t) => now - t < 600_000);
    if (recent.length >= max) throw new AccountError("Too many attempts. Wait 10 minutes, then try again.", 429);
    recent.push(now);
    this.attempts.set(key, recent);
  }

  list(): Account[] {
    return this.accounts.map(({ id, username, createdAt }) => ({ id, username, createdAt }));
  }

  get(id: string): Account | undefined {
    const a = this.accounts.find((x) => x.id === id);
    return a && { id: a.id, username: a.username, createdAt: a.createdAt };
  }

  private checkUsername(username: string, self?: string): string {
    const u = username.trim();
    if (!USERNAME.test(u)) throw new AccountError("A username has 3 to 24 letters, digits, or underscores");
    if (RESERVED.has(u.toLowerCase())) throw new AccountError(`"${u}" is reserved. Choose another username.`);
    if (this.accounts.some((a) => a.username.toLowerCase() === u.toLowerCase() && a.id !== self)) throw new AccountError(`The username "${u}" is taken`, 409);
    return u;
  }

  private checkPassword(password: string): void {
    if (typeof password !== "string" || password.length < 8) throw new AccountError("A password has at least 8 characters");
    if (password.length > 200) throw new AccountError("The password is too long");
  }

  register(username: string, password: string): { account: Account; token: string } {
    const u = this.checkUsername(username);
    this.checkPassword(password);
    const salt = crypto.randomBytes(16).toString("hex");
    const a: StoredAccount = { id: `u_${nanoid(12)}`, username: u, createdAt: Date.now(), hash: hashPassword(password, salt), salt, tokenVersion: 1 };
    this.accounts.push(a);
    this.save();
    return { account: this.get(a.id)!, token: this.sign(a) };
  }

  login(username: string, password: string): { account: Account; token: string } {
    const a = this.accounts.find(
      (x) =>
        x.username.toLowerCase() ===
        String(username ?? "")
          .trim()
          .toLowerCase(),
    );
    const ok = a && crypto.timingSafeEqual(Buffer.from(hashPassword(String(password ?? ""), a.salt), "hex"), Buffer.from(a.hash, "hex"));
    if (!a || !ok) throw new AccountError("The username or the password is wrong", 401);
    return { account: this.get(a.id)!, token: this.sign(a) };
  }

  rename(id: string, username: string): Account {
    const a = this.accounts.find((x) => x.id === id);
    if (!a) throw new AccountError("No such account", 401);
    a.username = this.checkUsername(username, id);
    this.save();
    return this.get(id)!;
  }

  changePassword(id: string, current: string, next: string): string {
    const a = this.accounts.find((x) => x.id === id);
    if (!a) throw new AccountError("No such account", 401);
    this.login(a.username, current);
    this.checkPassword(next);
    a.salt = crypto.randomBytes(16).toString("hex");
    a.hash = hashPassword(next, a.salt);
    a.tokenVersion++;
    this.save();
    return this.sign(a);
  }

  /** Ends each session of the account: each old token stops working. */
  logoutAll(id: string): void {
    const a = this.accounts.find((x) => x.id === id);
    if (!a) return;
    a.tokenVersion++;
    this.save();
  }

  private sign(a: StoredAccount): string {
    const body = b64(JSON.stringify({ uid: a.id, v: a.tokenVersion, exp: Date.now() + TOKEN_DAYS * 86_400_000 }));
    return `${body}.${crypto.createHmac("sha256", this.sessionKey).update(body).digest("base64url")}`;
  }

  /** The account of a session token, or undefined for a bad, old, or expired token. */
  verify(token: string | undefined): Account | undefined {
    if (!token) return undefined;
    const [body, sig] = token.split(".");
    if (!body || !sig) return undefined;
    const expect = crypto.createHmac("sha256", this.sessionKey).update(body).digest();
    const got = Buffer.from(sig, "base64url");
    if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return undefined;
    try {
      const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { uid: string; v: number; exp: number };
      const a = this.accounts.find((x) => x.id === p.uid);
      if (!a || a.tokenVersion !== p.v || p.exp < Date.now()) return undefined;
      return this.get(a.id);
    } catch {
      return undefined;
    }
  }

  /** The data folder of a user: the workspace of that user. */
  userDir(id: string): string {
    return path.join(this.dataDir, "users", id);
  }

  /** The settings store of the accounts: the settings file of each user is in the folder of that user. */
  settingsStore(): SettingsStore {
    return new SettingsStore((id) => path.join(this.userDir(id), "settings.json"), this.secretsKey);
  }
}
