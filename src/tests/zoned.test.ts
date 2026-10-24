import { describe, expect, it } from "vitest";
import { cronIn, nextLocal, nextLocals } from "../automations/zoned";

const at = (iso: string) => Date.parse(iso);

const iso = (ms: number) => new Date(ms).toISOString();

describe("crons in a time zone", () => {
  it("names the next wall-clock time in the zone", () => {
    expect(iso(nextLocal("0 9 * * *", "America/New_York", at("2026-10-24T12:00:00Z")))).toBe("2026-10-24T13:00:00.000Z");
    // Saturday in Kolkata: the next weekday 9 AM is Monday's.
    expect(iso(nextLocal("0 9 * * 1-5", "Asia/Kolkata", at("2026-10-24T06:00:00Z")))).toBe("2026-10-26T03:30:00.000Z");
    expect(iso(nextLocal("0 9 * * *", null, at("2026-10-24T12:00:00Z")))).toBe("2026-10-25T09:00:00.000Z");
  });

  it("keeps 9 AM across daylight saving", () => {
    // Berlin leaves summer time on 2026-10-25: 9 AM is 07:00 UTC the day before, 08:00 UTC that day.
    const [before, after] = nextLocals("0 9 * * *", "Europe/Berlin", at("2026-10-24T06:00:00Z"), 2);
    expect(iso(before ?? 0)).toBe("2026-10-24T07:00:00.000Z");
    expect(iso(after ?? 0)).toBe("2026-10-25T08:00:00.000Z");
  });

  it("runs a time the spring change skips an hour later, and one the fall change repeats once", () => {
    // Berlin skips 02:00-03:00 on 2026-03-29: 02:30 runs at 03:30 CEST.
    expect(iso(nextLocal("30 2 * * *", "Europe/Berlin", at("2026-03-28T12:00:00Z")))).toBe("2026-03-29T01:30:00.000Z");
    // Berlin has 02:30 twice on 2026-10-25; it runs once, then the next day.
    const [first, next] = nextLocals("30 2 * * *", "Europe/Berlin", at("2026-10-24T12:00:00Z"), 2);
    expect(iso(first ?? 0)).toBe("2026-10-25T01:30:00.000Z");
    expect(iso(next ?? 0)).toBe("2026-10-26T01:30:00.000Z");
  });

  it("refuses a cron it cannot read", () => {
    expect(() => nextLocal("nope", "UTC", Date.now())).toThrow();
  });

  it("moves a UTC cron into the zone where cron can say it", () => {
    const now = at("2026-10-24T12:00:00Z");
    expect(cronIn("30 3 * * 1-5", "Asia/Kolkata", now)).toBe("0 9 * * 1-5");
    // 22:00 UTC is 03:30 the next day in Kolkata.
    expect(cronIn("0 22 * * 1-5", "Asia/Kolkata", now)).toBe("30 3 * * 2-6");
    expect(cronIn("0 2 * * 1", "America/New_York", now)).toBe("0 22 * * 0");
    expect(cronIn("*/15 * * * *", "America/New_York", now)).toBe("*/15 * * * *");
    expect(cronIn("0 * * * *", "Asia/Kolkata", now)).toBeUndefined();
    expect(cronIn("0 9,17 * * *", "Asia/Kolkata", now)).toBeUndefined();
    expect(cronIn("0 22 1 * *", "Asia/Kolkata", now)).toBeUndefined();
  });
});
