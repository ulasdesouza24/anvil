/** The URLs that the request or the task spec names. A placeholder such as {n} becomes "1", so the URL can be probed. */
export function namedUrls(...texts: unknown[]): string[] {
  const urls = new Set<string>();
  for (const t of texts) {
    const text = typeof t === "string" ? t : JSON.stringify(t ?? "");
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>`)\]]+/g)) urls.add(m[0].replace(/[.,;:]+$/, "").replace(/\{[^}]*\}/g, "1"));
  }
  return [...urls];
}

/**
 * The fixed part of a URL that the request names: the text before the first
 * placeholder. A spec uses the named source when one of its strings has this part.
 */
export function namedUrlPrefixes(request: unknown): string[] {
  const text = typeof request === "string" ? request : "";
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>`)\]]+/g)) out.add(m[0].replace(/[.,;:]+$/, "").split("{")[0]);
  return [...out];
}

/** The named URLs that no string of the value uses. */
export function missingNamedUrls(request: unknown, value: unknown): string[] {
  const text = JSON.stringify(value ?? "");
  return namedUrlPrefixes(request).filter((p) => !text.includes(p));
}

/** The part of a source plan that the compiler needs (src/builder/sources.ts has the full type). */
export interface PlannedSources {
  needs: {
    need: { id: string };
    primary: { candidate: { url?: string; classType?: string } } | null;
    fallbacks: { candidate: { url?: string; classType?: string } }[];
    use?: { nodeType: string };
    complements?: { source: { candidate: { url?: string; classType?: string } } }[];
  }[];
}

/**
 * The data needs whose tested sources no node uses. A need is covered when a
 * node has the planned class type, or a string has the URL of the primary
 * source or of a fallback (without its query, so parameters can change).
 */
export function missingPlannedSources(plan: PlannedSources | undefined, nodes: { type: string; config?: unknown }[]): string[] {
  if (!plan?.needs?.length) return [];
  const types = new Set(nodes.map((n) => n.type));
  const text = JSON.stringify(nodes.map((n) => n.config ?? null));
  const base = (u: string) => u.split("?")[0].replace(/\/+$/, "");
  const missing: string[] = [];
  for (const n of plan.needs) {
    if (!n.primary) continue;
    // A built-in tool (for example web_search for open-ended research): a node of that type, or a node that lists the tool, covers it.
    const builtIn = n.primary.candidate.classType;
    if (builtIn && !builtIn.startsWith("x_") && !n.primary.candidate.url) {
      if (!types.has(builtIn) && !text.includes(`"${builtIn}"`)) missing.push(n.need.id);
      continue;
    }
    const refs = [n.primary, ...(n.fallbacks ?? []), ...(n.complements ?? []).map((c) => c.source)].map((p) => p.candidate);
    const classes = [n.use?.nodeType, ...refs.map((c) => c.classType)].filter((t): t is string => !!t && t.startsWith("x_"));
    const urls = refs.map((c) => c.url).filter((u): u is string => !!u).map(base);
    if (!classes.some((t) => types.has(t)) && !urls.some((u) => text.includes(u))) missing.push(n.need.id);
  }
  return missing;
}
