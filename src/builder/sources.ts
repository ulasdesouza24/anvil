import { z } from "zod";
import type { NodeClass, NodeContext } from "../core/registry.js";
import { namedUrls } from "../core/urls.js";
import { htmlToText } from "../core/tools/web.js";
import { detectBlock, endpointClassDraft, type CapturedResponse } from "../runtime/browser.js";
import { generateClass, type DataNeed, type TaskSpec } from "./nodes.js";
import { recordLessons, sourceHints, type LibraryContext, type NewLesson } from "./library.js";
import { rateLimitOf } from "../core/rateLimit.js";
import { liveFetch } from "../core/liveFetch.js";

/**
 * The source plan: before the architect designs the agent, this stage finds a
 * working data source for each data need. It probes each candidate for real,
 * first with plain HTTP and then with the browser. The decision model (Jev)
 * scores what it gets. API sources become tested classes at once. When a
 * required need has no working source, the build stops before the expensive
 * stages and tells why.
 */

export interface SourceCandidate {
  id: string;
  kind: "class" | "api" | "page";
  url?: string;
  classType?: string;
  description: string;
  /** The request names this URL. It goes first when it works. */
  named?: boolean;
}

export interface ProbeResult {
  candidate: SourceCandidate;
  /** How the agent gets the data: a library class, plain HTTP, or the browser. */
  access: "class" | "http" | "browser" | "none";
  status: number;
  reachable: boolean;
  blocked?: string;
  contentType?: string;
  sampleKeys: string[];
  sampleText: string;
  endpoint?: CapturedResponse;
  relevance: number;
  freshness: number;
  score: number;
  note?: string;
  /** The fields of the need that the sample has, and their share. */
  fields?: string[];
  coverage?: number;
  /** How long the probe took (ms). A slow source can time out when the agent runs. */
  latencyMs?: number;
}

export interface SourceUse {
  nodeType: string;
  config?: Record<string, unknown>;
}

export interface NeedPlan {
  need: DataNeed;
  primary: ProbeResult | null;
  fallbacks: ProbeResult[];
  tried: ProbeResult[];
  /** The node that the agent uses for this need. */
  use?: SourceUse;
  /** More sources for the fields that the primary source does not have. */
  complements?: { source: ProbeResult; fields: string[]; use: SourceUse }[];
  /** Fields that no tested source has. The agent must report them as gaps. */
  missingFields?: string[];
}

export interface SourcePlan {
  needs: NeedPlan[];
  unresolved: string[];
}

const MAX_NEEDS = 4;
const MAX_CANDIDATES = 5;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 AnvilAgent/1.0";

const keysOf = (v: unknown): string[] => {
  const x = Array.isArray(v) ? v[0] : v;
  return x && typeof x === "object" ? Object.keys(x as object).slice(0, 60) : [];
};

/**
 * An outline of a JSON sample for the relevance check. A plain cut of the
 * JSON text can hide the important fields: many APIs put long link fields and
 * nested objects first. The outline has two parts: all field names, then the
 * values that are not links (each one short).
 */
