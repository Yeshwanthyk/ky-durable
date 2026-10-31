import Type, { type Static } from "typebox";

export const SchemeSchema = Type.Union([Type.Literal("bearer"), Type.Literal("basic"), Type.Literal("header")]);

const HookSchema = Type.Object({
  id: Type.String(),
  session: Type.String(),
  label: Type.String(),
  signed: Type.Boolean(),
  createdAt: Type.Number(),
  lastAt: Type.Union([Type.Number(), Type.Null()])
});

export type Hook = Static<typeof HookSchema>;

const SecretAskSchema = Type.Object({
  session: Type.String(),
  name: Type.String(),
  origin: Type.String(),
  scheme: SchemeSchema,
  header: Type.Union([Type.String(), Type.Null()]),
  purpose: Type.String(),
  at: Type.Number(),
  /** Whose key it is to be: "ky", or the specialist that asked. */
  owner: Type.String(),
  /** The conversation that asked, when it isn't the chat the card shows in: a specialist's. */
  asker: Type.Union([Type.String(), Type.Null()])
});

export type SecretAsk = Static<typeof SecretAskSchema>;

export const HooksViewSchema = Type.Object({
  hooks: Type.Array(HookSchema),
  chats: Type.Array(Type.Object({ session: Type.String(), title: Type.String() }))
});

export type HooksView = Static<typeof HooksViewSchema>;

const SecretSchema = Type.Object({
  name: Type.String(),
  /** Whose it is: "ky", a specialist's id, or "*" for every owner's. */
  owner: Type.String(),
  origin: Type.String(),
  scheme: SchemeSchema,
  header: Type.Union([Type.String(), Type.Null()]),
  purpose: Type.String(),
  updatedAt: Type.Number()
});

export type Secret = Static<typeof SecretSchema>;

/** The keys, and every owner one can move to: ky, then each specialist. */
export const SecretsSchema = Type.Object({ secrets: Type.Array(SecretSchema), owners: Type.Array(Type.String()) });

export const AsksSchema = Type.Object({ asks: Type.Array(SecretAskSchema) });

export const MadeHookSchema = Type.Object({ hook: HookSchema, url: Type.String(), signing: Type.Union([Type.String(), Type.Null()]) });

export const RotatedSchema = Type.Object({ url: Type.String(), signing: Type.Union([Type.String(), Type.Null()]) });
