import { describe, expect, it } from "vitest";
import { byDay, day } from "../../src/ui/time.ts";

// Local times, as the sidebar reads them: Wednesday 5 November 2025, mid-afternoon.
const now = new Date(2025, 10, 5, 15, 0).getTime();

const at = (month: number, date: number, hour = 12) => new Date(2025, month, date, hour).getTime();

describe("day", () => {
  it("names today, yesterday, this week's weekdays, then dates", () => {
    expect(day(at(10, 5, 0), now)).toBe("Today");
    expect(day(at(10, 4, 23), now)).toBe("Yesterday");
    expect(day(at(10, 1), now)).toBe(new Date(at(10, 1)).toLocaleDateString(undefined, { weekday: "long" }));
    expect(day(at(9, 29), now)).toBe(new Date(at(9, 29)).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  });

  it("calls a time ahead of the clock today", () => {
    expect(day(now + 60_000, now)).toBe("Today");
  });
});

describe("byDay", () => {
  it("keeps the list's order and puts each item under its day once", () => {
    const chats = [
      { id: "a", t: at(10, 5, 14) },
      { id: "b", t: at(10, 5, 9) },
      { id: "c", t: at(10, 4) },
      { id: "d", t: at(9, 1) }
    ];

    const groups = byDay(chats, (chat) => chat.t, now);

    expect(groups.map(([label, items]) => [label, items.map((chat) => chat.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      [day(at(9, 1), now), ["d"]]
    ]);
  });

  it("gives nothing for nothing", () => {
    expect(byDay([], () => 0, now)).toEqual([]);
  });
});