export function jsonOutline(v: unknown, max = 1600): string {
  const record = Array.isArray(v) ? v[0] : v;
  const head = Array.isArray(v) ? `A list of ${v.length} records. The first record:\n` : "";
  if (!record || typeof record !== "object") return `${head}${JSON.stringify(record ?? null).slice(0, max)}`;
  const isLink = (x: unknown) => typeof x === "string" && /^https?:\/\//.test(x);
  const all = Object.entries(record as Record<string, unknown>);
  const entries = all.filter(([, x]) => !isLink(x));
  const links = all.length - entries.length;
  const fields = `FIELDS: ${entries.map(([k]) => k).join(", ")}${links ? ` (and ${links} link fields)` : ""}`;
  // Nested objects show their fields to a depth of 3, so a field path such as commit.author.date is visible. Links are left out.
  const inner = (x: unknown, depth = 1): string =>
    x && typeof x === "object" && !Array.isArray(x)
      ? `{${Object.entries(x)
          .filter(([, v]) => !isLink(v))
          .slice(0, 8)
          .map(([k, v]) => `${k}: ${v !== null && typeof v === "object" ? (depth < 3 && !Array.isArray(v) ? inner(v, depth + 1) : "{…}") : JSON.stringify(v)}`)
          .join(", ")}}`
      : JSON.stringify(x);
  const short = (x: unknown): string => {
    if (Array.isArray(x)) return `list of ${x.length}${x.length && x[0] && typeof x[0] === "object" ? `. First item: ${inner(x[0])}` : ""}`;
    if (x && typeof x === "object") {
      const e = Object.entries(x);
      // A map keyed by data (for example dates or codes): its size, a key, and the first entry show the data.
      if (e.length > 3 && e.every(([, v]) => v !== null && typeof v === "object")) return `map of ${e.length} entries, keys like "${e[0][0]}". First entry: ${inner(e[0][1])}`;
      if (e.length > 8 && e.every(([, v]) => typeof v === "number")) return `map of ${e.length} numbers: ${inner(Object.fromEntries(e.slice(0, 6)))}`;
      return inner(x);
    }
    const t = typeof x === "string" ? JSON.stringify(x.length > 50 ? `${x.slice(0, 50)}…` : x) : String(x);
    return t;
  };
  const values = entries.map(([k, x]) => `${k}: ${short(x)}`).join("\n");
  const out = `${head}${fields}\nVALUES:\n${values}`;
  return out.length > max ? `${out.slice(0, max)}\n…` : out;
}

/** Why a probed candidate did not give the data, in a few words. */
export function probeOutcome(x: ProbeResult, relevanceThreshold: number): string {
  if (x.blocked) return `blocked (${x.blocked})`;
  if (!x.reachable) return `${x.note ?? "not reachable"} (HTTP ${x.status})`;
  if (x.relevance >= relevanceThreshold)
    return (x.coverage ?? 1) > 0 ? `usable (relevance ${x.relevance.toFixed(2)})` : `none of the needed fields (relevance ${x.relevance.toFixed(2)})`;
  return `not relevant (relevance ${x.relevance.toFixed(2)}, ${x.note ?? x.access})`;
}

/**
 * The source lessons of a plan: the selected source of each need worked, and a
 * blocked or rate-limited candidate did not. Built-in web research is not a source.
 */
export function sourceLessons(plan: SourcePlan, rateLimitPattern: string, from?: NewLesson["from"]): NewLesson[] {
  const out: NewLesson[] = [];
  for (const n of plan.needs) {
    const p = n.primary;
    if (p?.candidate.url) out.push({ kind: "source_ok", source: p.candidate.url, text: `${p.candidate.url} gives "${n.need.description}" (${p.access}).`, from });
    else if (p?.candidate.classType?.startsWith("x_"))
      out.push({ kind: "source_ok", source: p.candidate.classType, text: `The library class ${p.candidate.classType} gives "${n.need.description}".`, from });
    for (const x of n.tried) {
      const url = x.candidate.url;
      if (!url || url === p?.candidate.url) continue;
      if (x.blocked) out.push({ kind: "source_blocked", source: url, text: `${url} blocked the agent (${x.blocked}).`, from });
      else if (x.status === 429 || rateLimitOf(x.note, rateLimitPattern))
        out.push({ kind: "source_blocked", source: url, text: `${url} refused requests because of a rate limit.`, from });
    }
  }
  return out;
}

/** The node that uses a source without a class: http for an API, browser for a page that needs JavaScript, web_fetch for a page. */
function useOf(p: ProbeResult): SourceUse {
  if (p.access === "class") return { nodeType: p.candidate.classType! };
  if (p.access === "browser") return { nodeType: "browser", config: { url: p.candidate.url } };
  if (p.sampleKeys.length) return { nodeType: "http", config: { url: p.endpoint?.url ?? p.candidate.url } };
  return { nodeType: "web_fetch", config: { url: p.candidate.url } };
}

