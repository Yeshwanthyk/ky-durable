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

export const UiBlockSchema = Type.Union([
  Type.Object({ type: Type.Literal("text"), text: Type.String({ description: "Markdown." }) }),
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
  Type.Object({ type: Type.Literal("list"), items: Type.Array(Type.Object({ title: Type.String(), detail: Type.Optional(Type.String()), meta: Type.Optional(Type.String()) }), { maxItems: 30 }) }),
  Type.Object({ type: Type.Literal("facts"), rows: Type.Array(Type.Object({ label: Type.String(), value: Type.String() }), { maxItems: 20 }) }),
  Type.Object({
    type: Type.Literal("image"),
    src: Type.String({
      // A file ky saved (a browse screenshot's id) shows from ky's own /files; anything else must be https.
      pattern: "^(?:[0-9a-f]{32}|https://[^\\s]+)$",
      description: "A file id ky saved, such as a browse screenshot's, or an https image URL."
    }),
    caption: Type.Optional(Type.String({ description: "A line under the image." }))
  }),
  Type.Object({
    type: Type.Literal("status"),
    text: Type.String(),
    tone: Type.Optional(Type.Union([Type.Literal("info"), Type.Literal("success"), Type.Literal("warning"), Type.Literal("error")]))
  })
]);

export const UiCardSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "A heading for the card." })),
  icon: Type.Optional(Type.String({ description: "An app or topic the card is about, such as gmail, calendar, github, file; shown as its icon." })),
  blocks: Type.Array(UiBlockSchema, { minItems: 1, maxItems: 12 }),
  note: Type.Optional(Type.String({ description: "A line of small print under the card, such as what connecting allows or how to undo it." })),
  wait: Type.Optional(Type.Boolean({ description: "End your turn here and wait for the user's answer. Use it when the card asks something." }))
});

export type UiCard = Static<typeof UiCardSchema>;

export type UiBlock = Static<typeof UiBlockSchema>;

/**
 * A card as the page reads it back from a call: its blocks unchecked, so each
 * is checked on its own and one a newer ky added is skipped, not the card.
 */
export const UiCardShown = Type.Object({
  title: Type.Optional(Type.String()),
  icon: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
  wait: Type.Optional(Type.Boolean()),
  blocks: Type.Array(Type.Unknown())
});
