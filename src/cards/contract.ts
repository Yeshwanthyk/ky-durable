import type { JsonValue } from "@earendil-works/chord";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import Type, { type Static } from "typebox";
import type { Refusable } from "../core/edge";

export const CARD_ANSWER = "ky.card-answer";

const Many = <S extends Schema.Top>(item: S, min: number, max: number) => Schema.Array(item).check(Schema.isMinLength(min), Schema.isMaxLength(max));

const Words = Schema.optionalKey(Schema.String);

const Flag = Schema.optionalKey(Schema.Boolean);

const Tone = Schema.optionalKey(Schema.Literals(["info", "success", "warning", "error"]));

const Media = <K extends string>(type: K) =>
  Schema.Struct({ type: Schema.Literal(type), src: Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{32}|https:\/\/[^\s]+)$/)), caption: Words });

const Text = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const List = Schema.Struct({
  type: Schema.Literal("list"),
  label: Words,
  items: Many(Schema.Struct({ title: Schema.String, detail: Words, meta: Words }), 0, 30)
});

const Facts = Schema.Struct({ type: Schema.Literal("facts"), rows: Many(Schema.Struct({ label: Schema.String, value: Schema.String }), 0, 20) });

const Status = Schema.Struct({ type: Schema.Literal("status"), text: Schema.String, tone: Tone });

const Stats = Schema.Struct({
  type: Schema.Literal("stats"),
  items: Many(
    Schema.Struct({
      value: Schema.Union([Schema.String, Schema.Number]),
      label: Schema.String,
      tone: Tone,
      series: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })))
    }),
    1,
    6
  )
});

const Chart = Schema.Struct({
  type: Schema.Literal("chart"),
  kind: Schema.Literals(["bar", "line", "donut"]),
  label: Words,
  x: Many(Schema.String, 1, 60),
  series: Many(Schema.Struct({ name: Schema.String, values: Many(Schema.Number, 0, 60) }), 1, 6),
  stacked: Flag,
  unit: Words
});

const Table = Schema.Struct({ type: Schema.Literal("table"), label: Words, columns: Many(Schema.String, 1, 8), rows: Many(Many(Schema.String, 0, 8), 0, 50) });

const Shown = Schema.Union([Text, List, Facts, Media("image"), Media("audio"), Media("video"), Status, Stats, Chart, Table]);

const Tabs = Schema.Struct({ type: Schema.Literal("tabs"), tabs: Many(Schema.Struct({ label: Schema.String, blocks: Many(Shown, 1, 8) }), 2, 6) });

const Columns = Schema.Struct({ type: Schema.Literal("columns"), columns: Many(Many(Schema.Union([Shown, Tabs]), 1, 8), 2, 3) });

const Choice = Schema.Struct({
  type: Schema.Literal("choice"),
  label: Schema.String,
  options: Many(Schema.Struct({ label: Schema.String, detail: Words }), 1, 12),
  multiple: Flag,
  hint: Words
});

const Input = Schema.Struct({ type: Schema.Literal("input"), label: Schema.String, placeholder: Words, multiline: Flag });

const Buttons = Schema.Struct({
  type: Schema.Literal("buttons"),
  buttons: Many(Schema.Struct({ label: Schema.String, reply: Words, url: Words, tone: Schema.optionalKey(Schema.Literals(["primary", "default", "danger"])) }), 1, 4)
});

const Page = Schema.Struct({
  type: Schema.Literal("page"),
  site: Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)),
  title: Words,
  height: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 80, maximum: 2000 })))
});

const Routine = Schema.Struct({ type: Schema.Literal("routine"), routine: Schema.String.check(Schema.isMaxCodePoints(64)) });

const UiBlock = Schema.Union([Text, Choice, Input, Buttons, List, Facts, Media("image"), Media("audio"), Media("video"), Page, Status, Routine, Stats, Chart, Table, Tabs, Columns]);

const Card = <S extends Schema.Top>(block: S) =>
  Schema.Struct({ id: Words, title: Words, subtitle: Words, icon: Words, note: Words, wait: Flag, blocks: Schema.Array(block) });

const UiCard = Card(UiBlock);

const Json = Schema.fromJsonString(Schema.Unknown);

const isDrawn = Schema.is(Card(Schema.Unknown));

