import { loadConfig, type LiveConfig } from "../config.js";
import { liveFetch } from "../liveFetch.js";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Readable-text extraction from HTML without dependencies. */
/** A table of a page: its column names and its rows (one record for each row). */
export interface PageTable {
  columns: string[];
  rows: Record<string, string>[];
  /** The number of rows in the page. `rows` can have fewer (a limit). */
  totalRows: number;
}

const cellText = (html: string) => decodeEntities(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** The cells of each row of one table. Nested tables are not split. */
function tableGrid(tableHtml: string): { cells: string[]; header: boolean }[] {
  const out: { cells: string[]; header: boolean }[] = [];
  for (const tr of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<(t[hd])[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => cellText(c[2]));
    if (cells.some((c) => c)) out.push({ cells, header: /<th[\s>]/i.test(tr[1]) && !/<td[\s>]/i.test(tr[1]) });
  }
  return out;
}

/**
 * The data tables of a page. The first row is the header when it has th cells or when
 * no row has them. Each row becomes a record with the column names, so a model or a
 * program does not have to guess which value belongs to which column.
 */
export function extractTables(html: string, opts: { maxTables?: number; maxRows?: number } = {}): PageTable[] {
  const tables: PageTable[] = [];
  for (const m of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    if (tables.length >= (opts.maxTables ?? 10)) break;
    const grid = tableGrid(m[1]);
    if (grid.length < 2) continue;
    const headIdx = grid.findIndex((r) => r.header);
    const head = grid[headIdx >= 0 ? headIdx : 0].cells;
    const columns = head.map((h, i) => h || `column_${i + 1}`);
    const body = grid.slice((headIdx >= 0 ? headIdx : 0) + 1).filter((r) => !r.header);
    const rows = body.slice(0, opts.maxRows ?? 500).map((r) => Object.fromEntries(columns.map((c, i) => [c, r.cells[i] ?? ""])));
    tables.push({ columns, rows, totalRows: body.length });
  }
  return tables;
}

/** A table as text: one line for each row, with the cells between "|". The header line comes first. */
function tableAsText(tableHtml: string): string {
  return `\n${tableGrid(tableHtml)
    .map((r) => `| ${r.cells.join(" | ")} |`)
    .join("\n")}\n`;
}

export function htmlToText(html: string): { title: string; text: string; links: { text: string; href: string }[] } {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").trim());
  let body = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|svg|iframe|template|head)[\s\S]*?<\/\1>/gi, " ");
  const main = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main && main[2].length > 500) body = main[2];
  const links: { text: string; href: string }[] = [];
  body.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
    if (text && links.length < 60 && /^https?:/.test(href)) links.push({ text: text.slice(0, 120), href });
    return "";
  });
  // A table keeps its rows and columns: one line for each row. Else the cells of a row become separate lines.
  body = body.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, inner: string) => tableAsText(inner).replace(/</g, "&lt;"));
  const text = decodeEntities(
    body
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|header|footer|nav)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<h([1-6])[^>]*>/gi, "\n## ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/\n\s*\n\s*(\n\s*)+/g, "\n\n")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .trim();
  return { title, text, links };
}

function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Only http(s) URLs are allowed: ${raw}`);
  return url;
}

export async function fetchUrl(
  raw: string,
  opts: { maxChars?: number; timeoutMs?: number; signal?: AbortSignal; live?: LiveConfig; runKind?: string } = {},
): Promise<{ url: string; status: number; title: string; text: string; links: { text: string; href: string }[]; truncated: boolean; tables: PageTable[] }> {
  const url = assertPublicUrl(raw);
  {
    const res = await liveFetch(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 AnvilAgent/1.0",
          Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
        },
        timeoutMs: opts.timeoutMs ?? 20_000,
        signal: opts.signal,
        runKind: opts.runKind,
      },
      opts.live ?? loadConfig().live,
    );
    const type = res.headers["content-type"] ?? "";
    const raw = res.text;
    let title = "";
    let text = raw;
    let links: { text: string; href: string }[] = [];
    let tables: PageTable[] = [];
    if (type.includes("html") || /^\s*<(!doctype|html)/i.test(raw)) {
      ({ title, text, links } = htmlToText(raw));
      tables = extractTables(raw);
    }
    const max = opts.maxChars ?? 20_000;
    return { url: res.url || url.toString(), status: res.status, title, text: text.slice(0, max), links, truncated: text.length > max, tables };
  }
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Keyless web search via DuckDuckGo's HTML endpoint (best effort). */
export async function webSearch(query: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<SearchHit[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  opts.signal?.addEventListener("abort", () => ctrl.abort());
  try {
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      },
      body: new URLSearchParams({ q: query }).toString(),
      signal: ctrl.signal,
    });
    const html = await res.text();
    const hits: SearchHit[] = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
    for (const m of html.matchAll(re)) {
      let href = decodeEntities(m[1]);
      const uddg = /[?&]uddg=([^&]+)/.exec(href);
      if (uddg) href = decodeURIComponent(uddg[1]);
      if (href.startsWith("//")) href = `https:${href}`;
      if (!/^https?:/.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
      hits.push({
        title: decodeEntities(m[2].replace(/<[^>]+>/g, "")).trim(),
        url: href,
        snippet: decodeEntities((m[3] ?? "").replace(/<[^>]+>/g, "")).trim(),
      });
      if (hits.length >= (opts.limit ?? 6)) break;
    }
    return hits;
  } finally {
    clearTimeout(timer);
  }
}

/** Keyless, official Wikipedia search API (reliable fallback for entities and facts). */
export async function wikipediaSearch(query: string, opts: { limit?: number; signal?: AbortSignal; lang?: string } = {}): Promise<SearchHit[]> {
  const lang = opts.lang ?? "en";
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=${opts.limit ?? 5}&srsearch=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "User-Agent": "AnvilAgent/1.0 (local)" }, signal: opts.signal });
  if (!res.ok) return [];
  const data = (await res.json()) as { query?: { search?: { title: string; snippet: string }[] } };
  return (data.query?.search ?? []).map((r) => ({
    title: r.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
    snippet: decodeEntities(r.snippet.replace(/<[^>]+>/g, "")),
  }));
}
