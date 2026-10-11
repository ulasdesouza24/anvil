import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

/**
 * The package gate (docs/SANDBOX.md, section 2.8). It works like a company
 * package mirror (for example Nexus): pip in the sandbox gets packages only
 * from here, and the sandbox has no other way to the internet.
 *
 * For each project, the gate reads the index of the upstream (PyPI or a
 * mirror) and gives pip only the files that pass all checks:
 * - wheels only (a source package runs code when it installs),
 * - not yanked,
 * - not on the deny list, and on the allow list when there is one,
 * - no known vulnerability in OSV for that version (fail-closed: no answer means no file).
 * Each file is checked against its sha256 and kept in a cache.
 */

export interface GateOptions {
  /** The upstream simple index, for example https://pypi.org/simple or a Nexus repository. */
  index: string;
  vulnCheck: "osv" | "off";
  allow: string[];
  deny: string[];
  cacheDir: string;
  osvUrl?: string;
  maxFileBytes?: number;
  fetch?: typeof fetch;
}

export interface GateDecision {
  at: number;
  /** The address of the sandbox that asked (from the sidecar). */
  client: string;
  project: string;
  version?: string;
  file?: string;
  decision: "allowed" | "blocked";
  reason: string;
}

interface UpstreamFile {
  filename: string;
  url: string;
  sha256?: string;
  requiresPython?: string;
  yanked: boolean;
}

/** PEP 503 name normalization. */
export const normalizeName = (n: string) => n.toLowerCase().replace(/[-_.]+/g, "-");

/** The version in a wheel file name: {name}-{version}(-{build})?-{python}-{abi}-{platform}.whl. */
export function wheelVersion(filename: string): string | null {
  if (!filename.endsWith(".whl")) return null;
  const parts = filename.slice(0, -4).split("-");
  return parts.length >= 5 ? parts[1] : null;
}

