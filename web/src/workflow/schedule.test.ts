import { describe, expect, it } from "vitest";
import { cronField, nextSchedule } from "./schedule";
const at = (s: string) => Date.parse(s);
describe("schedule preview", () => {
  it("expands lists, ranges, steps and names", () => {
    expect([...cronField("1,5-9/2", 0, 59)]).toEqual([1, 5, 7, 9]);
    expect(nextSchedule({ id: "daily", type: "schedule", enabled: false, cron: "0 9 * JAN MON-FRI", timezone: "UTC" }, at("2026-01-02T10:00:00Z"))[0]).toBe(
      at("2026-01-05T09:00:00Z"),
    );
  });
  it("uses OR for restricted month day and weekday", () => {
    expect(nextSchedule({ id: "daily", type: "schedule", enabled: false, cron: "0 9 14 * MON", timezone: "UTC" }, at("2026-10-13T10:00:00Z"))[0]).toBe(at("2026-10-14T09:00:00Z"));
  });
  it("skips nonexistent wall times during spring DST", () => {
    expect(nextSchedule({ id: "daily", type: "schedule", enabled: false, cron: "30 2 * * *", timezone: "America/New_York" }, at("2026-03-08T05:00:00Z"))[0]).toBe(
      at("2026-03-09T06:30:00Z"),
    );
  });
  it("keeps both repeated wall times during autumn DST", () => {
    expect(nextSchedule({ id: "daily", type: "schedule", enabled: false, cron: "30 1 * * *", timezone: "America/New_York" }, at("2026-11-01T04:00:00Z")).slice(0, 2)).toEqual([
      at("2026-11-01T05:30:00Z"),
      at("2026-11-01T06:30:00Z"),
    ]);
  });
  it("supports intervals and rejects bad cron rather than hanging", () => {
    expect(nextSchedule({ id: "interval", type: "schedule", enabled: false, every: "2h" }, 0)).toEqual([7200000, 14400000, 21600000, 28800000, 36000000]);
    for (const field of ["*/0", "60", "8-2", "1/NaN"]) expect(() => cronField(field, 0, 59)).toThrow();
    expect(() => nextSchedule({ id: "bad", type: "schedule", enabled: false, cron: "0 0 31 2 *", timezone: "UTC" }, 0)).toThrow();
  });
});
