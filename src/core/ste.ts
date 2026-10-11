/**
 * ASD-STE100 Simplified Technical English (STE) linter.
 *
 * This is a TypeScript port of the score v3 rules of ste-lint.py from the
 * asd-ste100 skill. Copyright (c) 2026 Ege Chelebi. MIT License.
 * The port keeps the word lists and the rules. It does not port the Layer 2
 * (reply shape) checks and the command line.
 *
 * The score is the number of violations for each 100 words. It is
 * deterministic, so the compiler, the refine node, and the evaluation can use
 * it as a check. The word lists are English. For text in another language,
 * the linter applies only the rules that do not depend on the language:
 * sentence length, semicolons, and paragraph length.
 */

const MARKETING = ["seamless", "seamlessly", "robust", "powerful", "cutting-edge", "effortless", "effortlessly", "world-class", "next-generation", "revolutionary", "blazing", "lightning-fast", "elegant", "delightful", "turnkey", "best-in-class", "state-of-the-art", "game-changing", "first-class", "battle-tested", "enterprise-grade", "supercharge", "unlock", "unleash", "empower", "empowers"];
const BANNED = ["begin", "begins", "commence", "commences", "initiate", "initiates", "originate", "utilize", "utilizes", "utilizing", "leverage", "leverages", "leveraging", "facilitate", "facilitates", "ensure", "ensures", "ensuring", "prior to", "subsequent to", "obtain", "obtains", "acquire", "acquires", "demonstrate", "demonstrates", "additionally", "furthermore", "moreover", "comprehensive", "comprehensively", "utilization", "aforementioned", "henceforth", "therein", "whilst", "amongst", "numerous", "myriad", "plethora", "provide", "provides", "provided", "in order to", "a variety of", "in the event that", "due to the fact that", "it is important to note"];
const STRICT_BANNED = ["however", "since", "should", "shall", "using", "follow", "follows", "followed"];
const PHRASAL = ["spin up", "spin down", "reach out", "dive into", "dives into", "diving into", "kick off", "kicks off", "roll out", "rolls out", "tear down", "ramp up", "circle back", "drill down", "spun up", "reaching out"];
const MODAL_HEDGE = ["it is important to note", "it should be noted", "it is worth noting", "please note that", "as mentioned", "as noted above"];
const BE = "(?:am|is|are|was|were|be|been|being)";
const PP_IRREG = "(?:done|made|sent|read|built|kept|held|set|put|run|written|shown|given|taken|found|got|gotten|seen|known|thrown|drawn)";
/** Rule 3.3: a past participle used as an adjective is not passive. */
const STATIVE = "(?:closed|opened?|damaged|completed?|installed|connected|required|expected|configured|enabled|disabled|deprecated|supported)";
const FUNC_WORDS = new Set(
  "a an the this that these those of for to in on at by with from as and or but if when then than not no is are was were be been being am do does did has have had will would can could may might must should shall it its their your our his her they we you i".split(" "),
);

export const STE_SCORE_VERSION = 3;

export interface SteResult {
  /** "en" applies all rules. "other" applies only the rules that do not depend on the language. */
  language: "en" | "other";
  words: number;
  sentences: number;
  violations: Record<string, number>;
  total: number;
  per100w: number;
  longestSentence: number;
  samples: { banned: string[]; marketing: string[]; longSentences: string[] };
}

function stripFrontMatter(t: string) {
  return t.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m, "");
}

