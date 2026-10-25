import Type, { type Static } from "typebox";

/**
 * What the page reads of inbound (src/ui/Inbound.tsx, src/ui/InboundCards.tsx), apart from the Worker code it
 * describes: schemas the page decodes the routes' answers with, and the agent its rows.
 */

const SchemeSchema = Type.Union([Type.Literal("bearer"), Type.Literal("basic"), Type.Literal("header")]);

const HookSchema = Type.Object({
  id: Type.String(),
  session: Type.String(),
  label: Type.String(),
  /** Whether posts must carry GitHub's X-Hub-Signature-256 of their body. */
  signed: Type.Boolean(),
  createdAt: Type.Number(),
  lastAt: Type.Union([Type.Number(), Type.Null()])
});

export type Hook = Static<typeof HookSchema>;

/** A credential ky asked the user for in a chat, until they save it. */
export const SecretAskSchema = Type.Object({
  session: Type.String(),
  name: Type.String(),
  origin: Type.String(),
  scheme: SchemeSchema,
  header: Type.Union([Type.String(), Type.Null()]),
  purpose: Type.String(),
  at: Type.Number()
});

export type SecretAsk = Static<typeof SecretAskSchema>;

/** Settings › Webhooks: the hooks, and the chats a hook can post to. */
export const HooksViewSchema = Type.Object({
  hooks: Type.Array(HookSchema),
  chats: Type.Array(Type.Object({ session: Type.String(), title: Type.String() }))
});

export type HooksView = Static<typeof HooksViewSchema>;

/** A kept credential, as the page lists it: never its value. */
const SecretSchema = Type.Object({
  name: Type.String(),
  origin: Type.String(),
  scheme: Type.String(),
  header: Type.Union([Type.String(), Type.Null()]),
  purpose: Type.String(),
  updatedAt: Type.Number()
});

export type Secret = Static<typeof SecretSchema>;

export const SecretsSchema = Type.Object({ secrets: Type.Array(SecretSchema) });

export const AsksSchema = Type.Object({ asks: Type.Array(SecretAskSchema) });

/** A hook as it is made: its URL, and its signing secret when signed, shown this once. */
export const MadeHookSchema = Type.Object({ hook: HookSchema, url: Type.String(), signing: Type.Union([Type.String(), Type.Null()]) });

export const RotatedSchema = Type.Object({ url: Type.String() });
