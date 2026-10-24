import { describe, expect, it } from "vitest";
import type { Tool, Turn } from "../ui/conversation";
import { eventOf } from "../ui/events";
import { dayWords, firstNew, folded, marks } from "../ui/thread-marks";

const at = (day: number, hour: number) => new Date(2026, 9, day, hour).getTime();

const turn = (id: string, started: number, ended: number | null): Turn => ({
  id,
  user: id,
  images: [], clips: [],
  from: null,
  task: null,
  to: [],
  items: [],
  state: ended === null ? "streaming" : "completed",
  startedAt: new Date(started).toISOString(),
  endedAt: ended === null ? null : new Date(ended).toISOString()
});

const tool = (name: string, input: string, output: string, status: Tool["status"] = "done"): Tool => ({
  kind: "tool",
  id: name,
  name,
  category: "other",
  summary: name,
  status,
  input,
  output,
  images: [],
  durationMs: null
});

describe("a day in words", () => {
  it("is Today, Yesterday, or its date", () => {
    const now = at(18, 13);

    expect(dayWords(at(18, 9), now)).toBe("Today");
    expect(dayWords(at(17, 23), now)).toBe("Yesterday");
    expect(dayWords(at(12, 9), now)).toContain("12");
  });
});

describe("the thread's marks", () => {
  const turns = [turn("a", at(17, 9), at(17, 9)), turn("b", at(18, 9), at(18, 9)), turn("c", at(18, 10), at(18, 10)), turn("d", at(18, 14), at(18, 14))];

  it("stamp the first turn and each turn on a new day", () => {
    expect(marks(turns, null, at(18, 15)).map((mark) => mark.day)).toEqual(["Yesterday", "Today", null, null]);
  });

  it("put New above the first turn that landed since the chat was last seen, not one that landed while open", () => {
    const visit = { since: at(18, 9) + 1, opened: at(18, 12) };

    expect(firstNew(turns, visit)).toBe(2);
    expect(marks(turns, visit, at(18, 15)).map((mark) => mark.isNew)).toEqual([false, false, true, false]);
  });

  it("put New nowhere when nothing landed since, or the chat's seen time is unknown", () => {
    expect(firstNew(turns, { since: at(18, 11), opened: at(18, 12) })).toBe(-1);
    expect(firstNew(turns, null)).toBe(-1);
  });

  it("count a reply that finished after the visit opened, when it started before it", () => {
    const running = [turn("a", at(18, 9), at(18, 13))];

    expect(firstNew(running, { since: at(18, 8), opened: at(18, 12) })).toBe(0);
    expect(firstNew([turn("b", at(18, 9), null)], { since: at(18, 8), opened: at(18, 12) })).toBe(-1);
  });
});

describe("the fold", () => {
  it("keeps the last few turns open, and opens down to the news", () => {
    expect(folded(10, 3, -1)).toBe(7);
    expect(folded(10, 3, 4)).toBe(4);
    expect(folded(10, 3, 9)).toBe(7);
    expect(folded(2, 3, -1)).toBe(0);
  });
});

describe("a turn's lasting changes", () => {
  it("name a routine created or changed, by what the tool said", () => {
    expect(eventOf(tool("automation", "{}", 'Created automation a1, "Nightly X likes roundup" (daily at 01:00 UTC).'))).toEqual({
      id: "automation",
      verb: "Created routine",
      icon: "clock",
      name: "Nightly X likes roundup"
    });

    expect(eventOf(tool("automation", "{}", 'Updated "Nightly X likes roundup".'))?.verb).toBe("Updated routine");
  });

  it("show nothing for a refusal, a read, a failure, or a tool that changes nothing lasting", () => {
    expect(eventOf(tool("automation", "{}", "update needs an id."))).toBeNull();
    expect(eventOf(tool("automation", "{}", "No automations."))).toBeNull();
    expect(eventOf(tool("automation", "{}", 'Created automation a1, "X" (…).', "failed"))).toBeNull();
    expect(eventOf(tool("read", "{}", "Saved as #3."))).toBeNull();
  });

  it("name a memory by what it says, and a file by its name", () => {
    expect(eventOf(tool("memory_note", JSON.stringify({ text: "Prefers 9pm roundups" }), "Saved as #3."))?.name).toBe("Prefers 9pm roundups");
    expect(eventOf(tool("soul_edit", "{}", "Saved edit of SOUL.md (version 4)."))).toMatchObject({ verb: "Updated", name: "SOUL.md" });
  });
});
