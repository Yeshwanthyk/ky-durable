import * as Schema from "effect/Schema";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertParity, budget, type Instance, type Json, type Parity } from "../parity/kit";
import { legacySide, nextSide } from "../parity/history/sides";
import { type Action, actions, advances, CHATS, DAY, type Make, START, type Say, TEXTS, world } from "../parity/history/world";

fc.configureGlobal({ baseSize: "large" });

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

const Row = Schema.Struct({ rowid: Schema.Number, text: Schema.String, conversation: Schema.String, role: Schema.String, at: Schema.Number });

const Mark = Schema.Struct({ last: Schema.Number, roles: Schema.Number });

const Since = Schema.Struct({ lines: Schema.Array(Schema.String), dropped: Schema.Number });

type Step = { readonly say: Say } | { readonly advance: number } | { readonly reopen: "none" | "roles" } | { readonly search: string };

const sayOnly = actions.filter((action): action is Say => action._tag === "say");

const steps: fc.Arbitrary<Step[]> = fc.array(
  fc.oneof(
    { weight: 6, arbitrary: sayOnly.map((say) => ({ say })) },
    { weight: 2, arbitrary: advances.map((advance) => ({ advance })) },
    { weight: 1, arbitrary: fc.constantFrom("none" as const, "roles" as const).map((reopen) => ({ reopen })) },
    { weight: 2, arbitrary: fc.constantFrom("ferry", "tram", "Lisbon").map((search) => ({ search })) }
  ),
  { maxLength: budget().maxCommands }
);

const textOf = (say: Say) => (say.kind === "look" || !say.parts ? say.text : [say.text, "and so"].join("\n"));

type Said = { readonly id: number; readonly at: number; readonly say: Say };

function drive(run: readonly Step[]) {
  let at = START;
  vi.spyOn(Date, "now").mockImplementation(() => at);
  const made = world(nextSide, () => at);
  const said: Said[] = [];

  for (const step of run) {
    if ("say" in step) said.push({ id: Number(made.apply(step.say)), at, say: step.say });

    if ("advance" in step) at += step.advance;

    if ("reopen" in step) made.apply({ _tag: "reopen", downgrade: step.reopen });

    if ("search" in step) made.apply({ _tag: "search", query: step.search, around: 0, caller: "", batches: null, span: null });
  }

  made.apply({ _tag: "search", query: "ferry", around: 0, caller: "", batches: null, span: null });

  const index = made.db
    .prepare("SELECT rowid, text, conversation, role, at FROM ky_history ORDER BY rowid")
    .all()
    .map((row) => Schema.decodeUnknownSync(Row)(row));

  const mark = Schema.decodeUnknownSync(Mark)(made.db.prepare("SELECT last, roles FROM ky_history_mark").get());

  return { made, said, index, mark, advance: (ms: number) => void (at += ms) };
}

const indexed = (each: Said) => CHATS.has(each.say.conversation) && (each.say.kind === "user" || each.say.kind === "assistant" || each.say.kind === "look") && textOf(each.say).slice(0, 4_000).trim() !== "";

const runs = { numRuns: budget().numRuns, seed: budget().seed };

describe("history invariants", () => {
  it("I-H1: since, with no time given, keeps to the last week by the clock", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 }), fc.integer({ min: 0, max: 10 }), (before, after) => {
        const user: Say = { _tag: "say", conversation: "2", kind: "user", text: TEXTS[0], parts: false, stop: "stop", origin: "own", placed: false, late: false, sameCommit: false };
        const { made, advance } = drive([{ say: user }, { advance: before * DAY }, { say: user }]);

        advance(after * DAY);
        const since = Schema.decodeUnknownSync(Since)(made.side().since({ seq: 0, at: 0 }, 100_000));
        const ages = [before + after, after];
        const fresh = ages.filter((age) => age * DAY < 7 * DAY).length;

        expect([since.lines.length, since.dropped]).toEqual([fresh, 2 - fresh]);
      }),
      runs
    );
  });

  it("I-H2: a chat message's text is indexed as its text parts, up to 4,000 characters", () => {
    fc.assert(
      fc.property(steps, (run) => {
        const { said, index } = drive(run);
        const byId = new Map(index.map((row) => [row.rowid, row.text]));

        for (const each of said.filter(indexed)) expect(byId.get(each.id)).toBe(textOf(each.say).slice(0, 4_000));
      }),
      runs
    );
  });

  it("I-H3: only chats are indexed, each message under its own chat", () => {
    fc.assert(
      fc.property(steps, (run) => {
        const { said, index } = drive(run);
        const expected = said.filter(indexed).map((each) => [each.id, each.say.conversation]);

        expect(index.map((row) => [row.rowid, row.conversation])).toEqual([...expected].sort(([a], [b]) => Number(a) - Number(b)));
      }),
      runs
    );
  });

  it("I-H4: a user entry is the user's only when a submission near it with a bare UUID placed it; every other is a notice, and ky's are ky's", () => {
    fc.assert(
      fc.property(steps, (run) => {
        const { said, index } = drive(run);
        const roles = new Map(index.map((row) => [row.rowid, row.role]));

        for (const each of said.filter(indexed)) {
          expect(roles.get(each.id)).toBe(each.say.kind !== "user" ? "ky" : each.say.origin === "own" ? "user" : "notice");
        }
      }),
      runs
    );
  });

  it("I-H5: a message is indexed at the time it was said", () => {
    fc.assert(
      fc.property(steps, (run) => {
        const { said, index } = drive(run);
        const ats = new Map(index.map((row) => [row.rowid, row.at]));

        for (const each of said.filter(indexed)) expect(ats.get(each.id)).toBe(each.at);
      }),
      runs
    );
  });

  it("I-H6: the mark is the newest entry read, and a message committed late below it is still indexed", () => {
    fc.assert(
      fc.property(steps, (run) => {
        const { said, index, mark } = drive(run);
        const ids = new Set(index.map((row) => row.rowid));

        expect(mark.last).toBe(Math.max(0, ...said.map((each) => each.id)));

        for (const each of said.filter(indexed)) expect(ids.has(each.id)).toBe(true);
      }),
      runs
    );
  });

  it("I-H7: an index built before notices were told apart is built again when opened", () => {
    fc.assert(
      fc.property(steps, (run) => {
        const { made, said } = drive(run);

        made.db.exec("UPDATE ky_history SET role = 'stale'");
        made.apply({ _tag: "reopen", downgrade: "roles" });
        made.apply({ _tag: "search", query: "ferry", around: 0, caller: "", batches: null, span: null });

        const roles = made.db.prepare("SELECT role FROM ky_history").all().map((row) => Schema.decodeUnknownSync(Schema.Struct({ role: Schema.String }))(row).role);
        const marked = Schema.decodeUnknownSync(Mark)(made.db.prepare("SELECT last, roles FROM ky_history_mark").get());

        expect([roles.includes("stale"), marked.roles, roles.length]).toEqual([false, 1, said.filter(indexed).length]);
      }),
      runs
    );
  });
});
