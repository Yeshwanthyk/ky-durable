import { describe, expect, it } from "vitest";
import { byNextRun } from "../ui/automation-order";

const DAY = 86_400_000;

const now = Date.UTC(2026, 9, 6, 12);

const row = (title: string, status: "active" | "paused" | "done", next_run: number | null) => ({
  title,
  status,
  next_run
});

/** Activity lists automations by when they run next. */
describe("the automations list's order", () => {
  it("puts the soonest next run first", () => {
    const passport = row("Renew passport", "active", Date.UTC(2026, 10, 1, 12));
    const weather = row("Weather", "active", now + DAY);
    const repo = row("Repo cleanup", "active", now + 3 * 3_600_000);

    expect(byNextRun([passport, weather, repo]).map((each) => each.title)).toEqual([
      "Repo cleanup",
      "Weather",
      "Renew passport"
    ]);
  });

  it("puts paused, finished and unbooked ones last, in the order they came", () => {
    const paused = row("Backups", "paused", now + DAY);
    const done = row("Old one-off", "done", null);
    const unbooked = row("Unbooked", "active", null);
    const daily = row("Daily", "active", now + 2 * DAY);

    expect(byNextRun([paused, done, daily, unbooked]).map((each) => each.title)).toEqual([
      "Daily",
      "Backups",
      "Old one-off",
      "Unbooked"
    ]);
  });

  it("leaves the list it was given alone", () => {
    const list = [row("Later", "active", now + DAY), row("Sooner", "active", now)];

    byNextRun(list);

    expect(list.map((each) => each.title)).toEqual(["Later", "Sooner"]);
  });
});
