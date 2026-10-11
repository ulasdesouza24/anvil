/**
 * Scheduling primitives: interval parsing and a timezone-aware 5-field cron.
 *   minute hour day-of-month month day-of-week
 * Supports *, lists (1,15), ranges (1-5), steps (*\/15, 8-18/2), names (MON, JAN),
 * 7 = Sunday, and macros (@hourly @daily @weekly @monthly @yearly).
 * When both day-of-month and day-of-week are restricted, either may match (POSIX).
 */

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseEvery(every: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\s*$/i.exec(every);
  if (!m) throw new Error(`Invalid interval "${every}" — use e.g. "30s", "15m", "2h", "1d"`);
  const ms = Number(m[1]) * UNITS[m[2][0].toLowerCase()];
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`Invalid interval "${every}"`);
  return ms;
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface Field {
  values: Set<number>;
  any: boolean;
}

export interface Cron {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
  source: string;
}

function parseField(raw: string, min: number, max: number, names?: string[]): Field {
  const values = new Set<number>();
  const name = (s: string) => {
    const i = names?.indexOf(s.toUpperCase()) ?? -1;
    return i >= 0 ? i + (min === 1 ? 1 : 0) : Number(s);
  };
  for (const part of raw.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [min, max];
    else if (range.includes("-")) {
      const [a, b] = range.split("-");
      [lo, hi] = [name(a), name(b)];
    } else {
      lo = name(range);
      hi = stepRaw === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) throw new Error(`"${part}" is out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, any: raw === "*" };
}

export function parseCron(expr: string): Cron {
  const source = expr.trim();
  const parts = (MACROS[source.toLowerCase()] ?? source).split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron "${expr}" must have 5 fields: minute hour day-of-month month day-of-week`);
  try {
    const dow = parseField(parts[4], 0, 7, DAYS);
    if (dow.values.has(7)) {
      dow.values.delete(7);
      dow.values.add(0);
    }
    return { minute: parseField(parts[0], 0, 59), hour: parseField(parts[1], 0, 23), dom: parseField(parts[2], 1, 31), month: parseField(parts[3], 1, 12, MONTHS), dow, source };
  } catch (e) {
    throw new Error(`Invalid cron "${expr}": ${(e as Error).message}`);
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsIn(t: number, timezone?: string) {
  const key = timezone ?? "";
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    fmtCache.set(key, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), dow: DAYS.indexOf(String(p.weekday).toUpperCase().slice(0, 3)) };
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Next time strictly after `from` (ms) that matches the cron, in the given timezone. */
export function nextCronTime(cron: Cron | string, from: number, timezone?: string): number {
  const c = typeof cron === "string" ? parseCron(cron) : cron;
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  const limit = from + 400 * 86_400_000;
  while (t < limit) {
    const p = partsIn(t, timezone);
    const domOk = c.dom.values.has(p.day);
    const dowOk = c.dow.values.has(p.dow);
    const dayOk = c.dom.any && c.dow.any ? true : c.dom.any ? dowOk : c.dow.any ? domOk : domOk || dowOk;
    if (!c.month.values.has(p.month) || !dayOk) {
      t += (24 * 60 - (p.hour * 60 + p.minute)) * 60_000; // jump to next local midnight
      continue;
    }
    if (!c.hour.values.has(p.hour)) {
      t += (60 - p.minute) * 60_000; // next hour
      continue;
    }
    if (!c.minute.values.has(p.minute)) {
      t += 60_000;
      continue;
    }
    return t;
  }
  throw new Error(`Cron "${c.source}" never fires within a year`);
}

/** Short human description for the UI. */
export function describeSchedule(t: { cron?: string; every?: string; timezone?: string }): string {
  if (t.every) return `every ${t.every}`;
  if (!t.cron) return "—";
  const tz = t.timezone ? ` (${t.timezone})` : "";
  const [m, h, dom, mon, dow] = (MACROS[t.cron.toLowerCase()] ?? t.cron).split(/\s+/);
  const at = /^\d+$/.test(m) && /^\d+$/.test(h) ? `at ${h.padStart(2, "0")}:${m.padStart(2, "0")}` : null;
  if (at && dom === "*" && mon === "*") {
    if (dow === "*") return `daily ${at}${tz}`;
    if (dow === "1-5" || dow.toUpperCase() === "MON-FRI") return `weekdays ${at}${tz}`;
    return `${at} on ${dow}${tz}`;
  }
  if (m === "0" && h === "*" && dom === "*" && mon === "*" && dow === "*") return `hourly${tz}`;
  const step = /^\*\/(\d+)$/.exec(m);
  if (step && h === "*" && dom === "*" && mon === "*" && dow === "*") return `every ${step[1]} minutes`;
  return `cron ${t.cron}${tz}`;
}
