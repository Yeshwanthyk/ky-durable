/**
 * The blocks a card from ky's ui tool (src/ui-tool.ts) is made of, as schemas:
 * the tool's parameters, and what the page (src/ui/Blocks.tsx) checks a call's
 * arguments against. Only typebox, so the page can load it.
 */
import Type, { type Static } from "typebox";

const Option = Type.Object({
  label: Type.String({ description: "A few words." }),
  detail: Type.Optional(Type.String({ description: "A short second line, such as a sender or a price." }))
});

const Tone = Type.Union([Type.Literal("info"), Type.Literal("success"), Type.Literal("warning"), Type.Literal("error")]);

/** A label over a chart, table or list. */
const Label = Type.Optional(Type.String({ description: "A few words over the block." }));

const Text = Type.Object({ type: Type.Literal("text"), text: Type.String({ description: "Markdown." }) });

const List = Type.Object({
  type: Type.Literal("list"),
  label: Label,
  items: Type.Array(Type.Object({ title: Type.String(), detail: Type.Optional(Type.String()), meta: Type.Optional(Type.String()) }), { maxItems: 30 })
});

const Facts = Type.Object({ type: Type.Literal("facts"), rows: Type.Array(Type.Object({ label: Type.String(), value: Type.String() }), { maxItems: 20 }) });

const Image = Type.Object({
  type: Type.Literal("image"),
  src: Type.String({
    // A file ky saved (a browse screenshot's id) shows from ky's own /files; anything else must be https.
    pattern: "^(?:[0-9a-f]{32}|https://[^\\s]+)$",
    description: "A file id ky saved, such as a browse screenshot's, or an https image URL."
  }),
  caption: Type.Optional(Type.String({ description: "A line under the image." }))
});

const Status = Type.Object({ type: Type.Literal("status"), text: Type.String(), tone: Type.Optional(Tone) });

const Stats = Type.Object({
  type: Type.Literal("stats"),
  items: Type.Array(
    Type.Object({
      value: Type.Union([Type.String(), Type.Number()], { description: "The number, or as it should read, such as \"$1.2k\" or \"98%\"." }),
      label: Type.String({ description: "What it counts, a word or two." }),
      tone: Type.Optional(Tone),
      series: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, description: "The chart series this number is, so it wears that series' color." }))
    }),
    { minItems: 1, maxItems: 6 }
  )
});

const Chart = Type.Object({
  type: Type.Literal("chart"),
  kind: Type.Union([Type.Literal("bar"), Type.Literal("line"), Type.Literal("donut")], {
    description: "bar: a row per x, for categories or a few days; line: a trend over many x; donut: shares of one series."
  }),
  label: Label,
  x: Type.Array(Type.String(), { minItems: 1, maxItems: 60, description: "The category or time labels, in order." }),
  series: Type.Array(
    Type.Object({ name: Type.String(), values: Type.Array(Type.Number(), { maxItems: 60, description: "One value per x." }) }),
    { minItems: 1, maxItems: 6 }
  ),
  stacked: Type.Optional(Type.Boolean({ description: "A bar chart's series stack in one bar." })),
  unit: Type.Optional(Type.String({ description: "Written after each value, such as \"%\" or \" PRs\"." }))
});

const Table = Type.Object({
  type: Type.Literal("table"),
  label: Label,
  columns: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
  rows: Type.Array(Type.Array(Type.String(), { maxItems: 8 }), { maxItems: 50, description: "One cell per column; numbers right-align." })
});

/** What a tab or a column holds: blocks that show, none that ask. */
const Shown = Type.Union([Text, List, Facts, Image, Status, Stats, Chart, Table]);

const Tabs = Type.Object({
  type: Type.Literal("tabs"),
  tabs: Type.Array(Type.Object({ label: Type.String(), blocks: Type.Array(Shown, { minItems: 1, maxItems: 8 }) }), { minItems: 2, maxItems: 6 })
});

const Columns = Type.Object({
  type: Type.Literal("columns"),
  columns: Type.Array(Type.Array(Type.Union([Shown, Tabs]), { minItems: 1, maxItems: 8 }), {
    minItems: 2,
    maxItems: 3,
    description: "Side by side while the card is wide enough, one under another on a phone."
  })
});

export const UiBlockSchema = Type.Union([
  Text,
  Type.Object({
    type: Type.Literal("choice"),
    label: Type.String({ description: "The question, one short sentence." }),
    options: Type.Array(Option, { minItems: 1, maxItems: 12 }), // card-answers.ts letters A to L
    multiple: Type.Optional(Type.Boolean({ description: "The user may choose several." })),
    hint: Type.Optional(Type.String({ description: "A line under the question, such as \"Choose all that apply\"." }))
  }),
  Type.Object({
    type: Type.Literal("input"),
    label: Type.String({ description: "What to type, as a question or a field name." }),
    placeholder: Type.Optional(Type.String()),
    multiline: Type.Optional(Type.Boolean())
  }),
  Type.Object({
    type: Type.Literal("buttons"),
    buttons: Type.Array(
      Type.Object({
        label: Type.String(),
        reply: Type.Optional(Type.String({ description: "Sent as the user's message when tapped. Defaults to the label." })),
        url: Type.Optional(Type.String({ description: "Opened in a new tab instead of replying, such as an authorize link." })),
        tone: Type.Optional(Type.Union([Type.Literal("primary"), Type.Literal("default"), Type.Literal("danger")]))
      }),
      { minItems: 1, maxItems: 4 }
    )
  }),
  List,
  Facts,
  Image,
  Type.Object({
    type: Type.Literal("page"),
    site: Type.String({ pattern: "^[0-9a-f]{32}$", description: "The id of a site the site tool published: its page shows in the card, sized to fit." }),
    title: Type.Optional(Type.String({ description: "What the page is, for its frame and its open link." })),
    height: Type.Optional(Type.Integer({ minimum: 80, maximum: 2000, description: "Pixels to show before the page reports its own height. Defaults to 480." }))
  }),
  Status,
  Stats,
  Chart,
  Table,
  Tabs,
  Columns
]);

export const UiCardSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "A heading for the card." })),
  subtitle: Type.Optional(Type.String({ description: "A quiet line beside the title, such as the dates or the source." })),
  icon: Type.Optional(Type.String({ description: "An app or topic the card is about, such as gmail, calendar, github, file; shown as its icon." })),
  blocks: Type.Array(UiBlockSchema, { minItems: 1, maxItems: 12 }),
  note: Type.Optional(Type.String({ description: "A line of small print under the card, such as what connecting allows or how to undo it." })),
  wait: Type.Optional(Type.Boolean({ description: "End your turn here and wait for the user's answer. Use it when the card asks something." }))
});

export type UiCard = Static<typeof UiCardSchema>;

export type UiBlock = Static<typeof UiBlockSchema>;

/** A block a tab or a column holds. */
export type ShownBlock = Static<typeof Shown>;

export type TabsBlock = Static<typeof Tabs>;

/**
 * A card as the page reads it back from a call: its blocks unchecked, so each
 * is checked on its own and one a newer ky added is skipped, not the card.
 */
export const UiCardShown = Type.Object({
  title: Type.Optional(Type.String()),
  subtitle: Type.Optional(Type.String()),
  icon: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
  wait: Type.Optional(Type.Boolean()),
  blocks: Type.Array(Type.Unknown())
});
