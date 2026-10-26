import * as Schema from "effect/Schema";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { budget } from "../parity/kit";
import { nextSide } from "../parity/history/next";
import { actions, advances, CHATS, CONVERSATIONS, DAY, LONG, type Say, START, stampOf, TEXTS, world } from "../parity/history/world";

fc.configureGlobal({ baseSize: "large" });

afterEach(() => {
  vi.restoreAllMocks();
});

const Row = Schema.Struct({ rowid: Schema.Number, text: Schema.String, conversation: Schema.String, role: Schema.String, at: Schema.Union([Schema.Number, Schema.String]) });

const Mark = Schema.Struct({ last: Schema.Number, roles: Schema.Number });

const Since = Schema.Struct({ lines: Schema.Array(Schema.String), dropped: Schema.Number, through: Schema.Number });

const Seq = Schema.Struct({ commit_seq: Schema.Number });

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

const said = (conversation: string, text: string, origin: Say["origin"], kind: Say["kind"] = "user"): Say => ({
  _tag: "say",
  conversation,
  kind,
  text,
  parts: false,
  stop: "stop",
  origin,
  placed: false,
  late: false,
  sameCommit: false,
  stamp: "ms"
});

const wordsOf = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []));

const hitsOf = (answer: string) => [...answer.matchAll(/^#(\d+) /gm)].map(([, id]) => Number(id));

const search = (query: string) => ({ _tag: "search" as const, query, around: 0, caller: "", batches: null, span: null });

const timed = Schema.is(Schema.Number);

type Span = { readonly from: number; readonly to: number };

const find = (made: ReturnType<typeof world>, query: string, caller = "", span?: Span, around = 0) =>
  made.side().search(query, span === undefined ? { around, caller } : { around, caller, span: { ...span, days: "then" } });

function drive(run: readonly Step[]) {
  let at = START;
  vi.spyOn(Date, "now").mockImplementation(() => at);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const made = world(nextSide, () => at);
  const saids: Said[] = [];

  for (const step of run) {
    if ("say" in step) saids.push({ id: Number(made.apply(step.say)), at, say: step.say });

    if ("advance" in step) at += step.advance;

    if ("reopen" in step) made.apply({ _tag: "reopen", downgrade: step.reopen });

    if ("search" in step) made.apply(search(step.search));
  }

  made.apply(search("ferry"));

  const index = made.db
    .prepare("SELECT rowid, text, conversation, role, at FROM ky_history ORDER BY rowid")
    .all()
    .map((row) => Schema.decodeUnknownSync(Row)(row));

  const mark = Schema.decodeUnknownSync(Mark)(made.db.prepare("SELECT last, roles FROM ky_history_mark").get());

  return { made, said: saids, index, mark, now: () => at, advance: (ms: number) => void (at += ms) };
}

const indexed = (each: Said) => CHATS.has(each.say.conversation) && (each.say.kind === "user" || each.say.kind === "assistant" || each.say.kind === "look") && textOf(each.say).slice(0, 4_000).trim() !== "";

const runs = { numRuns: budget().numRuns, seed: budget().seed };

describe("history invariants", () => {
  it("I-H1: since, with no time given, keeps to the last week by the clock", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 }), fc.integer({ min: 0, max: 10 }), (before, after) => {
        const user = said("2", TEXTS[0], "own");
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

  it("I-H5: a message is indexed at the time it was said, as its entry gives it, a damaged time too", () => {
    fc.assert(
      fc.property(steps, (run) => {
        const { said, index } = drive(run);
        const ats = new Map(index.map((row) => [row.rowid, row.at]));

        for (const each of said.filter(indexed)) expect(ats.get(each.id)).toBe(stampOf(each.say, each.at));
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
        made.apply(search("ferry"));

        const roles = made.db.prepare("SELECT role FROM ky_history").all().map((row) => Schema.decodeUnknownSync(Schema.Struct({ role: Schema.String }))(row).role);
        const marked = Schema.decodeUnknownSync(Mark)(made.db.prepare("SELECT last, roles FROM ky_history_mark").get());

        expect([roles.includes("stale"), marked.roles, roles.length]).toEqual([false, 1, said.filter(indexed).length]);
      }),
      runs
    );
  });

  it("I-H8: a query with no words asks for some, and one with words searches", () => {
    fc.assert(
      fc.property(steps, fc.constantFrom("", "   ", "?!", "— …", "ferry", "?tram!", "Kyoto"), (run, query) => {
        const { made } = drive(run);
        const answer = find(made, query);

        expect(answer === "Give some words to search for.").toBe(wordsOf(query).size === 0);
      }),
      runs
    );
  });

  it("I-H9: a message with every word is a match; with none such, those with some are shown as some", () => {
    fc.assert(
      fc.property(steps, fc.constantFrom("Kyoto tram", "ferry Lisbon", "zanzibar Kyoto"), (run, query) => {
        const { made, index } = drive(run);
        const words = [...wordsOf(query)];
        const found = index.filter((row) => timed(row.at)).map((row) => wordsOf(row.text));
        const every = found.some((has) => words.every((word) => has.has(word)));
        const some = found.some((has) => words.some((word) => has.has(word)));
        const opening = every ? /^#\d+ / : some ? /^No message has all those words; these have some of them\.\n#\d+ / : /^No message matches /;

        expect(find(made, query)).toMatch(opening);
      }),
      runs
    );
  });

  it("I-H10: a search finds each message with the word sent in its span, but the user's newest question in the caller's chat", () => {
    fc.assert(
      fc.property(steps, fc.constantFrom(...CONVERSATIONS, ""), fc.option(fc.record({ from: fc.integer({ min: -1, max: 3 }), to: fc.integer({ min: 0, max: 5 }) })), (run, caller, days) => {
        const { made, index } = drive(run);
        const span = days === null ? undefined : { from: START + days.from * DAY, to: START + days.to * DAY };
        const asking = Math.max(-1, ...index.filter((row) => row.conversation === caller && row.role === "user").map((row) => row.rowid));

        const expected = index
          .filter((row) => timed(row.at) && (span === undefined || (row.at >= span.from && row.at < span.to)))
          .filter((row) => row.rowid !== asking && wordsOf(row.text).has("ferry"))
          .map((row) => row.rowid);

        const hits = hitsOf(find(made, "ferry", caller, span));

        if (expected.length <= 8) expect([...hits].sort((a, b) => a - b)).toEqual(expected);
        else expect(hits.length).toBe(8);
      }),
      runs
    );
  });

  it("I-H11: what a search shows stays within 12,000 characters, the rest named as cut", () => {
    fc.assert(
      fc.property(fc.integer({ min: 9, max: 20 }), fc.integer({ min: 1, max: 8 }), (count, around) => {
        const { made } = drive(Array.from({ length: count }, () => ({ say: said("2", LONG, "own") })));
        const answer = find(made, "ferry", "", undefined, around);
        const shown = answer.slice(0, answer.lastIndexOf("\n\n") + 2);

        expect(shown.length).toBeLessThanOrEqual(12_000);
        expect(answer).toMatch(/\n\d+ match(es)?(, \d+ more cut for length)?\. Search again with other words to find more\.$/);
      }),
      runs
    );
  });

  it("I-H12: since stops before a user's message that does not fit, so the next reader starts with it", () => {
    fc.assert(
      fc.property(steps, fc.constantFrom(0, 1, 2, 4), fc.constantFrom(40, 80, 200, 600), (run, from, chars) => {
        const { made } = drive(run);
        const read = (seq: number, budget: number) => Schema.decodeUnknownSync(Since)(made.side().since({ seq, at: 0 }, budget));
        const all = read(from, 1e9);
        const first = read(from, chars);
        const cut = all.lines.find((line) => line.includes(", user: ") && !first.lines.includes(line));

        if (cut === undefined) return;

        const rowid = Number(/^#(\d+) /.exec(cut)?.[1]);
        const { commit_seq } = Schema.decodeUnknownSync(Seq)(made.db.prepare("SELECT commit_seq FROM pi_entries WHERE id = ?").get(rowid));

        if (commit_seq - 1 > from) expect(read(first.through, 1e9).lines).toContain(cut);
      }),
      runs
    );
  });

  it("I-H13: a chat's latest is its newest look or finished reply with text", () => {
    fc.assert(
      fc.property(steps, (run) => {
        const { made, said } = drive(run);

        for (const session of CONVERSATIONS) {
          const done = said
            .filter(({ say }) => say.conversation === session && (say.kind === "look" || (say.kind === "assistant" && (say.stop === "stop" || say.stop === "length"))))
            .filter(({ say }) => textOf(say).trim() !== "")
            .sort((a, b) => b.id - a.id);

          expect(made.side().latest(session)).toBe(done[0] === undefined ? null : textOf(done[0].say));
        }
      }),
      runs
    );
  });

  it("I-H14: whether the user wrote since looks at the chat's newest 20 user messages", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 30 }), (notices) => {
        const { made } = drive([{ say: said("2", TEXTS[0], "own") }, ...Array.from({ length: notices }, () => ({ say: said("2", TEXTS[1], "relay") }))]);

        expect(made.reads.wroteSince("2", START - 1)).toBe(notices < 20);
      }),
      runs
    );
  });
});
