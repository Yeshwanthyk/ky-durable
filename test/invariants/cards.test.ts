import type { JsonValue } from "@earendil-works/chord";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { answerOf, cardOf } from "../../src/cards/contract";
import { budget } from "../parity/kit";
import { world } from "../parity/cards/world";

fc.configureGlobal({ baseSize: "large" });

vi.setConfig({ testTimeout: 600_000 });

type Block = { [key: string]: JsonValue };

type Card = Block & { blocks: Block[] };

const word = fc.string({ unit: fc.constantFrom("a", "b", " ", "é", "😀", ":", ",", "\n"), maxLength: 12 });

const span = (min: number, max: number) =>
  fc.integer({ min, max }).chain((length) => fc.array(fc.constantFrom("a", "😀"), { minLength: length, maxLength: length }).map((units) => units.join("")));

const hex = fc.string({ unit: fc.constantFrom(..."0123456789abcdef".split("")), minLength: 32, maxLength: 32 });

const source = fc.oneof(hex, word.map((path) => `https://example.com/${path.replace(/\s/g, "")}`));

const tone = fc.constantFrom("info", "success", "warning", "error");

const number = fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }).map((value) => (Object.is(value, -0) ? 0 : value));

const clean = (value: Record<string, JsonValue | undefined>): Block =>
  Object.fromEntries(Object.entries(value).filter((entry): entry is [string, JsonValue] => entry[1] !== undefined));

const record = <T extends Record<string, fc.Arbitrary<JsonValue>>>(fields: T, requiredKeys: Array<keyof T & string>): fc.Arbitrary<Block> =>
  fc.record(fields, { requiredKeys }).map(clean);

const valid = {
  text: record({ type: fc.constant("text"), text: word }, ["type", "text"]),
  list: record(
    { type: fc.constant("list"), label: word, items: fc.array(record({ title: word, detail: word, meta: word }, ["title"]), { maxLength: 30 }) },
    ["type", "items"]
  ),
  facts: record({ type: fc.constant("facts"), rows: fc.array(record({ label: word, value: word }, ["label", "value"]), { maxLength: 20 }) }, ["type", "rows"]),
  image: record({ type: fc.constant("image"), src: source, caption: word }, ["type", "src"]),
  audio: record({ type: fc.constant("audio"), src: source, caption: word }, ["type", "src"]),
  video: record({ type: fc.constant("video"), src: source, caption: word }, ["type", "src"]),
  status: record({ type: fc.constant("status"), text: word, tone }, ["type", "text"]),
  stats: record(
    {
      type: fc.constant("stats"),
      items: fc.array(record({ value: fc.oneof(word, number), label: word, tone, series: fc.integer({ min: 1, max: 6 }) }, ["value", "label"]), { minLength: 1, maxLength: 6 })
    },
    ["type", "items"]
  ),
  chart: record(
    {
      type: fc.constant("chart"),
      kind: fc.constantFrom("bar", "line", "donut"),
      label: word,
      x: fc.array(word, { minLength: 1, maxLength: 60 }),
      series: fc.array(record({ name: word, values: fc.array(number, { maxLength: 60 }) }, ["name", "values"]), { minLength: 1, maxLength: 6 }),
      stacked: fc.boolean(),
      unit: word
    },
    ["type", "kind", "x", "series"]
  ),
  table: record(
    {
      type: fc.constant("table"),
      label: word,
      columns: fc.array(word, { minLength: 1, maxLength: 8 }),
      rows: fc.array(fc.array(word, { maxLength: 8 }), { maxLength: 50 })
    },
    ["type", "columns", "rows"]
  ),
  choice: record(
    {
      type: fc.constant("choice"),
      label: word,
      options: fc.array(record({ label: word, detail: word }, ["label"]), { minLength: 1, maxLength: 12 }),
      multiple: fc.boolean(),
      hint: word
    },
    ["type", "label", "options"]
  ),
  input: record({ type: fc.constant("input"), label: word, placeholder: word, multiline: fc.boolean() }, ["type", "label"]),
  buttons: record(
    {
      type: fc.constant("buttons"),
      buttons: fc.array(record({ label: word, reply: word, url: word, tone: fc.constantFrom("primary", "default", "danger") }, ["label"]), { minLength: 1, maxLength: 4 })
    },
    ["type", "buttons"]
  ),
  page: record({ type: fc.constant("page"), site: hex, title: word, height: fc.integer({ min: 80, max: 2000 }) }, ["type", "site"]),
  routine: record({ type: fc.constant("routine"), routine: span(0, 64) }, ["type", "routine"])
};

