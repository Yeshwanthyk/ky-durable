import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide, LOOK_POSTS, type LookContext, type LookRow, lookRows, SAID_QUIET_MS } from "../../src/dreaming/decide";

/**
 * What a look posts (src/dreaming/decide.ts), over generated rows and pasts. Whatever the rows say:
 *
 * - at most LOOK_POSTS are posted, one per ref, each a known ref with a message, and never a skip;
 * - every prepare comes before every tell, and a prepare's time is ahead and before the next look, if any;
 * - a ref said before is posted again only once the user replied, its anticipation closed, and SAID_QUIET_MS passed;
 * - a look's answer reads back as its rows, fenced or not.
 */

const NOW = 1_800_000_000_000;

const HOUR = 3_600_000;

const REFS = ["anticipation:1", "anticipation:2", "memory:3", "memory:4", "memory:5", "anticipation:9"] as const;

const aRow: fc.Arbitrary<LookRow> = fc.record(
  {
    ref: fc.constantFrom(...REFS),
    needed: fc.string({ maxLength: 6 }),
    current: fc.string({ maxLength: 6 }),
    action: fc.constantFrom("tell" as const, "prepare" as const, "skip" as const),
    by: fc.integer({ min: -24, max: 48 }).map((hours) => new Date(NOW + hours * HOUR).toISOString()),
    message: fc.constantFrom("", " ", "Kai: warm jacket.", "The note, drafted.")
  },
  { requiredKeys: ["ref", "needed", "current", "action"] }
);

const aContext: fc.Arbitrary<LookContext> = fc.record({
  now: fc.constant(NOW),
  next: fc.option(fc.integer({ min: 1, max: 12 }).map((hours) => NOW + hours * HOUR), { nil: null }),
  known: fc.subarray([...REFS]).map((refs) => new Set(refs)),
  said: fc
    .array(fc.tuple(fc.constantFrom(...REFS), fc.record({ at: fc.integer({ min: NOW - 96 * HOUR, max: NOW }), replied: fc.boolean(), open: fc.boolean() })), { maxLength: 4 })
    .map((entries) => new Map(entries))
});

describe("what a look posts", () => {
  it("is at most three known, said-for-the-first-time-or-again rows, prepares first, each prepare due", () => {
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

          const said = context.said.get(row.ref);

          if (said !== undefined) expect(said.replied && !said.open && context.now - said.at >= SAID_QUIET_MS).toBe(true);

          if (row.action === "prepare") {
            const by = Date.parse(row.by ?? "");
            expect(by).toBeGreaterThan(context.now);

            if (context.next !== null) expect(by).toBeLessThanOrEqual(context.next);
          }
        }
      })
    );
  });

  it("leaves out nothing it could post while there is room", () => {
    fc.assert(
      fc.property(fc.array(aRow, { maxLength: 10 }), (rows) => {
        const context: LookContext = { now: NOW, next: null, known: new Set(REFS), said: new Map() };
        const wanted = rows.filter((row) => (row.message ?? "").trim() !== "" && (row.action === "tell" || (row.action === "prepare" && Date.parse(row.by ?? "") > NOW)));

        expect(decide(rows, context).length).toBe(Math.min(LOOK_POSTS, new Set(wanted.map((row) => row.ref)).size));
      })
    );
  });

  it("reads a look's answer back as its rows, fenced or not", () => {
    fc.assert(
      fc.property(fc.array(aRow, { maxLength: 5 }), fc.boolean(), (rows, fenced) => {
        const json = JSON.stringify(rows);

        expect(lookRows(fenced ? `Here:\n\`\`\`json\n${json}\n\`\`\`` : json)).toEqual(rows);
      })
    );
    expect(lookRows("NOTHING")).toEqual([]);
  });
});