export type UiBlock = typeof UiBlock.Type;

export type UiCard = typeof UiCard.Type;

export type ShownBlock = typeof Shown.Type;

export type TabsBlock = typeof Tabs.Type;

const isBlock = Schema.is(UiBlock);

export function cardOf(input: string): UiCard | null {
  const drawn = Option.getOrNull(Option.filter(Schema.decodeUnknownOption(Json)(input), isDrawn));

  if (drawn === null) return null;
  const blocks = drawn.blocks.filter(isBlock);

  return blocks.length > 0 ? { ...drawn, blocks } : null;
}

const CardAnswer = Schema.Struct({
  call: Schema.String.check(Schema.isMaxCodePoints(200)),
  values: Many(Many(Schema.String.check(Schema.isMaxCodePoints(4000)), 0, 12), 0, 12),
  button: Schema.optionalKey(Schema.String.check(Schema.isMaxCodePoints(4000)))
});

export type CardAnswer = typeof CardAnswer.Type;

const isAnswer = Schema.is(CardAnswer);

export const answerOf = (data: JsonValue | undefined): CardAnswer | null => (isAnswer(data) ? data : null);

export const CardAnswerSchema = Type.Object({
  call: Type.String({ maxLength: 200 }),
  values: Type.Array(Type.Array(Type.String({ maxLength: 4000 }), { maxItems: 12 }), { maxItems: 12 }),
  button: Type.Optional(Type.String({ maxLength: 4000 }))
});

const MEDIA = "^(?:[0-9a-f]{32}|https://[^\\s]+)$";

const ToneInput = Type.Union([Type.Literal("info"), Type.Literal("success"), Type.Literal("warning"), Type.Literal("error")]);

const LabelInput = Type.Optional(Type.String({ description: "A few words over the block." }));

const TextInput = Type.Object({ type: Type.Literal("text"), text: Type.String({ description: "Markdown." }) });

const ListInput = Type.Object({
  type: Type.Literal("list"),
  label: LabelInput,
  items: Type.Array(Type.Object({ title: Type.String(), detail: Type.Optional(Type.String()), meta: Type.Optional(Type.String()) }), { maxItems: 30 })
});

const FactsInput = Type.Object({ type: Type.Literal("facts"), rows: Type.Array(Type.Object({ label: Type.String(), value: Type.String() }), { maxItems: 20 }) });

const ImageInput = Type.Object({
  type: Type.Literal("image"),
  src: Type.String({ pattern: MEDIA, description: "A file id ky saved, such as a browse screenshot's, or an https image URL." }),
  caption: Type.Optional(Type.String({ description: "A line under the image." }))
});

const Source = (what: string) =>
  Type.String({
    pattern: MEDIA,
    description: `A file id ky saved, such as one a task shared or a clip the user sent (the file in its <ky-media> tag), or an https ${what} URL.`
  });

const AudioInput = Type.Object({ type: Type.Literal("audio"), src: Source("audio"), caption: Type.Optional(Type.String({ description: "A line under the player." })) });

const VideoInput = Type.Object({ type: Type.Literal("video"), src: Source("video"), caption: Type.Optional(Type.String({ description: "A line under the video." })) });

const StatusInput = Type.Object({ type: Type.Literal("status"), text: Type.String(), tone: Type.Optional(ToneInput) });

const StatsInput = Type.Object({
  type: Type.Literal("stats"),
  items: Type.Array(
    Type.Object({
      value: Type.Union([Type.String(), Type.Number()], { description: "The number, or as it should read, such as \"$1.2k\" or \"98%\"." }),
      label: Type.String({ description: "What it counts, a word or two." }),
      tone: Type.Optional(ToneInput),
      series: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, description: "The chart series this number is, so it wears that series' color." }))
    }),
    { minItems: 1, maxItems: 6 }
  )
});

const ChartInput = Type.Object({
  type: Type.Literal("chart"),
  kind: Type.Union([Type.Literal("bar"), Type.Literal("line"), Type.Literal("donut")], {
    description: "bar: a row per x, for categories or a few days; line: a trend over many x; donut: shares of one series."
  }),
  label: LabelInput,
  x: Type.Array(Type.String(), { minItems: 1, maxItems: 60, description: "The category or time labels, in order." }),
  series: Type.Array(Type.Object({ name: Type.String(), values: Type.Array(Type.Number(), { maxItems: 60, description: "One value per x." }) }), { minItems: 1, maxItems: 6 }),
  stacked: Type.Optional(Type.Boolean({ description: "A bar chart's series stack in one bar." })),
  unit: Type.Optional(Type.String({ description: "Written after each value, such as \"%\" or \" PRs\"." }))
});

