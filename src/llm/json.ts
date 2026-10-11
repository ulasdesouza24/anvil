/** Robust JSON extraction from model output (fences, prose, trailing commas). */

function findBalanced(text: string, start: number): string | null {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    try {
      // Common model slip-ups: trailing commas, smart quotes.
      const repaired = s
        .replace(/,\s*([}\]])/g, "$1")
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'");
      return { ok: true, value: JSON.parse(repaired) };
    } catch {
      return { ok: false };
    }
  }
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct.ok) return direct.value;

  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  for (const m of trimmed.matchAll(fence)) {
    const r = tryParse(m[1].trim());
    if (r.ok) return r.value;
  }

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== "{" && ch !== "[") continue;
    const candidate = findBalanced(trimmed, i);
    if (!candidate) continue;
    const r = tryParse(candidate);
    if (r.ok) return r.value;
  }
  throw new Error(`Model did not return valid JSON: ${trimmed.slice(0, 300)}`);
}
