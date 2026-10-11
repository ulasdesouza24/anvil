import type { SearchHit } from "../core/tools/web.js";

/**
 * A cache for web search results. The key ignores case, accents, punctuation,
 * and word order, so similar queries share one entry. Entries expire after
 * `ttlMs`. The cache keeps at most `max` entries and removes the oldest first.
 */
export interface SearchCacheEntry {
  results: SearchHit[];
  provider: string;
  at: number;
}

export interface SearchCachePersistence {
  load(): Promise<Record<string, SearchCacheEntry>>;
  save(entries: Record<string, SearchCacheEntry>): Promise<void>;
}

export function searchKey(query: string, limit: number): string {
  const words = query
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return `${[...new Set(words)].sort().join(" ")}#${limit}`;
}

export class SearchCache {
  private entries = new Map<string, SearchCacheEntry>();
  private loaded?: Promise<void>;
  private saveTimer?: NodeJS.Timeout;
  hits = 0;
  misses = 0;

  constructor(private opts: { ttlMs: number; max: number; persistence?: SearchCachePersistence; now?: () => number }) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private async ready() {
    if (!this.opts.persistence) return;
    this.loaded ??= this.opts.persistence
      .load()
      .then((saved) => {
        for (const [k, v] of Object.entries(saved)) this.entries.set(k, v);
      })
      .catch(() => undefined);
    await this.loaded;
  }

  async get(query: string, limit: number): Promise<SearchCacheEntry | undefined> {
    if (this.opts.ttlMs <= 0) return undefined;
    await this.ready();
    const k = searchKey(query, limit);
    const e = this.entries.get(k);
    if (!e || this.now() - e.at > this.opts.ttlMs) {
      if (e) this.entries.delete(k);
      this.misses++;
      return undefined;
    }
    // Move the entry to the end, so the oldest entries go first.
    this.entries.delete(k);
    this.entries.set(k, e);
    this.hits++;
    return e;
  }

  async set(query: string, limit: number, results: SearchHit[], provider: string) {
    if (this.opts.ttlMs <= 0 || !results.length) return;
    await this.ready();
    const k = searchKey(query, limit);
    this.entries.delete(k);
    this.entries.set(k, { results, provider, at: this.now() });
    while (this.entries.size > this.opts.max) this.entries.delete(this.entries.keys().next().value!);
    this.scheduleSave();
  }

  private scheduleSave() {
    if (!this.opts.persistence || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.opts.persistence!.save(Object.fromEntries(this.entries)).catch(() => undefined);
    }, 2000);
    this.saveTimer.unref?.();
  }
}
