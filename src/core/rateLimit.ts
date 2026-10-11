/**
 * A rate limit or a quota of a source is a problem of the environment, not of
 * the agent: the same agent works when the limit resets. The pattern comes from
 * the config (rateLimitPattern), so a deployment can add the messages of its sources.
 */

/** The part of the text that shows a rate limit, or null. A bad pattern finds nothing. */
export function rateLimitOf(text: string | undefined | null, pattern: string): string | null {
  if (!text || !pattern) return null;
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return null;
  }
  const m = re.exec(text);
  if (!m) return null;
  const from = Math.max(0, m.index - 80);
  return text.slice(from, m.index + m[0].length + 80).replace(/\s+/g, " ").trim();
}
