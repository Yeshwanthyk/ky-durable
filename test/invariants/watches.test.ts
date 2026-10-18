import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type LookRow, NEW_WATCHES, newWatches, WATCHES } from "../../src/dreaming/decide";

/**
 * A look's watches over many looks (src/dreaming/looks.ts), run over generated operations: looks whose rows ask for
 * watches, new anticipations, closes, Proactivity turned off and on, and the user pausing, archiving or deleting a
 * watch's automation. What a look books is the real newWatches; around it is a model of what Looks does with it: a
 * look while Proactivity is on retires first, then books each pick whose gate passes, and a close or a Proactivity
 * change retires (as src/server.ts wires them). A watch's row stays whatever its status until it is deleted, as in
 * ky_automations. After each step:
 *
 * - at most WATCHES watches, and at most NEW_WATCHES booked by one look;
 * - each on an open anticipation of kind watch, and none while Proactivity is off;
 * - no anticipation has two.
 *
 * Steps run one after another. Looks, Anticipations and Automations load cloudflare: modules node cannot, so a close
 * or Proactivity off while a look awaits its model or a gate is not covered here.
 */

/** Anticipation ids a step names: some of watch kind, some not, some never added. */
const IDS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

type Op =
  | { readonly op: "look"; readonly rows: readonly LookRow[]; readonly failing: readonly number[] }
  | { readonly op: "add"; readonly id: number; readonly watch: boolean }
  | { readonly op: "close"; readonly id: number }
  | { readonly op: "proactivity"; readonly on: boolean }
  | { readonly op: "pause" | "archive" | "delete"; readonly index: number };

const id = fc.constantFrom(...IDS);

/** Mostly there, so most rows ask for a watch. */
const mostly = (text: string) => fc.constantFrom(text, text, text, "", " ");

const aRow: fc.Arbitrary<LookRow> = fc.record(
  {
    ref: fc.oneof(id.map((each) => `anticipation:${each}`), fc.constant("memory:1")),
    needed: fc.constant("n"),
    current: fc.constant("c"),
    action: fc.constantFrom("tell" as const, "skip" as const),
    gate: mostly('return "pending"'),
    prompt: mostly("Say how it went.")
  },
  { requiredKeys: ["ref", "needed", "current", "action"] }
);

const anOp: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ op: fc.constant("look" as const), rows: fc.array(aRow, { maxLength: 6 }), failing: fc.subarray([...IDS], { maxLength: 2 }) }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("add" as const), id, watch: fc.constantFrom(true, true, true, false) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("close" as const), id }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("proactivity" as const), on: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constantFrom("pause" as const, "archive" as const, "delete" as const), index: fc.nat(5) }) }
);

type Watch = { readonly watch: number; status: "active" | "paused" | "archived" };

/** What the steps leave: anticipations by id (kind watch or not, open or not), the level, and the watches' rows. */
class World {
  readonly anticipations = new Map<number, { readonly watch: boolean; open: boolean }>();
  on = true;
  watches: Watch[] = [];
  /** Booked by the last step. */
  booked = 0;

  step(op: Op): void {
    this.booked = 0;

    if (op.op === "look") this.#look(op.rows, new Set(op.failing));
    else if (op.op === "add") this.#add(op.id, op.watch);
    else if (op.op === "close") this.#close(op.id);
    else if (op.op === "proactivity") this.#proactivity(op.on);
    else this.#user(op.op, op.index);
  }

  check(): void {
    const open = new Set(this.#openWatches());

    expect(this.watches.length).toBeLessThanOrEqual(WATCHES);
    expect(this.booked).toBeLessThanOrEqual(NEW_WATCHES);
    expect(this.watches.filter((each) => !open.has(each.watch))).toEqual([]);

    if (!this.on) expect(this.watches).toEqual([]);
    expect(new Set(this.watches.map((each) => each.watch)).size).toBe(this.watches.length);
  }

  /** Looks.run: none while Proactivity is off; else retire, then book newWatches' picks whose gate passes. */
  #look(rows: readonly LookRow[], failing: ReadonlySet<number>): void {
    if (!this.on) return;
    this.#retire();
    const watchable = new Set(this.#openWatches().map((each) => `anticipation:${each}`));
    const watched = new Set(this.watches.map((each) => `anticipation:${each.watch}`));

    for (const row of newWatches(rows, watchable, watched)) {
      const watch = Number(row.ref.slice("anticipation:".length));

      if (failing.has(watch)) continue;
      this.watches.push({ watch, status: "active" });
      this.booked++;
    }
  }

  /** Looks.retire: each watch whose anticipation is no longer an open watch goes, and every one while off. */
  #retire(): void {
    const open = new Set(this.on ? this.#openWatches() : []);
    this.watches = this.watches.filter((each) => open.has(each.watch));
  }

  #openWatches(): number[] {
    return [...this.anticipations].flatMap(([each, row]) => (row.watch && row.open ? [each] : []));
  }

  #add(each: number, watch: boolean): void {
    if (!this.anticipations.has(each)) this.anticipations.set(each, { watch, open: true });
  }

  /** Anticipations.onClose: a close (done, dismissed, absorbed or expired) retires. */
  #close(each: number): void {
    const row = this.anticipations.get(each);

    if (row?.open !== true) return;
    row.open = false;
    this.#retire();
  }

  /** Proactivity.onChange retires, whichever way it went. */
  #proactivity(on: boolean): void {
    this.on = on;
    this.#retire();
  }

  /** The user, in the Automations panel: a paused or archived watch keeps its row, a deleted one has none. */
  #user(op: "pause" | "archive" | "delete", index: number): void {
    const row = this.watches[index % Math.max(1, this.watches.length)];

    if (row === undefined) return;

    if (op === "delete") this.watches = this.watches.filter((each) => each !== row);
    else row.status = op === "pause" ? "paused" : "archived";
  }
}

describe("a look's watches over many looks", () => {
  it("are at most five, two new a look, one an anticipation, each on an open watch, and none while Proactivity is off", () => {
    fc.assert(
      fc.property(fc.array(anOp, { minLength: 10, maxLength: 40 }), (ops) => {
        const world = new World();

        for (const op of ops) {
          world.step(op);
          world.check();
        }
      }),
      { numRuns: 500 }
    );
  });

  it("fill up to five, two a look, and take no more while five are paused or archived", () => {
    const world = new World();

    for (const each of IDS) world.step({ op: "add", id: each, watch: true });
    const rows = IDS.map((each): LookRow => ({ ref: `anticipation:${each}`, needed: "n", current: "c", action: "skip", gate: "return 1", prompt: "p" }));

    for (const booked of [2, 2, 1, 0]) {
      world.step({ op: "look", rows, failing: [] });
      expect(world.booked).toBe(booked);
    }

    for (const index of [0, 1, 2, 3, 4]) world.step({ op: index % 2 === 0 ? "pause" : "archive", index });
    world.step({ op: "look", rows, failing: [] });
    expect([world.booked, world.watches.length]).toEqual([0, WATCHES]);
  });
});
