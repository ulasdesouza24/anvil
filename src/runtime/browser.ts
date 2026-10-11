import fs from "node:fs";
import { chromium, type Browser, type BrowserContext } from "playwright-core";

/**
 * A shared headless browser for pages that need JavaScript. It reads the text
 * and tables after the scripts run, and it records the JSON responses that the
 * page loads (the API that the site itself calls).
 *
 * Rules: one browser for the process, a limit of open pages, a minimum time
 * between two visits to the same domain, and robots.txt is obeyed. The service
 * does not solve CAPTCHAs. It reports the page as blocked.
 */

export type BrowserAction =
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "press"; key: string; selector?: string }
  | { type: "wait"; ms?: number; selector?: string }
  | { type: "scroll"; times?: number };

export interface BrowseRequest {
  url: string;
  /** A CSS selector to wait for before the extraction. */
  waitFor?: string;
  /** Extra time to wait after the page loads, in ms. */
  waitMs?: number;
  actions?: BrowserAction[];
  captureNetwork?: boolean;
  maxChars?: number;
  timeoutMs?: number;
  /** Also return the HTML of the page. */
  html?: boolean;
}

export interface CapturedResponse {
  url: string;
  method: string;
  status: number;
  contentType: string;
  postData?: string;
  /** Request headers without cookies and credentials. */
  headers: Record<string, string>;
  /** The JSON body, truncated for the context. */
  sample: unknown;
  bytes: number;
}

export interface BrowseResult {
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  text: string;
  truncated: boolean;
  tables: string[][][];
  links: { text: string; href: string }[];
  network: CapturedResponse[];
  /** Set when the page shows a CAPTCHA or a bot challenge, or robots.txt does not allow the URL. */
  blocked: { reason: string } | null;
  html?: string;
  durationMs: number;
}

export interface BrowserConfig {
  executablePath?: string;
  headless: boolean;
  maxPages: number;
  navTimeoutMs: number;
  domainIntervalMs: number;
  respectRobots: boolean;
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 AnvilAgent/1.0";

/** Other Chromium-based browsers to try when the Playwright browser does not start. */
const FALLBACK_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
];

const BLOCK_MARKERS: { re: RegExp; reason: string }[] = [
  { re: /g-recaptcha|recaptcha\/api|grecaptcha/i, reason: "reCAPTCHA" },
  { re: /hcaptcha\.com|h-captcha/i, reason: "hCaptcha" },
  { re: /challenges\.cloudflare\.com|cf-turnstile|cf-challenge|Just a moment\.\.\./i, reason: "Cloudflare challenge" },
  { re: /verify (that )?you are (a )?human|are you a robot|unusual traffic from your computer/i, reason: "bot check" },
  { re: /<title>\s*Request Rejected\s*<\/title>|The requested URL was rejected/i, reason: "web application firewall" },
  { re: /<title>\s*(Access Denied|403 Forbidden|Attention Required!)[^<]*<\/title>/i, reason: "access denied" },
];

/** Returns the reason when a page is a CAPTCHA, a bot check, or a firewall rejection. */
export function detectBlock(html: string, text = ""): string | null {
  return BLOCK_MARKERS.find((m) => m.re.test(html) || m.re.test(text))?.reason ?? null;
}

/** A small robots.txt reader (the "*" group only). */
export function robotsAllows(robots: string, path: string): boolean {
  let active = false;
  const rules: { allow: boolean; path: string }[] = [];
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") active = value === "*";
    else if (active && (key === "disallow" || key === "allow") && value) rules.push({ allow: key === "allow", path: value });
  }
  // The longest matching rule wins (RFC 9309). "*" matches any characters, and "$" anchors the end.
  let best: { allow: boolean; length: number } | undefined;
  for (const r of rules) {
    const anchored = r.path.endsWith("$");
    const body = anchored ? r.path.slice(0, -1) : r.path;
    const re = new RegExp(
      `^${body
        .split("*")
        .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}${anchored ? "$" : ""}`,
    );
    if (!re.test(path)) continue;
    if (!best || r.path.length > best.length || (r.path.length === best.length && r.allow)) best = { allow: r.allow, length: r.path.length };
  }
  return best ? best.allow : true;
}

function truncateJson(v: unknown, max = 4000): unknown {
  const s = JSON.stringify(v);
  if (!s || s.length <= max) return v;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    let size = 2;
    for (const item of v) {
      const part = JSON.stringify(item) ?? "";
      if (size + part.length > max) break;
      out.push(item);
      size += part.length + 1;
    }
    return { truncatedArray: out, total: v.length };
  }
  return { truncatedJson: s.slice(0, max) };
}

