/**
 * The parity kit, proved on a toy domain: the port agrees with B everywhere but one declared
 * divergence, the divergence's invariant holds, and a broken port is caught.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertParity, type Instance, type Parity, parityProperty } from "../kit.ts";
import { legacyReminders } from "./legacy.ts";
import { nextReminders } from "./next.ts";

type Action = { add: string; inMs: number } | { cancel: number };

type Reminders = ReturnType<typeof legacyReminders>;

function instance(reminders: Reminders): Instance<Action> {
  return {
    apply: async (action) => ("add" in action ? reminders.add(action.add, action.inMs) : reminders.cancel(action.cancel)),
    due: async () => reminders.due(),
    pending: async () => ({ next: reminders.nextAlarm() }),
    nextAlarm: async () => reminders.nextAlarm(),
    tables: async () => ({ reminders: reminders.rows() }),
    effects: async () => ({ sent: reminders.sent() }),
    dispose: async () => {}
  };
}

const toy: Parity<Action> = {
  domain: "toy",
  actions: fc.oneof(
    { arbitrary: fc.record({ add: fc.constantFrom("", "tea", "call mum"), inMs: fc.integer({ min: 0, max: 5_000 }) }), weight: 4 },
    { arbitrary: fc.record({ add: fc.constantFrom("tea"), inMs: fc.integer({ min: -5_000, max: -1 }) }), weight: 1 },
    { arbitrary: fc.record({ cancel: fc.integer({ min: 0, max: 6 }) }), weight: 2 }
  ),
  advances: fc.integer({ min: 0, max: 3_000 }),
  legacy: async (clock) => instance(legacyReminders(clock)),
  next: async (clock) => instance(nextReminders(clock)),
  divergences: [
    {
      name: "refuses a reminder in the past",
      covers: (action) => "add" in action && action.inMs < 0,
      heldBy: "test/parity/toy/toy.test.ts > refuses a reminder in the past"
    }
  ]
};

describe("parity kit", () => {
  it("finds the port the same as B, but where it diverges on purpose", async () => {
    await assertParity(toy);
  });

  it("refuses a reminder in the past", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000, max: -1 }), (inMs) => {
        const reminders = nextReminders({ now: () => 0 });

        expect(reminders.add("tea", inMs)).toEqual({ refused: "That time has passed." });
        expect(reminders.rows()).toEqual([]);
      })
    );
  });

  it("catches a port that differs from B, with the step where it does", async () => {
    const broken: Parity<Action> = {
      ...toy,
      next: async (clock) => {
        const reminders = nextReminders(clock);

        return instance({ ...reminders, sent: () => reminders.sent().slice(1) });
      }
    };

    const result = await fc.check(parityProperty(broken), { numRuns: 200 });

    expect(result.failed).toBe(true);
    expect(String(result.errorInstance)).toContain("effects differ");
  });

  it("jumps to the next alarm, so a port that loses a reminder an hour off is caught", async () => {
    const hourly: Parity<Action> = { ...toy, actions: fc.record({ add: fc.constantFrom("tea"), inMs: fc.integer({ min: 3_600_000, max: 7_200_000 }) }), divergences: [] };

    const late: Parity<Action> = {
      ...hourly,
      next: async (clock) => {
        const reminders = nextReminders(clock);

        return instance({ ...reminders, due: () => (clock.now() > 3_600_000 ? undefined : reminders.due()) });
      }
    };

    await assertParity(hourly);
    const result = await fc.check(parityProperty(late), { numRuns: 100, seed: 1 });

    expect(result.failed).toBe(true);
  });

  it("gives both sides one clock, so a port that keeps its own time is caught", async () => {
    const own: Parity<Action> = { ...toy, next: async () => instance(nextReminders({ now: () => 0 })) };
    const result = await fc.check(parityProperty(own), { numRuns: 200, seed: 1 });

    expect(result.failed).toBe(true);
  });

  it("refuses divergences that would hollow out the comparison", () => {
    const [past] = toy.divergences ?? [];

    expect(past).toBeDefined();

    if (!past) return;

    expect(() => parityProperty({ ...toy, divergences: [{ ...past, covers: (action) => "add" in action }] })).toThrow(/divergences cover \d+% of the actions/);
    expect(() => parityProperty({ ...toy, divergences: [{ ...past, heldBy: "test/parity/toy/gone.test.ts > refuses" }] })).toThrow(/isn't `<existing file> > <test name>`/);
  });

  it("refuses to compare what JSON can't show", async () => {
    const mapped: Parity<Action> = {
      ...toy,
      next: async (clock) => ({ ...(await toy.next(clock)), // SAFETY: a side that breaks the Json type at runtime is what this test feeds the kit.
      tables: async () => new Map() as never })
    };

    const result = await fc.check(parityProperty(mapped), { numRuns: 50, seed: 1 });

    expect(String(result.errorInstance)).toContain("compares as {}");
  });
});
