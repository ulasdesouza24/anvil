import type { Trigger } from "@core/types";
const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export function cronField(text: string, min: number, max: number, names: string[] = []): Set<number> {
  const values = new Set<number>();
  const number = (s: string) => {
    const named = names.indexOf(s.toLowerCase());
    const n = named < 0 ? Number(s) : named + min;
    if (!s || !Number.isInteger(n) || n < min || n > max) throw Error(`Invalid cron value: ${s}`);
    return n;
  };
  for (const part of text.split(",")) {
    const [range, stride, extra] = part.split("/");
    const step = stride === undefined ? 1 : Number(stride);
    if (extra !== undefined || !Number.isInteger(step) || step < 1 || step > max - min + 1) throw Error("Invalid cron step");
    const pieces = range.split("-");
    if (pieces.length > 2) throw Error("Invalid cron range");
    const start = range === "*" ? min : number(pieces[0]);
    const end = range === "*" ? max : pieces[1] !== undefined ? number(pieces[1]) : stride ? max : start;
    if (start > end) throw Error("Invalid cron range");
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return values;
}
export function nextSchedule(t: Extract<Trigger, { type: "schedule" }>, now = Date.now()): number[] {
  if (t.every) {
    const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(t.every);
    if (!match || Number(match[1]) <= 0) throw Error("Use an interval such as 30s, 15m, 2h, or 1d");
    const ms = Number(match[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]]!;
    return Array.from({ length: 5 }, (_, i) => now + ms * (i + 1));
  }
  const fields = (t.cron ?? "").trim().split(/\s+/);
  if (fields.length !== 5) throw Error("Cron needs five fields");
  const minute = cronField(fields[0], 0, 59);
  const hour = cronField(fields[1], 0, 23);
  const day = cronField(fields[2], 1, 31);
  const month = cronField(fields[3], 1, 12, months);
  const weekday = cronField(fields[4], 0, 7, weekdays);
  if (weekday.has(7)) weekday.add(0);
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: t.timezone || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const local = (time: number) =>
    Object.fromEntries(
      fmt
        .formatToParts(time)
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, Number(p.value)]),
    );
  const start = local(now);
  const base = Date.UTC(start.year, start.month - 1, start.day);
  const results: number[] = [];
  // Iterate calendar days, then only matching hours and minutes. Validate local time after DST conversion.
  for (let offset = 0; offset < 366 * 8 && results.length < 5; offset++) {
    const date = new Date(base + offset * 86400000);
    const dom = day.has(date.getUTCDate());
    const dow = weekday.has(date.getUTCDay());
    const matches = fields[2] === "*" ? dow : fields[4] === "*" ? dom : dom || dow;
    if (!month.has(date.getUTCMonth() + 1) || !matches) continue;
    const offsets = new Set<number>();
    for (const delta of [-86400000, 0, 86400000]) {
      const stamp = date.getTime() + delta;
      const localDate = local(stamp);
      offsets.add(Date.UTC(localDate.year, localDate.month - 1, localDate.day, localDate.hour, localDate.minute) - stamp);
    }
    const candidates: number[] = [];
    for (const h of [...hour].sort((a, b) => a - b))
      for (const m of [...minute].sort((a, b) => a - b)) {
        const wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), h, m);
        for (const zoneOffset of offsets) {
          const time = wall - zoneOffset;
          const p = local(time);
          if (time > now && p.year === date.getUTCFullYear() && p.month === date.getUTCMonth() + 1 && p.day === date.getUTCDate() && p.hour === h && p.minute === m)
            candidates.push(time);
        }
      }
    results.push(...candidates.sort((a, b) => a - b));
    if (results.length >= 5) return results.slice(0, 5);
  }
  if (results.length < 5) throw Error("No five run times in the next eight years");
  return results;
}