/** The plan as text for the architect. */
export function describeSourcePlan(p: SourcePlan): string {
  return p.needs
    .map((n) => {
      if (!n.primary || !n.use) return `- ${n.need.id} (${n.need.fields.join(", ")}): NO WORKING SOURCE. Do not invent one. The agent must report this gap.`;
      const fb = n.fallbacks.map((f) => f.candidate.url ?? f.candidate.classType).filter(Boolean);
      const primaryFields = n.primary.fields && n.complements?.length ? ` for the fields ${n.primary.fields.join(", ")}` : "";
      const more = (n.complements ?? []).map(
        (c) =>
          ` Also use node type "${c.use.nodeType}"${c.use.config ? ` with config ${JSON.stringify(c.use.config)}` : ""} for the fields ${c.fields.join(", ")}. Source: ${c.source.candidate.url} (${c.source.access}).`,
      );
      const gaps = n.missingFields?.length ? ` No tested source has the fields ${n.missingFields.join(", ")}: the agent must report them as gaps.` : "";
      return `- ${n.need.id} (${n.need.fields.join(", ")}): use node type "${n.use.nodeType}"${n.use.config ? ` with config ${JSON.stringify(n.use.config)}` : ""}${primaryFields}. Source: ${n.primary.candidate.url ?? n.primary.candidate.classType} (${n.primary.access}). Sample fields: ${n.primary.sampleKeys.join(", ") || "text"}.${more.join("")}${gaps}${fb.length ? ` Fallbacks for the harness: ${fb.join(", ")}.` : ""}`;
    })
    .join("\n");
}

/** Plain HTTP first. The browser runs when the answer is blocked, too short, or not data. */
async function probe(ctx: NodeContext<any>, c: SourceCandidate, browserOnly = false): Promise<ProbeResult> {
  const t0 = Date.now();
  const r = await probeOnce(ctx, c, browserOnly);
  return { ...r, latencyMs: Date.now() - t0 };
}