const TableInput = Type.Object({
  type: Type.Literal("table"),
  label: LabelInput,
  columns: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }),
  rows: Type.Array(Type.Array(Type.String(), { maxItems: 8 }), { maxItems: 50, description: "One cell per column; numbers right-align." })
});

const ShownInput = Type.Union([TextInput, ListInput, FactsInput, ImageInput, AudioInput, VideoInput, StatusInput, StatsInput, ChartInput, TableInput]);

const TabsInput = Type.Object({
  type: Type.Literal("tabs"),
  tabs: Type.Array(Type.Object({ label: Type.String(), blocks: Type.Array(ShownInput, { minItems: 1, maxItems: 8 }) }), { minItems: 2, maxItems: 6 })
});

const ColumnsInput = Type.Object({
  type: Type.Literal("columns"),
  columns: Type.Array(Type.Array(Type.Union([ShownInput, TabsInput]), { minItems: 1, maxItems: 8 }), {
    minItems: 2,
    maxItems: 3,
    description: "Side by side while the card is wide enough, one under another on a phone."
  })
});

const UiBlockInput = Type.Union([
  TextInput,
  Type.Object({
    type: Type.Literal("choice"),
    label: Type.String({ description: "The question, one short sentence." }),
    options: Type.Array(
      Type.Object({
        label: Type.String({ description: "A few words." }),
        detail: Type.Optional(Type.String({ description: "A short second line, such as a sender or a price." }))
      }),
      { minItems: 1, maxItems: 12 }
    ),
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
  ListInput,
  FactsInput,
  ImageInput,
  AudioInput,
  VideoInput,
  Type.Object({
    type: Type.Literal("page"),
    site: Type.String({ pattern: "^[0-9a-f]{32}$", description: "The id of a site the site tool published: its page shows in the card, sized to fit." }),
    title: Type.Optional(Type.String({ description: "What the page is, for its frame and its open link." })),
    height: Type.Optional(Type.Integer({ minimum: 80, maximum: 2000, description: "Pixels to show before the page reports its own height. Defaults to 480." }))
  }),
  StatusInput,
  Type.Object({
    type: Type.Literal("routine"),
    routine: Type.String({
      maxLength: 64,
      description: "An automation's id, from the automation tool: the card shows it as it is now (its schedule, next and last run) with pause and run now, kept current."
    })
  }),
  StatsInput,
  ChartInput,
  TableInput,
  TabsInput,
  ColumnsInput
]);

export const UiCardInput = Type.Object({
  id: Type.Optional(
    Type.String({
      maxLength: 64,
      description: "Name a card you will update, such as trip-plan. A later card with the same id replaces it where it first showed, and the thread notes the update."
    })
  ),
  title: Type.Optional(Type.String({ description: "A heading for the card." })),
  subtitle: Type.Optional(Type.String({ description: "A quiet line beside the title, such as the dates or the source." })),
  icon: Type.Optional(Type.String({ description: "An app or topic the card is about, such as gmail, calendar, github, file; shown as its icon." })),
  blocks: Type.Array(UiBlockInput, { minItems: 1, maxItems: 12 }),
  note: Type.Optional(Type.String({ description: "A line of small print under the card, such as what connecting allows or how to undo it." })),
  wait: Type.Optional(Type.Boolean({ description: "End your turn here and wait for the user's answer. Use it when the card asks something." }))
});

export type UiCardArgs = Static<typeof UiCardInput>;

export class NothingToAnswer extends Schema.TaggedError<NothingToAnswer>()("NothingToAnswer", {}) implements Refusable {
  get refusal() {
    return "Not waiting: the card has nothing to answer. Add a choice, input or buttons, or leave out wait.";
  }
}

export class NoOneToShow extends Schema.TaggedError<NoOneToShow>()("NoOneToShow", {}) implements Refusable {
  get refusal() {
    return "Not shown: only a chat with the user has someone to show.";
  }
}