/** This script runs inside the page. It is a string, so the server code does not need DOM types. */
const EXTRACT_SCRIPT = `(() => {
  const tables = [...document.querySelectorAll("table")].slice(0, 10).map((t) =>
    [...t.querySelectorAll("tr")].slice(0, 200).map((tr) => [...tr.querySelectorAll("th,td")].map((c) => c.innerText.trim())));
  const links = [...document.querySelectorAll("a[href]")].slice(0, 80)
    .map((a) => ({ text: a.innerText.trim().slice(0, 120), href: a.href }))
    .filter((l) => l.text && /^https?:/.test(l.href));
  return { title: document.title, text: document.body ? document.body.innerText : "", tables, links, html: document.documentElement.outerHTML };
})()`;

export class BrowserService {
  private browser?: Promise<Browser>;
  private context?: Promise<BrowserContext>;
  private open = 0;
  private waiters: (() => void)[] = [];
  private lastVisit = new Map<string, number>();
  private robots = new Map<string, Promise<string>>();
  launchedWith?: string;

  constructor(private cfg: BrowserConfig) {}

  private async launch(): Promise<Browser> {
    const candidates = [this.cfg.executablePath, undefined, ...FALLBACK_PATHS.filter((p) => fs.existsSync(p))].filter((p, i, a) => a.indexOf(p) === i);
    const errors: string[] = [];
    for (const executablePath of candidates) {
      try {
        const b = await chromium.launch({ headless: this.cfg.headless, executablePath, args: ["--disable-blink-features=AutomationControlled"] });
        this.launchedWith = executablePath ?? "playwright chromium";
        return b;
      } catch (e) {
        errors.push(`${executablePath ?? "playwright chromium"}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    throw new Error(`No browser could start. Set ANVIL_BROWSER_PATH, or run "npx playwright install chromium". Tried: ${errors.join(" | ")}`);
  }

  private async ctx(): Promise<BrowserContext> {
    this.browser ??= this.launch().catch((e) => {
      this.browser = undefined;
      throw e;
    });
    this.context ??= this.browser
      .then((b) => b.newContext({ userAgent: UA, locale: "en-US", viewport: { width: 1280, height: 900 } }))
      .catch((e) => {
        this.context = undefined;
        throw e;
      });
    return this.context;
  }

  private async slot() {
    if (this.open < this.cfg.maxPages) {
      this.open++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.open++;
  }

  private release() {
    this.open--;
    this.waiters.shift()?.();
  }

  private async politeWait(host: string) {
    const last = this.lastVisit.get(host) ?? 0;
    const wait = last + this.cfg.domainIntervalMs - Date.now();
    this.lastVisit.set(host, Math.max(Date.now(), last + this.cfg.domainIntervalMs));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  private async robotsTxt(origin: string): Promise<string> {
    let p = this.robots.get(origin);
    if (!p) {
      p = fetch(`${origin}/robots.txt`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) })
        .then((r) => (r.ok ? r.text() : ""))
        .catch(() => "");
      this.robots.set(origin, p);
    }
    return p;
  }

  async browse(req: BrowseRequest, signal?: AbortSignal): Promise<BrowseResult> {
    const started = Date.now();
    const url = new URL(req.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Only http(s) URLs are allowed: ${req.url}`);
    const empty = (reason: string): BrowseResult => ({
      url: req.url,
      finalUrl: req.url,
      status: 0,
      title: "",
      text: "",
      truncated: false,
      tables: [],
      links: [],
      network: [],
      blocked: { reason },
      durationMs: Date.now() - started,
    });
    if (this.cfg.respectRobots && !robotsAllows(await this.robotsTxt(url.origin), url.pathname + url.search)) return empty("robots.txt does not allow this URL");

    await this.slot();
    const context = await this.ctx().catch((e) => {
      this.release();
      throw e;
    });
    const page = await context.newPage();
    const onAbort = () => void page.close().catch(() => undefined);
    signal?.addEventListener("abort", onAbort);
    const network: CapturedResponse[] = [];
    try {
      await this.politeWait(url.host);
      // Images, fonts and media are not necessary for the text. Blocking them makes pages load faster.
      await page.route("**/*", (route) => (["image", "font", "media"].includes(route.request().resourceType()) ? route.abort() : route.continue()));
      if (req.captureNetwork) {
        page.on("response", async (res) => {
          const r = res.request();
          if (!["xhr", "fetch"].includes(r.resourceType()) || network.length >= 25) return;
          const type = res.headers()["content-type"] ?? "";
          if (!/json|javascript|text\/plain/.test(type)) return;
          try {
            const body = await res.text();
            let sample: unknown = body.slice(0, 2000);
            try {
              sample = truncateJson(JSON.parse(body));
            } catch {
              if (!/json/.test(type)) return;
            }
            const headers = Object.fromEntries(Object.entries(r.headers()).filter(([k]) => !/cookie|authorization|token|secret/i.test(k)));
            network.push({ url: res.url(), method: r.method(), status: res.status(), contentType: type, postData: r.postData() ?? undefined, headers, sample, bytes: body.length });
          } catch {
            /* the page closed before the body arrived */
          }
        });
      }
      const timeout = req.timeoutMs ?? this.cfg.navTimeoutMs;
      const resp = await page.goto(req.url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 10_000) }).catch(() => undefined);
      for (const a of req.actions ?? []) {
        if (a.type === "click") await page.click(a.selector, { timeout: 10_000 });
        else if (a.type === "fill") await page.fill(a.selector, a.value, { timeout: 10_000 });
        else if (a.type === "press") await (a.selector ? page.press(a.selector, a.key) : page.keyboard.press(a.key));
        else if (a.type === "wait") await (a.selector ? page.waitForSelector(a.selector, { timeout: 15_000 }) : page.waitForTimeout(Math.min(a.ms ?? 1000, 15_000)));
        else if (a.type === "scroll") for (let i = 0; i < Math.min(a.times ?? 1, 20); i++) await page.mouse.wheel(0, 2000).then(() => page.waitForTimeout(300));
      }
      if (req.waitFor) await page.waitForSelector(req.waitFor, { timeout: 15_000 }).catch(() => undefined);
      if (req.waitMs) await page.waitForTimeout(Math.min(req.waitMs, 15_000));
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);

      const data = (await page.evaluate(EXTRACT_SCRIPT)) as { title: string; text: string; tables: string[][][]; links: { text: string; href: string }[]; html: string };
      const max = req.maxChars ?? 20_000;
      const blockReason = detectBlock(data.html, data.text);
      const status = resp?.status() ?? 0;
      return {
        url: req.url,
        finalUrl: page.url(),
        status,
        title: data.title,
        text: data.text.slice(0, max),
        truncated: data.text.length > max,
        tables: data.tables,
        links: data.links,
        network,
        blocked: blockReason ? { reason: blockReason } : null,
        html: req.html ? data.html.slice(0, max * 2) : undefined,
        durationMs: Date.now() - started,
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await page.close().catch(() => undefined);
      this.release();
    }
  }

