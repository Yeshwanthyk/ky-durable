import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide, type LookContext, type LookRow, starts } from "../../src/dreaming/decide";
import { canMove, type MapState } from "../../src/dreaming/map";
import { askedNext } from "../../src/dreaming/decide";
import { awake, budgetOf, DUE_LEAD_MS, EVENT_TIME, EXTRA_A_DAY, fingerprint, HEARTBEAT_EVERY, heartbeats, MAX_GAP_MS, MIN_GAP_MS, NEAR_A_LOOK, NEXT_TIME, nextAt, type Pace, shouldAsk, triggerOf } from "../../src/dreaming/pace";

/**
 * How often ky looks on its own (src/dreaming/pace.ts, docs/research/proactivity/night-shift-model.md), over
 * generated look times, paces and days:
 *
 * - a look at one of the user's times always asks the model; nothing else does when the pace is quiet;
 * - a heartbeat asks only when what it reads changed or an event waits, an event look only when an event waits,
 *   a look ky booked itself whenever budget is left, and none once the day's budget is spent (invariants 2, 3, 4);
 * - over any day of triggers, extra runs that ask never pass the budget;
 * - the budget stays between half and twice the pace's base, follows the user's reactions, and quiet stays 0;
 * - a booked look falls between MIN_GAP_MS and MAX_GAP_MS from now, while awake, no later than what the look asked
 *   for or DUE_LEAD_MS before the first due date in range;
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

const TRIGGERS = ["look", "heartbeat", "event", "next"] as const;

describe("when a look asks the model", () => {
  it("follows the trigger, what changed, what waits and the day's budget", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TRIGGERS), fc.boolean(), fc.nat(3), fc.nat(12), fc.nat(20), (trigger, changed, waiting, extraToday, most) => {
        const asks = shouldAsk({ trigger, changed, waiting, extraToday, most });
        // The oracle, from the model's invariants, not the code.
        const somethingNew = trigger === "next" ? true : trigger === "event" ? waiting > 0 : changed || waiting > 0;

        expect(asks).toBe(trigger === "look" || (extraToday < most && somethingNew));
      })
    );
  });

  it("never runs more extra looks in a day than the budget allows, however the triggers fall", () => {
    fc.assert(
      fc.property(fc.nat(20), fc.array(fc.record({ trigger: fc.constantFrom(...TRIGGERS), changed: fc.boolean(), waiting: fc.nat(2) }), { maxLength: 60 }), (most, day) => {
        let extra = 0;

        for (const fire of day) {
          if (shouldAsk({ ...fire, most, extraToday: extra }) && fire.trigger !== "look") extra += 1;
        }

        expect(extra).toBeLessThanOrEqual(most);
      })
    );
  });

  it("tells a look time, an event and a heartbeat apart", () => {
    fc.assert(
      fc.property(someLooks, aTime, (looks, time) => {
        expect(triggerOf(EVENT_TIME, looks)).toBe("event");
        expect(triggerOf(NEXT_TIME, looks)).toBe("next");
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
    action: fc.constantFrom("tell" as const, "start" as const, "skip" as const, "next" as const),
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
        expect(decide(rows, context).every((row) => row.action === "tell" || row.action === "prepare")).toBe(true);
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

describe("the day's budget", () => {
  it("stays between half and twice the pace's base, quiet stays 0, and it follows the user's reactions", () => {
    fc.assert(
      fc.property(fc.constantFrom(...PACES), fc.nat(30), fc.nat(30), (pace, liked, disliked) => {
        const base = EXTRA_A_DAY[pace];
        const most = budgetOf(pace, { liked, disliked });

        if (base === 0) {
          expect(most).toBe(0);

          return;
        }

        expect(most).toBeGreaterThanOrEqual(Math.ceil(base / 2));
        expect(most).toBeLessThanOrEqual(base * 2);
        expect(budgetOf(pace, { liked: liked + 1, disliked })).toBeGreaterThanOrEqual(most);
        expect(budgetOf(pace, { liked, disliked: disliked + 1 })).toBeLessThanOrEqual(most);
        expect(budgetOf(pace, { liked: 0, disliked: 0 })).toBe(base);
      })
    );
  });
});

const HOUR = 60 * 60 * 1000;

describe("when ky books its next look", () => {
  it("lands in the gap, while awake, no later than what was asked or the first due date's lead", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e12 }),
        fc.option(fc.integer({ min: -10 * HOUR, max: 10 * HOUR })),
        fc.array(fc.integer({ min: -2 * HOUR, max: 10 * HOUR }), { maxLength: 5 }),
        fc.boolean(),
        (now, askedIn, duesIn, up) => {
          const asked = askedIn === null ? null : now + askedIn;
          const dues = duesIn.map((due) => now + due);
          const at = nextAt({ now, asked, dues, awake: () => up });
          // The oracle: every time a look would want, clamped or dropped, without the code's arithmetic.
          const inGap = (time: number) => time >= now + MIN_GAP_MS && time <= now + MAX_GAP_MS;
          const leads = dues.map((due) => due - DUE_LEAD_MS).filter(inGap);
          const wanted = asked === null ? [] : [Math.min(now + MAX_GAP_MS, Math.max(now + MIN_GAP_MS, asked))];

          if (!up || (wanted.length === 0 && leads.length === 0)) {
            expect(at).toBeNull();

            return;
          }

          expect(at).not.toBeNull();
          expect(inGap(at ?? Number.NaN)).toBe(true);

          for (const time of [...wanted, ...leads]) expect(at).toBeLessThanOrEqual(time);
          expect([...wanted, ...leads]).toContain(at);
        }
      )
    );
  });

  it("reads the look's next row by its time, and decide never posts it", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4e12 }), fc.string({ maxLength: 20 }), (at, why) => {
        const by = new Date(at).toISOString();
        const row: LookRow = { ref: "next", action: "next", needed: "look again", current: "", by, message: why };
        const booked = askedNext([row]);

        expect(booked?.at).toBe(at);
        expect(booked?.why).toBe(why.trim() || "look again");
        expect(askedNext([{ ...row, by: "not a time" }])).toBeNull();
        expect(askedNext([{ ...row, action: "skip" }])).toBeNull();
      })
    );
  });
});
