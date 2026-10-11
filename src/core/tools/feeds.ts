import { decodeEntities } from "./web.js";

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  published?: string;
  summary: string;
}

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  if (!m) return undefined;
  const raw = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  // Feeds often carry escaped HTML: decode, strip tags, decode again.
  return decodeEntities(decodeEntities(raw.replace(/<[^>]+>/g, " ")).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attr(block: string, name: string, attribute: string): string | undefined {
  const m = new RegExp(`<${name}\\b[^>]*\\b${attribute}=["']([^"']+)["'][^>]*>`, "i").exec(block);
  return m ? decodeEntities(m[1]) : undefined;
}

/** Parses RSS 2.0 and Atom feeds without dependencies. Newest-first order is preserved. */
export function parseFeed(xml: string): { title: string; items: FeedItem[] } {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = [...xml.matchAll(isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const channel = xml.replace(/<(item|entry)\b[\s\S]*?<\/\1>/gi, "");
  const items = blocks.map((b) => {
    const link = isAtom ? (attr(b, "link", "href") ?? tag(b, "link") ?? "") : (tag(b, "link") ?? attr(b, "link", "href") ?? "");
    const title = tag(b, "title") ?? "(untitled)";
    const id = tag(b, "guid") ?? tag(b, "id") ?? (link || title);
    const summary = (tag(b, "description") ?? tag(b, "summary") ?? tag(b, "content") ?? tag(b, "content:encoded") ?? "").slice(0, 2000);
    const published = tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date");
    return { id, title, link, published, summary };
  });
  return { title: tag(channel, "title") ?? "", items };
}