/** Reads the files of a project from a PEP 691 JSON page or a PEP 503 HTML page. */
export function parseIndex(body: string, contentType: string, baseUrl: string): UpstreamFile[] {
  if (/json/.test(contentType)) {
    const j = JSON.parse(body) as { files?: { filename: string; url: string; hashes?: Record<string, string>; "requires-python"?: string; yanked?: unknown }[] };
    return (j.files ?? []).map((f) => ({
      filename: f.filename,
      url: new URL(f.url, baseUrl).toString(),
      sha256: f.hashes?.sha256,
      requiresPython: f["requires-python"] ?? undefined,
      yanked: !!f.yanked,
    }));
  }
  const files: UpstreamFile[] = [];
  for (const m of body.matchAll(/<a\s([^>]*)>([^<]*)<\/a>/gi)) {
    const attrs = m[1];
    const href = /href="([^"]+)"/i.exec(attrs)?.[1];
    if (!href) continue;
    const url = new URL(href.replace(/&amp;/g, "&"), baseUrl);
    const sha256 = /sha256=([a-f0-9]{64})/i.exec(url.hash)?.[1];
    url.hash = "";
    const rp = /data-requires-python="([^"]*)"/i.exec(attrs)?.[1]?.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    files.push({ filename: m[2].trim() || path.basename(url.pathname), url: url.toString(), sha256, requiresPython: rp, yanked: /data-yanked/i.test(attrs) });
  }
  return files;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export class PackageGate {
  readonly decisions: GateDecision[] = [];
  private files = new Map<string, UpstreamFile>();
  private osvCache = new Map<string, boolean>();
  private server: http.Server | null = null;
  private readonly fetch: typeof fetch;
  /** The egress check of the allowlist mode: may this sandbox client contact this host? */
  egressHook?: (client: string, host: string, port: number) => { allowed: boolean; reason?: string };

  constructor(private opts: GateOptions) {
    this.fetch = opts.fetch ?? fetch;
  }

  private record(d: Omit<GateDecision, "at">) {
    this.decisions.push({ at: Date.now(), ...d });
    if (this.decisions.length > 2000) this.decisions.splice(0, 1000);
  }

  /** The decisions for one sandbox client since a time. */
  decisionsFor(client: string, since: number): GateDecision[] {
    return this.decisions.filter((d) => d.client === client && d.at >= since);
  }

  /** The vulnerable versions of a project, from OSV. Throws when OSV does not answer (fail-closed). */
  private async vulnerable(project: string, versions: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    const ask = versions.filter((v) => !this.osvCache.has(`${project}@${v}`));
    for (let i = 0; i < ask.length; i += 500) {
      const batch = ask.slice(i, i + 500);
      const res = await this.fetch(this.opts.osvUrl ?? "https://api.osv.dev/v1/querybatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries: batch.map((version) => ({ package: { name: project, ecosystem: "PyPI" }, version })) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`OSV answered HTTP ${res.status}`);
      const j = (await res.json()) as { results?: { vulns?: unknown[] }[] };
      batch.forEach((v, k) => this.osvCache.set(`${project}@${v}`, (j.results?.[k]?.vulns?.length ?? 0) > 0));
    }
    for (const v of versions) if (this.osvCache.get(`${project}@${v}`)) out.add(v);
    return out;
  }

  /** The simple index page of a project with only the files that pass the checks. */
  async projectPage(rawName: string, client: string): Promise<{ status: number; body: string }> {
    const project = normalizeName(rawName);
    if (this.opts.deny.map(normalizeName).includes(project)) {
      this.record({ client, project, decision: "blocked", reason: "the project is on the deny list" });
      return { status: 404, body: "the project is on the deny list" };
    }
    if (this.opts.allow.length && !this.opts.allow.map(normalizeName).includes(project)) {
      this.record({ client, project, decision: "blocked", reason: "the project is not on the allow list" });
      return { status: 404, body: "the project is not on the allow list" };
    }
    const url = `${this.opts.index.replace(/\/+$/, "")}/${project}/`;
    const res = await this.fetch(url, { headers: { Accept: "application/vnd.pypi.simple.v1+json, text/html;q=0.5" }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) return { status: 404, body: "not found" };
    if (!res.ok) return { status: 502, body: `the index answered HTTP ${res.status}` };
    const all = parseIndex(await res.text(), res.headers.get("content-type") ?? "", url);
    const wheels = all.filter((f) => f.filename.endsWith(".whl") && !f.yanked && f.sha256 && wheelVersion(f.filename));
    const versions = [...new Set(wheels.map((f) => wheelVersion(f.filename)!))];
    let bad = new Set<string>();
    if (this.opts.vulnCheck === "osv" && versions.length) {
      try {
        bad = await this.vulnerable(project, versions);
      } catch (e) {
        this.record({ client, project, decision: "blocked", reason: `the vulnerability check is not available (${(e as Error).message}). The gate blocks the install.` });
        return { status: 200, body: this.html(project, []) };
      }
    }
    const ok = wheels.filter((f) => !bad.has(wheelVersion(f.filename)!));
    for (const v of bad) this.record({ client, project, version: v, decision: "blocked", reason: "OSV lists a known vulnerability for this version" });
    if (!wheels.length) this.record({ client, project, decision: "blocked", reason: "the project has no wheel (source packages are not installed)" });
    for (const f of ok) this.files.set(`${project}/${f.filename}`, f);
    return { status: 200, body: this.html(project, ok) };
  }

  private html(project: string, files: UpstreamFile[]): string {
    const links = files
      .map((f) => `<a href="/files/${project}/${encodeURIComponent(f.filename)}#sha256=${f.sha256}"${f.requiresPython ? ` data-requires-python="${esc(f.requiresPython)}"` : ""}>${esc(f.filename)}</a><br/>`)
      .join("\n");
    return `<!DOCTYPE html><html><body><h1>Links for ${esc(project)}</h1>\n${links}\n</body></html>`;
  }

  /** One package file: from the cache, or from the upstream after a sha256 check. */
  async file(project: string, filename: string, client: string): Promise<{ status: number; body: Buffer | string }> {
    const key = `${normalizeName(project)}/${filename}`;
    const f = this.files.get(key);
    if (!f?.sha256) return { status: 404, body: "the gate did not approve this file. Read the project page first." };
    const cached = path.join(this.opts.cacheDir, f.sha256);
    if (fs.existsSync(cached)) {
      this.record({ client, project: normalizeName(project), version: wheelVersion(filename) ?? undefined, file: filename, decision: "allowed", reason: "from the cache" });
      return { status: 200, body: fs.readFileSync(cached) };
    }
    const res = await this.fetch(f.url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return { status: 502, body: `the upstream answered HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > (this.opts.maxFileBytes ?? 200_000_000)) return { status: 502, body: "the file is too large" };
    const sha = createHash("sha256").update(buf).digest("hex");
    if (sha !== f.sha256) {
      this.record({ client, project: normalizeName(project), file: filename, decision: "blocked", reason: "the sha256 of the file does not agree with the index" });
      return { status: 502, body: "the sha256 of the file does not agree with the index" };
    }
    fs.mkdirSync(this.opts.cacheDir, { recursive: true });
    fs.writeFileSync(cached, buf);
    this.record({ client, project: normalizeName(project), version: wheelVersion(filename) ?? undefined, file: filename, decision: "allowed", reason: "the checks passed" });
    return { status: 200, body: buf };
  }

  /** Starts the HTTP server of the gate on the host loopback. */
  async listen(port: number, host = "127.0.0.1"): Promise<number> {
    if (this.server) return (this.server.address() as { port: number }).port;
    const server = http.createServer(async (req, res) => {
      const client = String(req.headers["x-anvil-client"] ?? req.socket.remoteAddress ?? "");
      try {
        const u = new URL(req.url ?? "/", "http://gate");
        const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
        if (req.method !== "GET") return void res.writeHead(405).end();
        if (parts[0] === "egress" && parts.length === 1) {
          // Only the sidecar calls this path: the host listens on the loopback, and the sidecar forwards only package paths.
          const d = this.egressHook?.(u.searchParams.get("client") ?? "", (u.searchParams.get("host") ?? "").toLowerCase(), Number(u.searchParams.get("port") ?? 0)) ?? {
            allowed: false,
            reason: "the allowlist mode is not active",
          };
          return void res.writeHead(d.allowed ? 200 : 403, { "Content-Type": "text/plain" }).end(d.reason ?? "");
        }
        if (parts[0] === "simple" && parts.length === 2) {
          const r = await this.projectPage(parts[1], client);
          return void res.writeHead(r.status, { "Content-Type": "text/html" }).end(r.body);
        }
        if (parts[0] === "files" && parts.length === 3) {
          const r = await this.file(parts[1], parts[2], client);
          return void res.writeHead(r.status, { "Content-Type": "application/octet-stream" }).end(r.body);
        }
        res.writeHead(404).end("not found");
      } catch (e) {
        res.writeHead(502).end(String((e as Error).message).slice(0, 200));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    this.server = server;
    return (server.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }
}
