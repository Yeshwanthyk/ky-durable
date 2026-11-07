import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide, type LookContext, type LookRow, starts } from "../../src/dreaming/decide";
import { canMove, type MapState } from "../../src/dreaming/map";
import { awake, EVENT_TIME, EXTRA_A_DAY, fingerprint, HEARTBEAT_EVERY, heartbeats, NEAR_A_LOOK, type Pace, shouldAsk, triggerOf } from "../../src/dreaming/pace";

/**
 * How often ky looks on its own (src/dreaming/pace.ts, docs/research/proactivity/night-shift-model.md), over
 * generated look times, paces and days:
 *
 * - a look at one of the user's times always asks the model; nothing else does when the pace is quiet;
 * - a heartbeat asks only when what it reads changed or an event waits, an event look only when an event waits,
 *   and neither once the day's extra budget is spent (invariants 2, 3, 4);
 * - over any day of triggers, extra runs that ask never pass EXTRA_A_DAY;
 * - heartbeats sit strictly inside the waking window, on the pace's grid, at least NEAR_A_LOOK from every look,
 *   and quiet has none;
 * - the fingerprint is the same for the same reads in any order, and differs when any read does;
 * - a start is only a start row with a task and a message on a known ref, one per ref, never past what is left,
 *   and decide never posts one as a tell (invariant 7);
 * - a map item moves anywhere but out of done (invariant 8).
 */

const PACES: readonly Pace[] = ["quiet", "balanced", "eager"];

const byText = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

