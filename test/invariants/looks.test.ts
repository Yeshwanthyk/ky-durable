import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide, LOOK_POSTS, type LookContext, type LookRow, lookRows, NEW_WATCHES, newWatches, SAID_QUIET_MS, type SaidRef, WATCHES } from "../../src/dreaming/decide";

/**
 * What a look posts (src/dreaming/decide.ts), over generated rows and pasts. Whatever the rows say:
 *
 * - at most LOOK_POSTS are posted, one per ref, each one of the rows, a known ref with a message, and never a skip;
 * - every prepare comes before every tell, and a prepare's time is ahead and no later than the next look, if any;
 * - a ref said before is said again only when the user replied since, or when its anticipation is not open and
 *   SAID_QUIET_MS passed (a memory has no anticipation, so only the time counts);
 * - nothing that may be posted is left out while there is room: the posts are exactly what an independent model of
 *   those rules picks;
 * - posting is idempotent: the same rows, with what was just posted marked said now, say none of it again unless
 *   the user replied;
 * - a look's answer reads back as its rows, fenced or not, and rows that are not rows are dropped;
 * - the watches a look books are rows with a gate and a prompt on a watch anticipation not watched yet, one per ref,
 *   at most NEW_WATCHES, never past WATCHES live, and as many as that allows.
 */

const NOW = 1_800_000_000_000;

const HOUR = 3_600_000;

const REFS = ["anticipation:1", "anticipation:2", "memory:3", "memory:4", "memory:5", "anticipation:9"] as const;

const isAnticipation = (ref: string) => ref.startsWith("anticipation:");

/** A prepare's time: around now and the next look, exactly on them too, or not a time at all. */
const aBy = fc.oneof(
  fc.integer({ min: -24 * 60, max: 48 * 60 }).map((minutes) => new Date(NOW + minutes * 60_000).toISOString()),
  fc.constantFrom(new Date(NOW).toISOString(), new Date(NOW + 3 * HOUR).toISOString(), new Date(NOW + 3 * HOUR + 1).toISOString(), "", "tomorrow at nine")
);

const aRow: fc.Arbitrary<LookRow> = fc.record(
  {
    ref: fc.constantFrom(...REFS),
    needed: fc.string({ maxLength: 6 }),
    current: fc.string({ maxLength: 6 }),
    action: fc.constantFrom("tell" as const, "prepare" as const, "skip" as const),
    by: aBy,
    message: fc.constantFrom("", " ", "\n\t", "Kai: warm jacket.", "The note, drafted.", "Call the bank.")
  },
  { requiredKeys: ["ref", "needed", "current", "action"] }
);

/** When a ref was said: any time in the last four days, and on either side of SAID_QUIET_MS exactly. */
const anAt = fc.oneof(fc.integer({ min: NOW - 96 * HOUR, max: NOW }), fc.constantFrom(NOW - SAID_QUIET_MS, NOW - SAID_QUIET_MS + 1, NOW));

/** Said refs; a memory's is never open, as looks.ts reads only anticipations as open. */
const aSaid = fc
  .array(fc.tuple(fc.constantFrom(...REFS), fc.record({ at: anAt, replied: fc.boolean(), open: fc.boolean() })), { maxLength: 6 })
  .map((entries) => new Map(entries.map(([ref, said]) => [ref, { ...said, open: isAnticipation(ref) && said.open }] as const)));

const aContext: fc.Arbitrary<LookContext> = fc.record({
  now: fc.constant(NOW),
  next: fc.option(fc.constantFrom(NOW + HOUR, NOW + 3 * HOUR, NOW + 5 * HOUR, NOW + 12 * HOUR), { nil: null }),
  known: fc.subarray([...REFS]).map((refs) => new Set<string>(refs)),
  said: aSaid
});

/** What a model may put in its array that is not a row: a number, a string, null, a list, or an object with no ref. */
const aNonRow = fc.oneof(fc.integer(), fc.string(), fc.constant(null), fc.array(fc.integer(), { maxLength: 2 }), fc.record({ needed: fc.string(), action: fc.constant("tell") }));

/** The owner's repeat rule: again when the user replied since, or when nothing holds it open and SAID_QUIET_MS passed. */
const mayRepeat = (said: SaidRef, now: number) => said.replied || (!said.open && now - said.at >= SAID_QUIET_MS);

/** A prepare is due when its time is ahead and the next look, if any, would be too late for it. */
const isDue = (row: LookRow, { now, next }: LookContext) => {
  const by = Date.parse(row.by ?? "");

  return Number.isFinite(by) && by > now && (next === null || by <= next);
};

/** May `row` be posted at all, by the rules, before the cap and one per ref. */
function postable(row: LookRow, context: LookContext): boolean {
  const said = context.said.get(row.ref);

  if (row.action === "skip" || (row.message ?? "").trim() === "" || !context.known.has(row.ref)) return false;

  if (said !== undefined && !mayRepeat(said, context.now)) return false;

  return row.action === "tell" || isDue(row, context);
}

/** The model: the postable prepares, then the postable tells, each in the rows' order, first row of a ref, at most LOOK_POSTS. */
function model(rows: readonly LookRow[], context: LookContext): LookRow[] {
  const picked: LookRow[] = [];
  const postableRows = rows.filter((row) => postable(row, context));

  for (const row of [...postableRows.filter((each) => each.action === "prepare"), ...postableRows.filter((each) => each.action === "tell")]) {
    if (picked.length < LOOK_POSTS && !picked.some((each) => each.ref === row.ref)) picked.push(row);
  }

  return picked;
}

