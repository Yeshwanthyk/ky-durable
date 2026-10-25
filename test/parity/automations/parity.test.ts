/**
 * Automations, B's (src/automations/legacy) against the port's, over the same generated runs: every facade
 * method, the clock moving and the Scheduler firing, a fire delivered again, a run's task moving on, a commit
 * that fails, the machine turned off and the side chat archived. After each step both sides' results, tables
 * (the automations, check-ins, tasks, chats and pi's Runs doc), effects and bookings must agree.
 *
 * Scaffolding while the domain is ported: it goes with src/automations/legacy at the flip.
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type AutomationDeps as LegacyDeps, Automations as LegacyAutomations } from "../../../src/automations/legacy/automations";
import { assertParity, type Json, type Parity } from "../kit";
import type { AutomationDeps } from "../../../src/automations/automations";
import { type Action, actions, HOUR, instance, installIds, next, port, schedulerOf, START, type World } from "./world";

// B makes its own Scheduler; the port is given one (./world.ts). Gone with B at the flip.
vi.mock("agents/schedules", async () => ({ Scheduler: (await import("./scheduler")).Bookings }));

vi.mock("agents/harness/pi", () => ({ ROOT_SESSION: "1" }));

/**
 * The port's views leave out what a gate last found, which only a fire reads, where B's carried it along; and
 * keys are compared sorted, since B's rows put `zone` last.
 */
function normalize(observed: Json): Json {
  if (Array.isArray(observed)) return observed.map(normalize);

  if (!(observed instanceof Object)) return observed;

  return Object.fromEntries(
    Object.entries(observed)
      .filter(([key]) => key !== "gate_found" && key !== "gate_found_by")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, value === undefined ? value : normalize(value)])
  );
}

/** B over the world: its deps took the whole MachineHub, of which the world's give what both sides call. */
const legacyOver = (world: World, deps: AutomationDeps) =>
  // SAFETY: B calls the same six of MachineHub the port's deps name.
  new LegacyAutomations(world.durable.sql(), deps as LegacyDeps);

const automations: Parity<Action> = {
  domain: "automations",
  actions,
  start: START,
  advances: fc.integer({ min: 1_000, max: 2 * HOUR }),
  legacy: async (clock) => instance(clock, legacyOver),
  next: async (clock) => next(clock),
  normalize
};

beforeAll(() => {
  // Runs as long as the kit lets them: at fast-check's small default most stop after a step or two.
  fc.configureGlobal({ ...fc.readConfigureGlobal(), baseSize: "large" });
  vi.useFakeTimers({ toFake: ["Date"] });
  installIds();
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("automations parity", () => {
  it("the port does what B does, step for step", async () => {
    await assertParity(automations);
  });

  it("the port reads the rows B wrote and shows them as B does", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(actions, { maxLength: 20 }), async (run) => {
        const time = { at: START };
        const clock = { now: () => time.at };
        const legacy = instance(clock, legacyOver);

        for (const action of run) {
          await legacy.apply(action);
          time.at += 10 * 60_000;
          await legacy.due();
        }

        const world = legacy.world;
        const shown = await world.in(() => legacy.side.list(true));
        const ported = port(world, world.deps());
        schedulerOf(ported).adopt(legacy.scheduler);
        const read = await world.in(() => ported.list(true));

        // SAFETY: the views are rows of JSON values.
        expect(normalize(JSON.parse(JSON.stringify(read)) as Json)).toEqual(normalize(JSON.parse(JSON.stringify(shown)) as Json));
        await legacy.dispose();
      }),
      { numRuns: 25 }
    );
  });
});