/** A quote is text that the writer cites, not text that the writer wrote. It stays out of the score. */
function stripQuotes(t: string) {
  return t
    .replace(/"[^"\n]+"/g, " ")
    .replace(/“[^”\n]+”/g, " ")
    .replace(/(?<![\w'])'(?=\S)(?:[^'\n]|(?<=\w)'(?=\w))+?(?<=\S)'(?!\w)/g, " ")
    .replace(/‘(?=\S)(?:[^‘’\n]|(?<=\w)’(?=\w))+?(?<=\S)’(?!\w)/g, " ");
}

function stripCode(t: string) {
  return t.replace(/```[\s\S]*?```/g, "\n\n").replace(/`[^`]*`/g, " ");
}

function stripEmphasis(t: string) {
  const re = /(?<![\\\w])(\*{1,3}|_{1,3})(?=[^\s*_])([\s\S]+?)(?<=[^\s\\*_])\1(?!\w)/g;
  for (;;) {
    const next = t.replace(re, "$2");
    if (next === t) return t;
    t = next;
  }
}

function proseBlocks(text: string): string[] {
  const blocks: string[] = [];
  let pending: string[] = [];
  let depth = 0;
  const flush = () => {
    if (pending.length) blocks.push(pending.join(" "));
    pending = [];
  };
  for (const line of stripEmphasis(text).split(/\r?\n/)) {
    let s = line.trim();
    const quote = /^(?:>[ \t]*)+/.exec(s);
    const d = quote ? (quote[0].match(/>/g) ?? []).length : 0;
    if (d !== depth) {
      flush();
      depth = d;
    }
    if (quote) s = s.slice(quote[0].length);
    if (!s || /^(?:(?:[-*_][ \t]*){3,}|=+)$/.test(s)) {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+/.exec(s);
    const item = /^(?:[-*+]|\d+[.)])\s+/.exec(s);
    if (heading || s.startsWith("|")) {
      flush();
      blocks.push(heading ? s.slice(heading[0].length) : s);
    } else {
      if (item) {
        flush();
        s = s.slice(item[0].length);
      }
      pending.push(s);
    }
  }
  flush();
  return blocks;
}

function paragraphs(raw: string): string[] {
  const t = raw
    .replace(/```[\s\S]*?```/g, "\n\n")
    .replace(/^[ \t]*```.*$/gm, "\n")
    .replace(/`[^`]*`/g, " ")
    .replace(/\n(?=[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]|#{1,6}[ \t]))/g, "\n\n");
  return t.split(/\n\s*\n/).filter((p) => p.trim());
}

function sentences(text: string): string[] {
  const out: string[] = [];
  for (const b of proseBlocks(text))
    for (const p of b.split(/(?<=[.!?:])\s+(?=[\p{Lu}0-9"'\-])/u)) {
      const s = p.trim();
      if (s) out.push(s);
    }
  return out;
}

const wordCount = (s: string) => (s.match(/[\p{L}0-9][\p{L}0-9'\-/]*/gu) ?? []).length;

function countPhrases(text: string, phrases: string[]): [number, string[]] {
  const low = text.toLowerCase();
  let n = 0;
  const hits: string[] = [];
  for (const ph of phrases) {
    const re = new RegExp(`(?<![a-z])${ph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`, "g");
    for (const _ of low.matchAll(re)) {
      n++;
      hits.push(ph);
    }
  }
  return [n, hits];
}

/** English when enough words are English function words and the text has no letters of other alphabets. */
export function detectLanguage(text: string): "en" | "other" {
  const words = (text.toLowerCase().match(/\p{L}+/gu) ?? []).slice(0, 400);
  if (words.length < 5) return "en";
  const letters = text.match(/\p{L}/gu) ?? [];
  // Letters outside ASCII (for example ş, ğ, ı, or other alphabets) show another language.
  if (letters.filter((c) => c.charCodeAt(0) > 127).length / Math.max(1, letters.length) > 0.01) return "other";
  return words.filter((w) => FUNC_WORDS.has(w)).length / words.length >= 0.15 ? "en" : "other";
}

export function steLint(input: string, opts: { strict?: boolean; countQuotes?: boolean; language?: "en" | "other" } = {}): SteResult {
  let raw = stripFrontMatter(input);
  if (!opts.countQuotes) raw = stripQuotes(raw);
  const text = proseBlocks(stripCode(raw)).join("\n\n");
  const sents = sentences(text);
  const words = sents.reduce((a, s) => a + wordCount(s), 0) || 1;
  const language = opts.language ?? detectLanguage(text);
  const v: Record<string, number> = {};
  const longs = sents.map((s) => [wordCount(s), s] as const).filter(([n]) => n > 20);
  v["long_sentence(>20w)"] = longs.length;
  v.semicolon = (text.match(/;/g) ?? []).length;
  v["long_paragraph(>6s)"] = paragraphs(raw).filter((p) => sentences(p).length > 6).length;
  let bannedHits: string[] = [];
  let marketingHits: string[] = [];
  if (language === "en") {
    v.contraction = (text.match(/\b(?:\w+['’](?:t|re|ve|ll|d|m)|(?:it|he|she|that|what|who|where|when|why|how|there|here|let)['’]s)\b/gi) ?? []).length;
    const parts = [...text.matchAll(new RegExp(`\\b${BE}\\s+(\\w+ed|${PP_IRREG})\\b`, "gi"))].map((m) => m[1]);
    v.passive_voice = parts.filter((p) => !new RegExp(`^${STATIVE}$`, "i").test(p)).length + (text.match(new RegExp(`\\b${BE}\\s+${STATIVE}\\s+by\\b`, "gi")) ?? []).length;
    v.complex_tense = (text.match(new RegExp(`\\b(?:(?:may|might|could|would|should|must|will|shall|can)\\s+)?(?:have|has|had)\\s+(?:been\\s+)?(?:\\w+ed|${PP_IRREG})\\b`, "gi")) ?? []).length;
    v.ing_main_verb = (text.match(new RegExp(`\\b${BE}\\s+\\w+ing\\b`, "gi")) ?? []).length;
    v.nominalization =
      (text.match(/\b(?:perform(?:s|ed)?|conduct(?:s|ed)?|carry out|carries out|make use of|makes use of)\b/gi) ?? []).length + (text.match(/\b\w{4,}(?:tion|ment|ance|ence)\s+of\b/gi) ?? []).length;
    v.phrasal_verb = countPhrases(text, PHRASAL)[0];
    [v.banned_word, bannedHits] = countPhrases(text, BANNED);
    [v.marketing_adjective, marketingHits] = countPhrases(text, MARKETING);
    v.modal_hedge = countPhrases(text, MODAL_HEDGE)[0];
    if (opts.strict) {
      v.strict_banned_word = countPhrases(text, STRICT_BANNED)[0] + (text.match(/(?<![A-Za-z])may(?![a-z])/g) ?? []).length;
      v.em_dash = (raw.match(/[—–]/g) ?? []).length;
    }
  }
  const total = Object.values(v).reduce((a, b) => a + b, 0);
  return {
    language,
    words,
    sentences: sents.length,
    violations: v,
    total,
    per100w: Math.round((total * 10000) / words) / 100,
    longestSentence: sents.reduce((a, s) => Math.max(a, wordCount(s)), 0),
    samples: {
      banned: [...new Set(bannedHits)].slice(0, 6),
      marketing: [...new Set(marketingHits)].slice(0, 6),
      longSentences: [...longs].sort((a, b) => b[0] - a[0]).slice(0, 2).map(([n, s]) => `${n}w: ${s.slice(0, 70)}`),
    },
  };
}

/** The violations that have a count, as one short line. */
export function steSummary(r: SteResult): string {
  const v = Object.entries(r.violations)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  const extra = [r.samples.banned.length ? `words to replace: ${r.samples.banned.join(", ")}` : "", r.samples.longSentences.length ? `long: ${r.samples.longSentences.join(" | ")}` : ""].filter(Boolean).join(". ");
  return `${r.per100w} violations per 100 words (${v || "none"})${extra ? `. ${extra}` : ""}`;
}

/**
 * A text fails when it has more violations than the limit allows. A short
 * text may have one violation, so one long sentence in a short prompt does not fail.
 */
export function steFails(r: SteResult, maxPer100w: number): boolean {
  return r.total > Math.max(1, (r.words * maxPer100w) / 100);
}

/** The STE rules for a model that writes prompts or prose. */
export const STE_RULES = `Write in ASD-STE100 Simplified Technical English (STE):
- Write one instruction or one fact in each sentence. Use 20 words or fewer in an instruction sentence and 25 words or fewer in a description sentence.
- Use the active voice and simple tenses (present, past, future). Do not use "has been", "is being", or "should have".
- Use the imperative for instructions ("Extract the dates.").
- Do not use semicolons or contractions. Keep the articles (a, an, the).
- Use simple words. Write "use", not "utilize" or "leverage". Write "make sure", not "ensure". Write "give", not "provide".
- Write "get", not "obtain". Write "start", not "begin" or "initiate". Write "also", not "additionally". Write "to", not "in order to".
- Do not use marketing words ("powerful", "seamless", "robust") or filler phrases ("it is important to note").
- Use 6 sentences or fewer in a paragraph. Use a list for steps.`;

/** The rules for prose that an agent writes for a person, in any language. */
export const STE_OUTPUT_RULES = `Write the text in a clear, simple style (ASD-STE100 Simplified Technical English when you write English):
- One fact or one instruction in each sentence, 20 words or fewer when possible.
- The active voice. No semicolons. No preamble, no filler, no marketing words.
- Short paragraphs (6 sentences or fewer). Lists for steps.
If you write in another language, apply the same rules in that language.`;