const aTime = fc.integer({ min: 0, max: 24 * 60 - 1 }).map((minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);

const someLooks = fc.uniqueArray(aTime, { maxLength: 4 }).map((times) => [...times].sort(byText));

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

describe("when a look asks the model", () => {
  it("follows the trigger, the pace, what changed, what waits and the day's budget", () => {
    fc.assert(
      fc.property(fc.constantFrom("look" as const, "heartbeat" as const, "event" as const), fc.constantFrom(...PACES), fc.boolean(), fc.nat(3), fc.nat(12), (trigger, pace, changed, waiting, extraToday) => {
        const asks = shouldAsk({ trigger, pace, changed, waiting, extraToday });
        // The oracle, from the model's invariants, not the code.
        const budgetLeft = pace === "balanced" ? extraToday < 4 : pace === "eager" ? extraToday < 10 : false;
        const somethingNew = trigger === "event" ? waiting > 0 : changed || waiting > 0;

        expect(asks).toBe(trigger === "look" || (budgetLeft && somethingNew));
      })
    );
  });

  it("never runs more extra looks in a day than the pace allows, however the triggers fall", () => {
    fc.assert(
      fc.property(fc.constantFrom(...PACES), fc.array(fc.record({ trigger: fc.constantFrom("look" as const, "heartbeat" as const, "event" as const), changed: fc.boolean(), waiting: fc.nat(2) }), { maxLength: 60 }), (pace, day) => {
        let extra = 0;

        for (const fire of day) {
          if (shouldAsk({ ...fire, pace, extraToday: extra }) && fire.trigger !== "look") extra += 1;
        }

        expect(extra).toBeLessThanOrEqual(EXTRA_A_DAY[pace]);
      })
    );
  });

  it("tells a look time, an event and a heartbeat apart", () => {
    fc.assert(
      fc.property(someLooks, aTime, (looks, time) => {
        expect(triggerOf(EVENT_TIME, looks)).toBe("event");
        expect(triggerOf(time, looks)).toBe(looks.includes(time) ? "look" : "heartbeat");
      })
    );
  });
});

describe("the heartbeats", () => {
  it("fall inside the waking window, on the grid, away from every look; quiet has none", () => {
    fc.assert(
      fc.property(someLooks, fc.constantFrom(...PACES), (looks, pace) => {
        const beats = heartbeats(looks, pace);
        const every = HEARTBEAT_EVERY[pace];

        if (every === null || looks.length < 2) {
          expect(beats).toEqual([]);

          return;
        }

        const at = looks.map(minutesOf);

        for (const beat of beats.map(minutesOf)) {
          expect(beat).toBeGreaterThan(Math.min(...at));
          expect(beat).toBeLessThan(Math.max(...at));
          expect(beat % every).toBe(0);
          expect(at.every((look) => Math.abs(look - beat) >= NEAR_A_LOOK)).toBe(true);
          expect(awake(looks, beat)).toBe(true);
        }

        // Every grid point that qualifies is there: nothing is left out.
        const expected: number[] = [];

        for (let minutes = 0; minutes < 24 * 60; minutes += every) {
          if (minutes > Math.min(...at) && minutes < Math.max(...at) && at.every((look) => Math.abs(look - minutes) >= NEAR_A_LOOK)) expected.push(minutes);
        }

        expect(beats.map(minutesOf)).toEqual(expected);
      })
    );
  });

  it("are booked as the default day expects", () => {
    expect(heartbeats(["08:00", "13:00", "18:00"], "balanced")).toEqual(["10:00", "12:00", "14:00", "16:00"]);
    expect(heartbeats(["08:00", "13:00", "18:00"], "eager")).toEqual(["09:00", "10:00", "11:00", "12:00", "14:00", "15:00", "16:00", "17:00"]);
  });
});

describe("the fingerprint", () => {
  const reads = fc.record({ anticipations: fc.uniqueArray(fc.nat(50), { maxLength: 6 }), map: fc.uniqueArray(fc.string({ maxLength: 8 }), { maxLength: 4 }), wrote: fc.nat(999).map(String), verdicts: fc.nat(20) });

  it("ignores order and changes with any read", () => {
    fc.assert(
      fc.property(reads, reads, (a, b) => {
        expect(fingerprint({ ...a, anticipations: [...a.anticipations].reverse(), map: [...a.map].reverse() })).toBe(fingerprint(a));
        const same = JSON.stringify([[...a.anticipations].sort((x, y) => x - y), [...a.map].sort(byText), a.wrote, a.verdicts]) === JSON.stringify([[...b.anticipations].sort((x, y) => x - y), [...b.map].sort(byText), b.wrote, b.verdicts]);

        expect(fingerprint(a) === fingerprint(b)).toBe(same);
      })
    );
  });
});

const NOW = 1_800_000_000_000;

const REFS = ["anticipation:1", "map:2", "memory:3", "map:9"] as const;

const aRow: fc.Arbitrary<LookRow> = fc.record(
  {
    ref: fc.constantFrom(...REFS),
    needed: fc.constant(""),
    current: fc.constant(""),
    action: fc.constantFrom("tell" as const, "start" as const, "skip" as const),
    message: fc.constantFrom("", "Drafted the reply.", "Started the comparison."),
    prompt: fc.constantFrom("", " ", "Compare the three quotes.")
  },
  { requiredKeys: ["ref", "needed", "current", "action"] }
);

describe("the starts", () => {
  it("are known start rows with a task and a message, one per ref, never past what is left, and never posted as tells", () => {
    fc.assert(
      fc.property(fc.array(aRow, { maxLength: 8 }), fc.subarray([...REFS]), fc.nat(3), (rows, known, left) => {
        const context: LookContext = { now: NOW, next: null, known: new Set(known), said: new Map() };
        const started = starts(rows, context, left);

        expect(started.length).toBeLessThanOrEqual(left);
        expect(new Set(started.map((row) => row.ref)).size).toBe(started.length);

        for (const row of started) {
          expect(row.action).toBe("start");
          expect(row.prompt.trim()).not.toBe("");
          expect(row.message.trim()).not.toBe("");
          expect(known).toContain(row.ref);
        }

        // As many as room allows: every eligible ref is started until left runs out.
        const eligible = new Set(rows.filter((row) => row.action === "start" && (row.prompt ?? "").trim() !== "" && (row.message ?? "").trim() !== "" && new Set<string>(known).has(row.ref)).map((row) => row.ref));
        expect(started.length).toBe(Math.min(left, eligible.size));
        expect(decide(rows, context).every((row) => row.action !== "start")).toBe(true);
      })
    );
  });
});

describe("a map item", () => {
  it("moves anywhere but out of done", () => {
    const STATES: readonly MapState[] = ["open", "doing", "waiting", "done"];

    for (const from of STATES) for (const to of STATES) expect(canMove(from, to)).toBe(from !== "done" && from !== to);
  });
});
