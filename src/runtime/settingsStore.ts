import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cleanSettings } from "../core/userSettings.js";
import { decrypt, encrypt } from "./secrets.js";

/**
 * The settings of a workspace (docs/HOSTING.md): setting values and the OpenRouter key. The key is on disk with
 * AES-256-GCM encryption and never goes back to the browser: the API gives only its last 4 characters.
 */

export interface UserSettings {
  /** Setting path → value (see SETTING_FIELDS). */
  values: Record<string, unknown>;
  /** The encrypted OpenRouter key. */
  apiKey?: string;
  updatedAt: number;
}

export class SettingsError extends Error {
  readonly status = 400;
}

/** A 32-byte key: 64 hex characters, or a passphrase that scrypt makes into 32 bytes. */
export function settingsKey(raw: string): Buffer {
  return /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : crypto.scryptSync(raw, "anvil-secrets", 32);
}

/**
 * The key for the settings of the local Anvil: ANVIL_SECRETS_KEY, or a random key in data/.settings-key
 * (made at the first use, readable only by the owner of the file).
 */
export function localSettingsKey(dataDir: string, raw = process.env.ANVIL_SECRETS_KEY): Buffer {
  if (raw) return settingsKey(raw);
  const file = path.join(dataDir, ".settings-key");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  return settingsKey(fs.readFileSync(file, "utf8").trim());
}

export class SettingsStore {
  constructor(
    private fileOf: (id: string) => string,
    private key: Buffer,
  ) {}

  settings(id: string): UserSettings {
    const f = this.fileOf(id);
    if (!fs.existsSync(f)) return { values: {}, updatedAt: 0 };
    return JSON.parse(fs.readFileSync(f, "utf8")) as UserSettings;
  }

  private write(id: string, s: UserSettings): void {
    const f = this.fileOf(id);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.renameSync(`${f}.tmp`, f);
  }

  /** Sets setting values. A null value goes back to the server default. Gives the new values. */
  setValues(id: string, change: Record<string, unknown>): Record<string, unknown> {
    const s = this.settings(id);
    const removed = Object.keys(change).filter((k) => change[k] === null);
    let clean: Record<string, unknown>;
    try {
      clean = cleanSettings(Object.fromEntries(Object.entries(change).filter(([, v]) => v !== null)));
    } catch (e) {
      throw new SettingsError((e as Error).message);
    }
    const values = { ...s.values, ...clean };
    for (const k of removed) delete values[k];
    this.write(id, { ...s, values, updatedAt: Date.now() });
    return values;
  }

  /** Sets the OpenRouter key. An empty key removes it. */
  setApiKey(id: string, key: string): void {
    const k = key.trim();
    if (k && !/^[\w-]{20,200}$/.test(k)) throw new SettingsError("This does not look like an OpenRouter key (sk-or-…)");
    const s = this.settings(id);
    this.write(id, { ...s, apiKey: k ? encrypt(k, this.key) : undefined, updatedAt: Date.now() });
  }

  apiKey(id: string): string {
    const enc = this.settings(id).apiKey;
    if (!enc) return "";
    try {
      return decrypt(enc, this.key);
    } catch {
      return "";
    }
  }

  keyHint(id: string): string | null {
    const k = this.apiKey(id);
    return k ? `…${k.slice(-4)}` : null;
  }
}
