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
    advance: async (ms) => reminders.advance(ms),
    tables: async () => ({ reminders: reminders.rows() }),
    effects: async () => ({ sent: reminders.sent() }),
    dispose: async () => {}
  };
}

const toy: Parity<Action> = {
  domain: "toy",
  actions: fc.oneof(
    fc.record({ add: fc.constantFrom("", "tea", "call mum"), inMs: fc.integer({ min: 0, max: 5_000 }) }),
    fc.record({ add: fc.constantFrom("tea"), inMs: fc.integer({ min: -5_000, max: -1 }) }),
    fc.record({ cancel: fc.integer({ min: 0, max: 6 }) })
  ),
  advances: fc.integer({ min: 0, max: 3_000 }),
  legacy: async () => instance(legacyReminders()),
  next: async () => instance(nextReminders()),
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
        const reminders = nextReminders();

        expect(reminders.add("tea", inMs)).toEqual({ refused: "That time has passed." });
        expect(reminders.rows()).toEqual([]);
      })
    );
  });

  it("catches a port that differs from B, with the step where it does", async () => {
    const broken: Parity<Action> = {
      ...toy,
      next: async () => {
        const reminders = nextReminders();

        return instance({ ...reminders, sent: () => reminders.sent().slice(1) });
      }
    };

    const result = await fc.check(parityProperty(broken), { numRuns: 200 });

    expect(result.failed).toBe(true);
    expect(String(result.errorInstance)).toContain("effects differ");
  });
});