async function probeOnce(ctx: NodeContext<any>, c: SourceCandidate, browserOnly = false): Promise<ProbeResult> {
  const base: ProbeResult = { candidate: c, access: "none", status: 0, reachable: false, sampleKeys: [], sampleText: "", relevance: 0, freshness: 0, score: 0 };
  if (!c.url) return { ...base, note: "no url" };
  let plainText = "";
  let plainBlocked: string | null = null;
  if (!browserOnly)
    try {
      // The probe uses the same way as the agent: retries and host headers (docs/LIVE_DATA.md).
      const res = await liveFetch(c.url, { headers: { "User-Agent": UA, Accept: "application/json, text/html;q=0.9, */*;q=0.5" }, timeoutMs: 12_000, signal: ctx.signal }, ctx.brain.config.live);
      const type = res.headers["content-type"] ?? "";
      const body = res.text;
      base.status = res.status;
      base.contentType = type;
      if (res.ok && (/json/.test(type) || /^\s*[[{]/.test(body))) {
        try {
          const json = JSON.parse(body);
          return { ...base, access: "http", reachable: true, sampleKeys: keysOf(json), sampleText: jsonOutline(json) };
        } catch {
          /* not JSON after all */
        }
      }
      plainBlocked = detectBlock(body);
      plainText = /html/.test(type) ? htmlToText(body).text : body;
      if (res.ok && !plainBlocked && plainText.length >= 400) {
        return { ...base, access: "http", reachable: true, sampleText: plainText.slice(0, 1500), note: "static page" };
      }
    } catch (e) {
      base.note = `HTTP: ${(e as Error).message}`;
    }
  const browser = ctx.services.browser;
  if (!browser) return { ...base, blocked: plainBlocked ?? undefined, sampleText: plainText.slice(0, 1500), note: base.note ?? "the browser is not available" };
  try {
    const page = await browser.browse({ url: c.url, captureNetwork: true, waitMs: 1500, maxChars: 8000 }, ctx.signal);
    if (page.blocked) return { ...base, status: page.status, blocked: page.blocked.reason, note: "blocked in the browser too" };
    // The largest JSON response is usually the data of the page.
    const api = [...page.network].filter((n) => n.status < 400).sort((a, b) => b.bytes - a.bytes)[0];
    if (api) {
      const replay = await browser.replay(api);
      if (replay.ok)
        return {
          ...base,
          access: "http",
          status: replay.status,
          reachable: true,
          endpoint: api,
          sampleKeys: keysOf(api.sample),
          sampleText: jsonOutline(api.sample),
          note: "API captured in the browser",
        };
    }
    const tableText = page.tables.map((t) => t.map((r) => r.join(" | ")).join("\n")).join("\n\n");
    const text = `${tableText}\n${page.text}`.trim();
    return {
      ...base,
      access: text.length >= 100 ? "browser" : "none",
      status: page.status,
      reachable: text.length >= 100,
      sampleText: text.slice(0, 1500),
      note: api ? "the API needs the browser" : "rendered page",
    };
  } catch (e) {
    return { ...base, blocked: plainBlocked ?? undefined, note: `browser: ${(e as Error).message}` };
  }
}

const SourcesConfig = z.object({
  taskSpec: z.unknown(),
  /** Ask a person to approve the plan (when the build may ask questions). */
  approve: z.unknown().optional(),
  /** Continue when a required need has no working source. */
  allowUnresolved: z.unknown().optional(),
  /** The request of the person. A URL in it is a source that the person selected. */
  request: z.unknown().optional(),
  /** The library context of the build: the tested sources of the examples and the source lessons of the domain. */
  library: z.unknown().optional(),
});

const off = (v: unknown) => v === false || v === "false" || v === undefined || v === null;

export const AnvilSourcesNode: NodeClass<z.infer<typeof SourcesConfig>> = {
  type: "anvil_sources",
  title: "Source plan",
  category: "anvil",
  internal: true,
  defaultTimeoutMs: 0,
  description:
    "Finds a working data source for each data need of the task: library classes, public APIs and web pages. It probes each candidate (HTTP, then the browser with API capture), scores the samples with the decision model, makes API sources into tested classes, and stops the build when a required need has no source.",
  whenToUse: "Between analysis and the architect.",
  configSchema: SourcesConfig,
  example: { taskSpec: "{{nodes.analyze.output.taskSpec}}" },
  async execute(ctx) {
    const t = ctx.config.taskSpec as TaskSpec;
    const hints = sourceHints(ctx.config.library as LibraryContext | undefined);
    const needs = (t?.dataNeeds ?? []).slice(0, MAX_NEEDS);
    const plan: SourcePlan = { needs: [], unresolved: [] };
    if (!needs.length) {
      ctx.log("no external data needs — no source plan");
      return { output: { sourcePlan: null } };
    }

    // Open-ended web research is not one source: the built-in web_search and fetch_url tools serve it.
    const research = needs.length
      ? await ctx.brain.decide({
          purpose: "find web research needs",
          state: { request: ctx.config.request ?? null, needs: needs.map((n, i) => ({ i, id: n.id, description: n.description, fields: n.fields })) },
          questions: Object.fromEntries(
            needs.map((n, i) => [
              `w${i}`,
              {
                type: "noul" as const,
                instructions: `Is need #${i} ("${n.description}") open-ended web research? In such research, the agent searches the web and reads the pages that it finds. It has no fixed source. A specific API, dataset, or site is NOT open-ended research.`,
              },
            ]),
          ),
        })
      : {};
    for (const [i, need] of needs.entries()) {
      ctx.log(`finding sources for "${need.id}"`);
      const w = research[`w${i}`];
      if (w?.type === "noul" && w.noul >= ctx.brain.config.thresholds.sourceRelevance) {
        const builtIn: ProbeResult = {
          candidate: { id: "web_search", kind: "class", classType: "web_search", description: "the built-in web search and page reading tools (web_search, fetch_url)" },
          access: "class",
          status: 200,
          reachable: true,
          sampleKeys: ["results"],
          sampleText: "",
          relevance: w.noul,
          freshness: 1,
          fields: need.fields,
          coverage: 1,
          score: w.noul,
          note: "open-ended web research: no source to probe",
        };
        plan.needs.push({ need, primary: builtIn, fallbacks: [], tried: [], use: { nodeType: "web_search" } });
        ctx.emit({ type: "artifact", kind: "sourcePlan", data: plan });
        continue;
      }
      // 1) Classes that the library has already.
      const library = ctx.services.registry.list().filter((c) => c.custom && c.custom.status !== "failed");
      let libraryHits: ProbeResult[] = [];
      if (library.length) {
        const a = await ctx.brain.decide({
          purpose: `library classes for ${need.id}`,
          state: { need: need.description, fields: need.fields, classes: library.map((c, i) => ({ i, type: c.type, description: c.description })) },
          questions: Object.fromEntries(
            library.map((c, i) => [
              `c${i}`,
              { type: "noul" as const, instructions: `Does class "${c.type}" give the data "${need.description}" with the fields ${need.fields.join(", ")}?` },
            ]),
          ),
        });
        libraryHits = library
          .map((c, i) => ({ c, p: a[`c${i}`]?.type === "noul" ? (a[`c${i}`] as { noul: number }).noul : 0 }))
          .filter((x) => x.p >= ctx.brain.config.thresholds.libraryMatch)
          .map(({ c, p }) => ({
            candidate: { id: c.type, kind: "class" as const, classType: c.type, description: c.description },
            access: "class" as const,
            status: 200,
            reachable: true,
            sampleKeys: Object.keys((c.outputSchema?.({}, { spec: undefined as never })?.properties as object) ?? {}),
            sampleText: "",
            relevance: p,
            freshness: 1,
            fields: need.fields,
            coverage: 1,
            // A tested class in the library is cheaper than a new source.
            score: Math.min(1, p + ctx.brain.config.sourceWeights.libraryBonus),
            note: "library class",
          }));
      }

      // 2) Candidates from a web search and from the model.
      const search = await ctx.brain.webSearch(`${need.description} public API data`, 5);
      const proposeSources = (extra = "") =>
        ctx.brain
          .json<{ candidates: { kind: "api" | "page"; url: string; description: string }[] }>({
            purpose: `propose sources for ${need.id}`,
            tier: "fast",
            system:
              "You find data sources for an automated agent. Give real URLs that return the data directly. A good source is one of these:\n- a public JSON API endpoint, with the parameters for a typical request (the best kind). Set date parameters near NOW, so the sample shows current data.\n- an official open-data portal\n- a web page that shows the data\nDo not give URLs that need an API key or a login. Do not invent URLs. Use the search results or well-known public APIs.",
            user: `NOW: ${new Date().toISOString()}\nDATA NEED: ${need.description}\nFIELDS: ${need.fields.join(", ")}\nFRESHNESS: ${need.freshness ?? "any"}\n\nSEARCH RESULTS:\n${search.results.map((r) => `- ${r.title} — ${r.url}\n  ${r.snippet.slice(0, 200)}`).join("\n") || "(none)"}${
              hints.good.length
                ? `\n\nTESTED SOURCES FROM THE LIBRARY (earlier builds of this domain used them). Put one first when it gives this data:\n${hints.good.map((g) => `- ${g.url} — ${g.description}`).join("\n")}`
                : ""
            }${hints.blocked.size ? `\n\nSOURCES THAT DID NOT WORK in earlier builds (do not give them):\n${[...hints.blocked].map((b) => `- ${b}`).join("\n")}` : ""}${extra}\n\nGive up to ${MAX_CANDIDATES} candidates, the best first.`,
            schema: {
              type: "object",
              properties: {
                candidates: {
                  type: "array",
                  maxItems: MAX_CANDIDATES,
                  items: {
                    type: "object",
                    properties: { kind: { type: "string", enum: ["api", "page"] }, url: { type: "string" }, description: { type: "string" } },
                    required: ["kind", "url", "description"],
                  },
                },
              },
              required: ["candidates"],
            },
          })
          .catch(() => ({ candidates: [] }));
      const proposed = await proposeSources();
      // The URLs that the person named come first. The model candidates fill the remaining places.
      const named = namedUrls(ctx.config.request, t.goal, t.summary, t.steps, t.constraints, need.description).slice(0, MAX_CANDIDATES);
      const candidates: SourceCandidate[] = [
        ...named.map((url, i) => ({ id: `${need.id}_named_${i + 1}`, kind: "page" as const, url, description: "named in the request", named: true })),
        ...proposed.candidates
          // A source that did not work in an earlier build of the domain is not probed again, unless the request names it.
          .filter((c) => /^https?:\/\//.test(c.url) && !named.includes(c.url) && !hints.blocked.has(c.url))
          .slice(0, Math.max(1, MAX_CANDIDATES - named.length))
          .map((c, i) => ({ id: `${need.id}_${i + 1}`, kind: c.kind, url: c.url, description: c.description })),
      ];

      // 3) Probe each candidate for real.
      const probes: ProbeResult[] = [];
      for (const c of candidates) probes.push(await probe(ctx, c));

      // 4) Jev scores the samples: does the sample have the fields, and is it current?
      const scoreAll = async (list: ProbeResult[]) => {
        const withData = list.filter((p) => p.reachable && p.sampleText);
        if (!withData.length) return;
        // One question for the topic of each sample, and one for each field: a need can take its fields from several sources.
        const qs: Record<string, { type: "noul"; instructions: string }> = {};
        withData.forEach((p, i) => {
          qs[`r${i}`] = {
            type: "noul",
            instructions: `Is sample #${i} about the data "${need.description}"? Judge the meaning of the data, not the field names.`,
          };
          need.fields.forEach((f, k) => {
            qs[`c${i}_${k}`] = {
              type: "noul",
              instructions: `Does sample #${i} give the data "${f}"? It can have another name (for example "qty" for "quantity"). It can also be the keys of a map (for example dates as keys), the values in a map, or a field in a nested object. A count or a total that the agent can compute from the items in the sample also gives the data.`,
            };
          });
          if (need.freshness)
            qs[`f${i}`] = { type: "noul", instructions: `Is the data in sample #${i} current enough (${need.freshness})? Compare its dates with "now" in the state.` };
        });
        const a = await ctx.brain.decide({
          purpose: `score sources for ${need.id}`,
          // Without the time of the check, the model cannot judge if a sample is current.
          state: {
            now: new Date().toISOString(),
            need: need.description,
            fields: need.fields,
            samples: withData.map((p, i) => ({ i, url: p.candidate.url, sample: p.sampleText.slice(0, 1600) })),
          },
          questions: qs,
        });
        const yes = (x: (typeof a)[string] | undefined) => (x?.type === "noul" ? x.noul : 0);
        const th = ctx.brain.config.thresholds.sourceRelevance;
        withData.forEach((p, i) => {
          p.relevance = yes(a[`r${i}`]);
          p.fields = need.fields.filter((_, k) => yes(a[`c${i}_${k}`]) >= th);
          p.coverage = need.fields.length ? p.fields.length / need.fields.length : 1;
          p.freshness = need.freshness ? yes(a[`f${i}`]) : 1;
          // Structured data (JSON fields) is more stable than text from a page. The browser is slower and more fragile than plain HTTP.
          const w = ctx.brain.config.sourceWeights;
          p.score =
            p.relevance *
            (1 - w.coverage + w.coverage * p.coverage) *
            (1 - w.freshness + w.freshness * p.freshness) *
            (p.access === "browser" ? w.browserFactor : 1) *
            (p.sampleKeys.length ? 1 : w.textFactor) *
            ((p.latencyMs ?? 0) > w.slowMs ? w.slowFactor : 1);
          // A source that the person named wins when it works: the person selected it.
          if (p.candidate.named) p.score += w.namedBonus;
        });
      };
      await scoreAll(probes);
      // A static page without the data can be a page that makes its data with JavaScript. The browser gets a second try.
      const again: ProbeResult[] = [];
      for (const [i, p] of probes.entries()) {
        if (p.note !== "static page" || p.relevance >= ctx.brain.config.thresholds.sourceRelevance) continue;
        const b = await probe(ctx, p.candidate, true);
        if (b.reachable && b.sampleText) {
          probes[i] = b;
          again.push(b);
        }
      }
      await scoreAll(again);

      // 5) No candidate gives the data: the model sees why each candidate failed and proposes new ones
      // (for example, the URL had a wrong API version). ANVIL_SOURCE_RETRY_ROUNDS sets the number of rounds.
      const th = ctx.brain.config.thresholds.sourceRelevance;
      const usable = (p: ProbeResult) => p.reachable && !p.blocked && p.relevance >= th && (p.coverage ?? 1) > 0;
      for (let round = 1; round <= ctx.brain.config.sourceRetryRounds && !libraryHits.some(usable) && !probes.some(usable); round++) {
        const tried = new Set(probes.map((p) => p.candidate.url).filter(Boolean));
        const failed = probes.map((x) => `- ${x.candidate.url ?? x.candidate.classType} → ${probeOutcome(x, th)}`).join("\n");
        ctx.log(`no candidate gives "${need.id}": new candidates, round ${round}`);
        const more = await proposeSources(
          `\n\nTHESE CANDIDATES DID NOT GIVE THE DATA. Do not give them again. Check the host, the API version, the path, and the parameters of each URL:\n${failed}`,
        );
        const next: SourceCandidate[] = more.candidates
          .filter((c) => /^https?:\/\//.test(c.url) && !tried.has(c.url) && !hints.blocked.has(c.url))
          .slice(0, MAX_CANDIDATES)
          .map((c, i) => ({ id: `${need.id}_r${round}_${i + 1}`, kind: c.kind, url: c.url, description: c.description }));
        if (!next.length) break;
        const fresh: ProbeResult[] = [];
        for (const c of next) fresh.push(await probe(ctx, c));
        await scoreAll(fresh);
        for (const [i, p] of fresh.entries()) {
          if (p.note !== "static page" || p.relevance >= th) continue;
          const b = await probe(ctx, p.candidate, true);
          if (b.reachable && b.sampleText) {
            fresh[i] = b;
            await scoreAll([b]);
          }
        }
        probes.push(...fresh);
      }

      const ranked = [...libraryHits, ...probes]
        .filter((p) => p.reachable && !p.blocked && p.relevance >= ctx.brain.config.thresholds.sourceRelevance && (p.coverage ?? 1) > 0)
        .sort((a, b) => b.score - a.score);
      const np: NeedPlan = { need, primary: ranked[0] ?? null, fallbacks: [], tried: [...libraryHits, ...probes] };
      // Complements: the next sources that have fields that the primary source does not have.
      if (np.primary) {
        let missing = need.fields.filter((f) => !(np.primary!.fields ?? need.fields).includes(f));
        const complements: NonNullable<NeedPlan["complements"]> = [];
        for (const c of ranked.slice(1)) {
          if (!missing.length) break;
          const adds = missing.filter((f) => (c.fields ?? []).includes(f));
          if (!adds.length) continue;
          complements.push({ source: c, fields: adds, use: useOf(c) });
          missing = missing.filter((f) => !adds.includes(f));
        }
        if (complements.length) np.complements = complements;
        if (missing.length) np.missingFields = missing;
        np.fallbacks = ranked
          .slice(1)
          .filter((c) => !complements.some((x) => x.source === c))
          .slice(0, 2);
      }

      // 5) Make the primary source usable: an API becomes a tested class.
      const p = np.primary;
      if (p?.access === "class") np.use = { nodeType: p.candidate.classType! };
      else if (p?.access === "browser") np.use = { nodeType: "browser", config: { url: p.candidate.url } };
      else if (p?.access === "http") {
        const type = `x_src_${need.id}`.slice(0, 48);
        let made: string | null = null;
        if (p.endpoint && ctx.services.classes) {
          const saved = await ctx.services.classes.save(
            endpointClassDraft(p.endpoint, { type, title: `${need.id} source`, description: `${need.description} (endpoint captured from ${p.candidate.url}).` }),
            { brain: ctx.brain, test: true, createdBy: "anvil" },
          );
          if (saved.def?.status === "passed") made = saved.def.type;
        }
        if (!made && ctx.services.classes && p.sampleKeys.length) {
          const g = await generateClass(
            ctx,
            {
              type,
              kind: "http",
              purpose: `Get ${need.description}. Fields: ${need.fields.join(", ")}.`,
              service: `${p.endpoint?.url ?? p.candidate.url} — sample answer: ${p.sampleText.slice(0, 800)}`,
            },
            `Agent being built: ${t.name}`,
            2,
          ).catch(() => null);
          if (g?.result.ok) made = g.result.type;
        }
        np.use = made
          ? { nodeType: made }
          : p.sampleKeys.length
            ? { nodeType: "http", config: { url: p.endpoint?.url ?? p.candidate.url } }
            : { nodeType: "web_fetch", config: { url: p.candidate.url } };
      }
      plan.needs.push(np);
      if (!np.primary && need.required) plan.unresolved.push(need.id);
      ctx.emit({ type: "artifact", kind: "sourcePlan", data: plan });
    }

    // A rate limit of a source without configured headers: a token can raise the limit (docs/LIVE_DATA.md).
    const limitedHosts = new Set(
      plan.needs
        .flatMap((n) => n.tried)
        .filter((x) => x.candidate.url && (x.status === 429 || rateLimitOf(x.note, ctx.brain.config.rateLimitPattern)))
        .map((x) => new URL(x.candidate.url!).host)
        .filter((h) => !ctx.brain.config.live.hostHeaders[h.toLowerCase()]),
    );
    for (const h of limitedHosts)
      ctx.log(`${h} has a rate limit. If it has tokens, set ANVIL_HOST_HEADERS for it in .env, for example {"${h}":{"Authorization":"Bearer \${TOKEN}"}}.`, undefined, "warn");

    // The domain remembers the sources that worked and the sources that did not (docs/LIBRARY.md), also when the build stops here.
    const lib = ctx.config.library as LibraryContext | undefined;
    if (lib?.taxonomy) await recordLessons(ctx.services.kv, ctx.brain.config.library, lib.taxonomy, sourceLessons(plan, ctx.brain.config.rateLimitPattern, { runId: ctx.runId }));

    // An early stop is for a plan that cannot give the main part of the data. When most required needs
    // have a source, the build goes on: the agent reports the other needs as gaps.
    const required = plan.needs.filter((n) => n.need.required);
    const resolvedShare = required.length ? required.filter((n) => !plan.unresolved.includes(n.need.id)).length / required.length : 1;
    const mainPartMissing = resolvedShare < ctx.brain.config.thresholds.minResolvedShare;
    if (plan.unresolved.length && !mainPartMissing && off(ctx.config.approve))
      ctx.log(`no working source for ${plan.unresolved.join(", ")}: the build goes on, and the agent must report these needs as gaps`, undefined, "warn");
    const gaps = plan.unresolved.length > 0 && off(ctx.config.allowUnresolved) && (mainPartMissing || !off(ctx.config.approve));
    const why = () =>
      plan.needs
        .filter((n) => plan.unresolved.includes(n.need.id))
        .map(
          (n) =>
            `${n.need.id}: ${n.tried.map((x) => `${x.candidate.url ?? x.candidate.classType} → ${probeOutcome(x, ctx.brain.config.thresholds.sourceRelevance)}`).join("; ") || "no candidates"}`,
        )
        .join("\n");
    // Without a person, a required need without a source stops the build before the expensive stages.
    if (gaps && off(ctx.config.approve)) throw new Error(`No working data source for: ${plan.unresolved.join(", ")}. The build stops here, before the expensive stages.\n${why()}`);
    if (!off(ctx.config.approve)) {
      // With gaps, the person decides: approve to build an agent that reports the gaps, or reject to stop.
      const res = (await ctx.waitForHuman({
        kind: "approval",
        title: gaps ? "Some data has no working source" : "Approve the data source plan",
        message: gaps
          ? `No working source for: ${plan.unresolved.join(", ")}. Approve to build the agent anyway: it reports these gaps in its output. Reject to stop the build here.`
          : "These sources were tested. The agent uses them to get its data.",
        payload: describeSourcePlan(plan),
      })) as { approved?: boolean; comment?: string } | undefined;
      if (!res?.approved)
        throw new Error(
          gaps
            ? `No working data source for: ${plan.unresolved.join(", ")}. The build stops here, before the expensive stages.\n${why()}`
            : `The data source plan was rejected${res?.comment ? `: ${res.comment}` : ""}`,
        );
    }
    return { output: { sourcePlan: plan } };
  },
};