const shown = fc.oneof(valid.text, valid.list, valid.facts, valid.image, valid.audio, valid.video, valid.status, valid.stats, valid.chart, valid.table);

const tabs = record(
  { type: fc.constant("tabs"), tabs: fc.array(record({ label: word, blocks: fc.array(shown, { minLength: 1, maxLength: 8 }) }, ["label", "blocks"]), { minLength: 2, maxLength: 6 }) },
  ["type", "tabs"]
);

const columns = record(
  { type: fc.constant("columns"), columns: fc.array(fc.array(fc.oneof(shown, tabs), { minLength: 1, maxLength: 8 }), { minLength: 2, maxLength: 3 }) },
  ["type", "columns"]
);

const asking = fc.oneof(valid.choice, valid.input, valid.buttons);

const block: fc.Arbitrary<Block> = fc.oneof(shown, asking, valid.page, valid.routine, tabs, columns);

const many = <T>(item: fc.Arbitrary<T>, length: number) => fc.array(item, { minLength: length, maxLength: length });

const cell = record({ label: word }, ["label"]);

const breaks = {
  "an unknown type": fc.record({ type: fc.constantFrom("map", "poll", ""), text: word }),
  "a missing field": fc.constantFrom<Block>({ type: "text" }, { type: "choice", label: "Pick" }, { type: "image" }),
  "a source not ky's nor https": fc.record({ type: fc.constantFrom("image", "audio", "video"), src: fc.constantFrom("http://example.com/a.png", "javascript:alert(1)", "/files/x", "https://a b", "ABCDEF0123456789abcdef0123456789") }),
  "over 30 list items": fc.tuple(valid.list, many(record({ title: word }, ["title"]), 31)).map(([list, items]) => ({ ...list, items })),
  "over 20 facts": fc.tuple(valid.facts, many(record({ label: word, value: word }, ["label", "value"]), 21)).map(([facts, rows]) => ({ ...facts, rows })),
  "stats with no item": valid.stats.map((stats) => ({ ...stats, items: [] })),
  "over 6 stats": fc.tuple(valid.stats, many(record({ value: number, label: word }, ["value", "label"]), 7)).map(([stats, items]) => ({ ...stats, items })),
  "a series out of range": valid.stats.chain((stats) => fc.constantFrom(0, 7, 1.5).map((series) => ({ ...stats, items: [{ value: 1, label: "n", series }] }))),
  "a chart with no x": valid.chart.map((chart) => ({ ...chart, x: [] })),
  "over 60 x": fc.tuple(valid.chart, many(word, 61)).map(([chart, x]) => ({ ...chart, x })),
  "a chart with no series": valid.chart.map((chart) => ({ ...chart, series: [] })),
  "over 6 series": fc.tuple(valid.chart, many(record({ name: word, values: fc.constant([]) }, ["name", "values"]), 7)).map(([chart, series]) => ({ ...chart, series })),
  "over 60 values": fc.tuple(valid.chart, many(number, 61)).map(([chart, values]) => ({ ...chart, series: [{ name: "s", values }] })),
  "a table with no column": valid.table.map((table) => ({ ...table, columns: [] })),
  "over 8 columns": fc.tuple(valid.table, many(word, 9)).map(([table, columns]) => ({ ...table, columns })),
  "over 50 rows": valid.table.map((table) => ({ ...table, rows: Array.from({ length: 51 }, () => []) })),
  "a row over 8 cells": fc.tuple(valid.table, many(word, 9)).map(([table, row]) => ({ ...table, rows: [row] })),
  "a lone tab": valid.text.map((text) => ({ type: "tabs", tabs: [{ label: "only", blocks: [text] }] })),
  "over 6 tabs": fc.tuple(many(shown, 7)).map(([each]) => ({ type: "tabs", tabs: each.map((one, index) => ({ label: `t${index}`, blocks: [one] })) })),
  "a tab with no block": shown.map((one) => ({ type: "tabs", tabs: [{ label: "a", blocks: [] }, { label: "b", blocks: [one] }] })),
  "a tab over 8 blocks": fc.tuple(many(shown, 9), shown).map(([each, one]) => ({ type: "tabs", tabs: [{ label: "a", blocks: each }, { label: "b", blocks: [one] }] })),
  "a lone column": shown.map((one) => ({ type: "columns", columns: [[one]] })),
  "over 3 columns": many(shown, 4).map((each) => ({ type: "columns", columns: each.map((one) => [one]) })),
  "an empty column": shown.map((one) => ({ type: "columns", columns: [[], [one]] })),
  "a column over 8 blocks": fc.tuple(many(shown, 9), shown).map(([each, one]) => ({ type: "columns", columns: [each, [one]] })),
  "a question in columns": fc.tuple(shown, asking).map(([one, other]) => ({ type: "columns", columns: [[one], [other]] })),
  "no option": valid.choice.map((choice) => ({ ...choice, options: [] })),
  "over 12 options": fc.tuple(valid.choice, many(cell, 13)).map(([choice, options]) => ({ ...choice, options })),
  "no button": valid.buttons.map((buttons) => ({ ...buttons, buttons: [] })),
  "over 4 buttons": fc.tuple(valid.buttons, many(cell, 5)).map(([buttons, each]) => ({ ...buttons, buttons: each })),
  "a page under 80": valid.page.chain((page) => fc.constantFrom(79, 0, -1).map((height) => ({ ...page, height }))),
  "a page over 2000": valid.page.chain((page) => fc.constantFrom(2001, 5000).map((height) => ({ ...page, height }))),
  "a page height not whole": valid.page.map((page) => ({ ...page, height: 80.5 })),
  "a site that isn't an id": valid.page.map((page) => ({ ...page, site: "https://example.com" })),
  "a routine id over 64": span(65, 68).map((routine) => ({ type: "routine", routine }))
} satisfies Record<string, fc.Arbitrary<Block>>;

