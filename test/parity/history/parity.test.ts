import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { assertParity, type Instance, type Json, type Parity } from "../kit";
import { nextSide } from "./next";
import { legacySide } from "./sides";
import { type Action, actions, advances, type Make, START, world } from "./world";

let warned: Json[] = [];

beforeEach(() => {
  warned = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void warned.push(args.map(String)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function instance(make: Make, now: () => number): Instance<Action> {
  const made = world(make, now);
  const seen: Json[] = [];

  return {
    apply: async (action) => {
      const from = warned.length;
      const result = made.apply(action);

      seen.push(...warned.slice(from));

      return result;
    },
    tables: async () => made.tables(),
    effects: async () => ({ warned: seen }),
    dispose: async () => made.db.close()
  };
}

const historyParity: Parity<Action> = {
  domain: "history",
  actions,
  advances,
  start: START,
  legacy: async (clock) => {
    vi.spyOn(Date, "now").mockImplementation(() => clock.now());

    return instance(legacySide, () => clock.now());
  },
  next: async (clock) => instance(nextSide, () => clock.now())
};

describe("history parity", () => {
  it("indexes, searches, reads since and tells whose message it was, as B does, step for step", async () => {
    await assertParity(historyParity);
  });
});