  /**
   * Sends a captured request again without the browser. When the answer is
   * the same kind of JSON, the endpoint can become a cheap http class.
   */
  async replay(c: CapturedResponse): Promise<{ ok: boolean; status: number; sample: unknown; reason?: string }> {
    try {
      const headers = { ...c.headers, "user-agent": UA };
      delete (headers as Record<string, string>)["content-length"];
      const res = await fetch(c.url, { method: c.method, headers, body: c.method === "GET" || c.method === "HEAD" ? undefined : c.postData, signal: AbortSignal.timeout(15_000) });
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, status: res.status, sample: text.slice(0, 300), reason: "the answer is not JSON" };
      }
      const sameKind = Array.isArray(json) === Array.isArray((c.sample as { truncatedArray?: unknown })?.truncatedArray ?? c.sample);
      return {
        ok: res.ok && sameKind,
        status: res.status,
        sample: truncateJson(json, 1500),
        reason: res.ok ? (sameKind ? undefined : "the answer has a different shape") : `HTTP ${res.status}`,
      };
    } catch (e) {
      return { ok: false, status: 0, sample: null, reason: (e as Error).message };
    }
  }

  async close() {
    const b = this.browser;
    this.browser = undefined;
    this.context = undefined;
    await (await b?.catch(() => undefined))?.close().catch(() => undefined);
  }
}

/** A draft http class for a captured endpoint that works without the browser. */
export function endpointClassDraft(c: CapturedResponse, opts: { type: string; title: string; description: string }): Record<string, unknown> {
  const u = new URL(c.url);
  const query = Object.fromEntries([...u.searchParams.keys()].map((k) => [k, `{{config.${k.replace(/[^A-Za-z0-9_]/g, "_")}}}`]));
  const properties = Object.fromEntries([...u.searchParams.entries()].map(([k, v]) => [k.replace(/[^A-Za-z0-9_]/g, "_"), { type: "string", default: v }]));
  u.search = "";
  const sampleKeys = c.sample && typeof c.sample === "object" && !Array.isArray(c.sample) ? Object.keys(c.sample as object).slice(0, 20) : [];
  return {
    type: opts.type,
    title: opts.title,
    category: "tool",
    description: opts.description,
    whenToUse: `When an agent needs the data from ${u.host}.`,
    configSchema: { type: "object", properties },
    outputSchema: { type: "object", properties: { data: { description: "The JSON answer of the endpoint" } }, required: ["data"] },
    example: Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, (v as { default: string }).default])),
    sideEffects: c.method !== "GET",
    impl: {
      kind: "http",
      request: {
        method: c.method,
        url: u.toString(),
        query,
        ...(c.postData ? { body: c.postData } : {}),
        headers: c.headers["content-type"] ? { "content-type": c.headers["content-type"] } : undefined,
      },
      transform: "return { data: response };",
    },
    tests: [{ name: "captured request", config: {}, checks: [{ path: "data", op: "exists" }] }],
    meta: { capturedFrom: c.url, sampleKeys },
  };
}