const broken = fc.oneof(...Object.values(breaks));

const top = record({ id: word, title: word, subtitle: word, icon: word, note: word, wait: fc.boolean(), seen: word }, []);

const extra = (arbitrary: fc.Arbitrary<Block>) => fc.tuple(arbitrary, fc.option(word)).map(([each, seen]) => (seen === null ? each : { ...each, seen }));

const card = fc.tuple(top, fc.array(block, { minLength: 1, maxLength: 12 })).map(([head, blocks]): Card => ({ ...head, blocks }));

const written = fc.record(
  {
    call: span(0, 200),
    values: fc.array(fc.array(fc.oneof({ weight: 9, arbitrary: word }, { weight: 1, arbitrary: span(3999, 4000) }), { maxLength: 12 }), { maxLength: 12 }),
    button: fc.oneof({ weight: 9, arbitrary: word }, { weight: 1, arbitrary: span(3999, 4000) })
  },
  { requiredKeys: ["call", "values"] }
);

const answer = written.map(clean);

const damaged: fc.Arbitrary<JsonValue> = fc.oneof(
  written.chain((each) => span(201, 202).map((call) => clean({ ...each, call }))),
  written.map((each) => clean({ ...each, values: [...each.values, ...Array.from({ length: 13 - each.values.length }, () => [])] })),
  written.map((each) => clean({ ...each, values: [Array.from({ length: 13 }, () => "a")] })),
  written.chain((each) => span(4001, 4002).map((long) => clean({ ...each, values: [[long]] }))),
  written.chain((each) => span(4001, 4002).map((button) => clean({ ...each, button }))),
  written.map((each) => clean({ ...each, call: undefined })),
  fc.constantFrom<JsonValue>(null, "a", 1, [], { call: 1, values: [] }, { call: "c", values: [[1]] })
);

const ASKS = new Set<JsonValue>(["choice", "input", "buttons"]);

const asks = (blocks: readonly Block[]) => blocks.some((each) => ASKS.has(each.type ?? null));

const said = (text: string, isError = false): ToolExecutionResult => ({ output: [{ type: "text", text }], isError });

const settings = () => ({ numRuns: budget().numRuns, seed: budget().seed });