describe("what a look posts", () => {
  it("is at most three of its rows, one per ref, known, with a message, never a skip, prepares first and each due", () => {
    fc.assert(
      fc.property(fc.array(aRow, { maxLength: 10 }), aContext, (rows, context) => {
        const posted = decide(rows, context);

        expect(posted.length).toBeLessThanOrEqual(LOOK_POSTS);
        expect(new Set(posted.map((row) => row.ref)).size).toBe(posted.length);
        expect(posted.findIndex((row) => row.action === "tell")).toBe(posted.findIndex((row) => row.action !== "prepare"));

        for (const row of posted) {
          expect(rows).toContain(row);
          expect(row.action).not.toBe("skip");
          expect(row.message?.trim()).toBeTruthy();
          expect(context.known.has(row.ref)).toBe(true);

          if (row.action === "prepare") expect(isDue(row, context)).toBe(true);
        }
      }),
      { numRuns: 500 }
    );
  });

  it("says a ref again only when the user replied since, or nothing holds it open and 48 hours passed", () => {
    fc.assert(
      fc.property(fc.array(aRow, { maxLength: 10 }), aContext, (rows, context) => {
        for (const row of decide(rows, context)) {
          const said = context.said.get(row.ref);

          if (said !== undefined) expect(mayRepeat(said, context.now)).toBe(true);
        }
      }),
      { numRuns: 500 }
    );
  });

  it("posts exactly what the rules allow, leaving out nothing while there is room", () => {
    fc.assert(
      fc.property(fc.array(aRow, { maxLength: 10 }), aContext, (rows, context) => {
        expect(decide(rows, context).map((row) => row.ref)).toEqual(model(rows, context).map((row) => row.ref));
      }),
      { numRuns: 500 }
    );
  });

  it("says nothing it just said again, unless the user replied since", () => {
    fc.assert(
      fc.property(fc.array(aRow, { maxLength: 10 }), aContext, fc.boolean(), (rows, context, replied) => {
        const posted = decide(rows, context);
        const said = new Map(context.said);

        for (const row of posted) said.set(row.ref, { at: context.now, replied, open: isAnticipation(row.ref) });
        const again = decide(rows, { ...context, said }).map((row) => row.ref);
        const repeated = posted.filter((row) => again.includes(row.ref));

        if (!replied) expect(repeated).toEqual([]);
        // Replied: the conversation moved on, so each may come up again, as the rest of the rules allow.
        else expect(again).toEqual(model(rows, { ...context, said }).map((row) => row.ref));
      }),
      { numRuns: 500 }
    );
  });

  // The two halves of the repeat rule, each alone: the user replied to a ref still open an hour ago, and a memory
  // said three days ago with no reply. Both may come up again.
  it.each([
    ["anticipation:1", { at: NOW - HOUR, replied: true, open: true }],
    ["memory:3", { at: NOW - 72 * HOUR, replied: false, open: false }]
  ] as const)("says %s again when its rule allows", (ref, said) => {
    const row: LookRow = { ref, needed: "n", current: "c", action: "tell", message: "Again." };

    expect(decide([row], { now: NOW, next: null, known: new Set([ref]), said: new Map([[ref, said]]) })).toEqual([row]);
  });

  it("reads a look's answer back as its rows, fenced or not, dropping what is not a row", () => {
    fc.assert(
      fc.property(fc.array(aRow, { maxLength: 5 }), fc.boolean(), fc.array(aNonRow, { maxLength: 3 }), (rows, fenced, junk) => {
        const json = JSON.stringify([...junk, ...rows]);

        expect(lookRows(fenced ? `Here:\n\`\`\`json\n${json}\n\`\`\`` : json)).toEqual(rows);
      })
    );
    expect(lookRows("NOTHING")).toEqual([]);
    expect(lookRows("[not json]")).toEqual([]);
  });
});

/** A row that may ask for a watch: a gate and a prompt, blank or missing too. */
const aWatchRow: fc.Arbitrary<LookRow> = fc.record(
  {
    ref: fc.constantFrom(...REFS),
    needed: fc.constant("n"),
    current: fc.constant("c"),
    action: fc.constantFrom("tell" as const, "skip" as const),
    gate: fc.constantFrom("", " ", 'answer "pending"', "answer null"),
    prompt: fc.constantFrom("", "\n", "Say how CI went.")
  },
  { requiredKeys: ["ref", "needed", "current", "action"] }
);

const anticipations: readonly string[] = REFS.filter(isAnticipation);

/** Watched refs: some anticipations, or more than WATCHES of made-up ones. */
const aWatched = fc.oneof(
  fc.subarray([...anticipations]),
  fc.integer({ min: 0, max: WATCHES + 1 }).map((n) => Array.from({ length: n }, (_, index) => `anticipation:${100 + index}`))
);

describe("the watches a look books", () => {
  it("are rows with a gate and a prompt on a watch not watched yet, one per ref, two a look, five at most, and as many as that allows", () => {
    fc.assert(
      fc.property(fc.array(aWatchRow, { maxLength: 10 }), fc.subarray([...anticipations]), aWatched, (rows, watchable, watchedRefs) => {
        const watched = new Set(watchedRefs);
        const booked = newWatches(rows, new Set(watchable), watched);
        const wanted = rows.filter((row) => row.gate?.trim() && row.prompt?.trim() && watchable.includes(row.ref) && !watched.has(row.ref));
        const refs = [...new Set(wanted.map((row) => row.ref))];

        expect(booked.map((row) => row.ref)).toEqual(refs.slice(0, Math.max(0, Math.min(NEW_WATCHES, WATCHES - watched.size))));

        for (const row of booked) expect(rows).toContain(row);
        expect(booked.length).toBeLessThanOrEqual(NEW_WATCHES);
        expect(watched.size + booked.length).toBeLessThanOrEqual(Math.max(WATCHES, watched.size));
      }),
      { numRuns: 500 }
    );
  });
});
