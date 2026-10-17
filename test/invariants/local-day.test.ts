import { describe, expect, it } from "vitest";
import { localDay, nextMidnight } from "../../src/dreaming/local-day";

/**
 * The brief's day and its midnight (src/dreaming/local-day.ts) in zones whose midnight is not where today's
 * offset puts it: daylight saving changes, at midnight itself or half an hour long, and the far ends of the clock.
 */

const at = (iso: string) => Date.parse(iso);

describe("the next local midnight", () => {
  const cases: readonly [zone: string | null, now: string, midnight: string, why: string][] = [
    ["America/New_York", "2026-03-07T17:00:00Z", "2026-03-08T05:00:00Z", "the night before clocks go forward: still 5 hours behind at midnight"],
    ["America/New_York", "2026-03-08T17:00:00Z", "2026-03-09T04:00:00Z", "the day clocks went forward is 23 hours long"],
    ["America/New_York", "2026-10-31T17:00:00Z", "2026-11-01T04:00:00Z", "the night before clocks go back: still 4 hours behind at midnight"],
    ["America/New_York", "2026-11-01T17:00:00Z", "2026-11-02T05:00:00Z", "the day clocks went back is 25 hours long"],
    // Santiago's clocks go forward at midnight on 6 September 2026: 00:00 never happens, the day starts at 01:00.
    ["America/Santiago", "2026-09-05T15:00:00Z", "2026-09-06T04:00:00Z", "daylight saving starts at midnight itself"],
    ["Australia/Lord_Howe", "2026-10-03T12:00:00Z", "2026-10-03T13:30:00Z", "a half-hour daylight saving change"],
    ["Asia/Kolkata", "2026-10-16T10:00:00Z", "2026-10-16T18:30:00Z", "a half-hour offset"],
    ["Pacific/Kiritimati", "2026-10-16T09:00:00Z", "2026-10-16T10:00:00Z", "14 hours ahead"],
    ["Etc/GMT+12", "2026-10-16T09:00:00Z", "2026-10-16T12:00:00Z", "12 hours behind"],
    [null, "2026-10-16T09:00:00Z", "2026-10-17T00:00:00Z", "no zone counts as UTC"],
    ["Not/AZone", "2026-10-16T09:00:00Z", "2026-10-17T00:00:00Z", "a zone Intl does not know counts as UTC"]
  ];

  it.each(cases)("in %s at %s is %s: %s", (zone, now, midnight) => {
    const found = nextMidnight(zone, at(now));

    expect(new Date(found).toISOString()).toBe(new Date(at(midnight)).toISOString());
    // The first instant of a new local day, and the last before it still today.
    expect(localDay(zone, found)).not.toBe(localDay(zone, at(now)));
    expect(localDay(zone, found - 1)).toBe(localDay(zone, at(now)));
  });

  it("is always later than now, even a millisecond before midnight", () => {
    const now = at("2026-10-16T23:59:59.999Z");

    expect(nextMidnight(null, now)).toBe(at("2026-10-17T00:00:00Z"));
    expect(nextMidnight(null, at("2026-10-17T00:00:00Z"))).toBe(at("2026-10-18T00:00:00Z"));
  });

  it("does not end Santiago's 5 September an hour early, as reading the offset at midnight itself did", () => {
    // At 04:00 UTC Santiago is already on -3, so midnight minus that offset is 03:00 UTC: 23:00 on the 5th.
    const midnight = nextMidnight("America/Santiago", at("2026-09-05T15:00:00Z"));

    expect(midnight).not.toBe(at("2026-09-06T03:00:00Z"));
    expect(localDay("America/Santiago", at("2026-09-06T03:00:00Z"))).toBe("2026-09-05");
    expect(localDay("America/Santiago", midnight)).toBe("2026-09-06");
  });
});