describe("a card the page draws", () => {
  it("shows each block that keeps every rule, as the model wrote it, and skips each that breaks one", () => {
    const mixed = fc.array(fc.oneof(extra(block).map((each) => ({ each, keeps: true })), broken.map((each) => ({ each, keeps: false }))), { minLength: 1, maxLength: 12 });

    fc.assert(
      fc.property(top, mixed, (head, blocks) => {
        const kept = blocks.filter((each) => each.keeps).map((each) => each.each);

        expect(cardOf(JSON.stringify({ ...head, blocks: blocks.map((each) => each.each) }))).toEqual(kept.length > 0 ? { ...head, blocks: kept } : null);
      }),
      settings()
    );
  });

  it("draws nothing from arguments that are not yet a card: unread JSON, another value, a field of the wrong kind, no blocks or none that keep", () => {
    const unread = fc.oneof(
      fc.string(),
      fc.tuple(card, fc.nat()).map(([each, cut]) => {
        const whole = JSON.stringify(each);

        return whole.slice(0, cut % whole.length);
      }),
      fc.constantFrom<JsonValue>(null, 1, "card", [], {}, { blocks: "none" }, { blocks: {} }).map((value) => JSON.stringify(value)),
      fc.tuple(card, fc.constantFrom("id", "title", "subtitle", "icon", "note", "wait"), fc.constantFrom<JsonValue>(1, null, [], {})).map(([each, key, value]) => JSON.stringify({ ...each, [key]: value })),
      fc.tuple(top, fc.array(broken, { maxLength: 6 })).map(([head, blocks]) => JSON.stringify({ ...head, blocks }))
    );

    fc.assert(
      fc.property(unread, (input) => {
        expect(cardOf(input)).toBeNull();
      }),
      settings()
    );
  });
});

describe("a card's answer kept beside its message", () => {
  it("reads back as written while it keeps its limits, and as none once damaged", () => {
    fc.assert(
      fc.property(answer, damaged, (good, bad) => {
        expect(answerOf(good)).toEqual(good);
        expect(answerOf(bad)).toBeNull();
      }),
      settings()
    );
  });
});

describe("the ui tool in a chat", () => {
  it("shows a card, ends the turn on one that waits only when it asks something, and refuses a wait with nothing to answer", async () => {
    await fc.assert(
      fc.asyncProperty(card, async (each) => {
        const result = await world().call("main", "c", each);
        const asked = asks(each.blocks);

        if (each.wait !== true) expect(result).toEqual(said(asked ? "Shown to the user; their answer, if any, arrives as a later message." : "Shown to the user."));
        else if (asked) expect(result).toEqual({ ...said("Shown to the user. Your turn ends here; their answer arrives as their next message."), control: { terminate: true } });
        else expect(result).toEqual(said("Not waiting: the card has nothing to answer. Add a choice, input or buttons, or leave out wait.", true));
      }),
      settings()
    );
  });
});

describe("the ui tool outside a chat", () => {
  it("is refused where there is no one to show and no run to keep it, and keeps nothing", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(card, { minLength: 1, maxLength: 4 }), async (cards) => {
        const side = world();

        for (const [index, each] of cards.entries()) {
          expect(await side.call("aside", `c${index}`, each)).toEqual(said("Not shown: only a chat with the user has someone to show.", true));
        }

        expect(side.docs().aside?.cards ?? []).toEqual([]);
      }),
      settings()
    );
  });

  it("keeps a run's card once per call, in call order, without wait, however often the call is replayed", async () => {
    const calls = fc.array(fc.tuple(fc.constantFrom("c1", "c2", "c3", "c4"), card), { minLength: 1, maxLength: 12 });

    await fc.assert(
      fc.asyncProperty(calls, async (each) => {
        const side = world();
        const first = new Map<string, Card>();

        for (const [call, shown] of each) {
          if (!first.has(call)) first.set(call, shown);
          const answers = asks(shown.blocks) ? " The user answers it in that chat, later, not to this run." : "";
          const waits = shown.wait === true ? " wait does nothing in a run: your turn goes on; finish with your report." : "";

          expect(await side.call("run", call, shown)).toEqual(said(`Kept: the card is posted to the user before your report once this run succeeds.${answers}${waits}`));
        }

        const kept = [...first].map(([call, shown]) => {
          const { wait: _, ...rest } = shown;

          return { call, card: JSON.stringify(rest) };
        });

        expect(side.docs().run?.cards).toEqual(kept);
      }),
      settings()
    );
  });
});
