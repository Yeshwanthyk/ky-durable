import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import Type, { type Static } from "typebox";
import { Sql } from "../core/sql";
import {
  AVATAR_TABLES,
  type AvatarsView,
  BLOUBS_FENCE,
  BloubSpec,
  BloubSpecSchema,
  fitSpec,
  KY_AVATAR,
  NoOwner,
  NotASpec,
  rollSpec,
  SpecMissing
} from "./contract";

const TABLE = AVATAR_TABLES.avatars;

const AvatarRow = Schema.Struct({ owner: Schema.String, spec: Schema.String });

const rowOf = Schema.decodeUnknownOption(AvatarRow);

const jsonOf = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const isSpec = Schema.is(BloubSpec);

export class Wardrobe extends Context.Service<
  Wardrobe,
  {
    readonly all: Effect.Effect<AvatarsView>;
    set(owner: string, spec: BloubSpec): Effect.Effect<void>;
    clear(owner: string): Effect.Effect<boolean>;
  }
>()("ky/avatars/Wardrobe") {
  static readonly layer = (listeners: ReadonlySet<() => void>) =>
    Layer.effect(
      Wardrobe,
      Effect.gen(function* () {
        const sql = yield* Sql;
        const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));

        const changed = Effect.sync(() => {
          for (const listener of listeners) listener();
        });

        yield* exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (owner TEXT PRIMARY KEY, spec TEXT NOT NULL)`);

        return Wardrobe.of({
          all: Effect.map(exec(`SELECT owner, spec FROM ${TABLE} ORDER BY owner`), (rows) => {
            const avatars: Record<string, BloubSpec> = {};

            for (const row of rows.flatMap((raw) => Option.toArray(rowOf(raw)))) {
              const spec = Option.getOrUndefined(jsonOf(row.spec));

              if (isSpec(spec)) avatars[row.owner] = spec;
            }

            return avatars;
          }),
          set: (owner, spec) =>
            Effect.andThen(
              exec(`INSERT INTO ${TABLE} (owner, spec) VALUES (?, ?) ON CONFLICT(owner) DO UPDATE SET spec = excluded.spec`, owner, JSON.stringify(spec)),
              changed
            ),
          clear: Effect.fnUntraced(function* (owner) {
            const had = (yield* exec(`DELETE FROM ${TABLE} WHERE owner = ? RETURNING owner`, owner)).length > 0;

            if (had) yield* changed;

            return had;
          })
        });
      })
    );
}

export const AvatarInput = Type.Object({
  action: Type.Union([Type.Literal("preview"), Type.Literal("roll"), Type.Literal("set"), Type.Literal("clear"), Type.Literal("list")]),
  for: Type.Optional(Type.String({ description: `set, clear: "${KY_AVATAR}" or a specialist's id. Defaults to ${KY_AVATAR}.` })),
  spec: Type.Optional({ ...BloubSpecSchema, description: "set: the bloub to save." }),
  specs: Type.Optional(Type.Array(BloubSpecSchema, { maxItems: 6, description: "preview: up to six bloubs to show side by side." })),
  count: Type.Optional(Type.Number({ description: "roll: how many random bloubs to offer, 1 to 6; 3 by default." }))
});

export type AvatarInput = Static<typeof AvatarInput>;

export type Reply = { readonly text: string };

const shown = (lead: string, specs: readonly BloubSpec[]): Reply => ({ text: `${lead}\n\n\`\`\`${BLOUBS_FENCE}\n${JSON.stringify(specs)}\n\`\`\`` });

const fitted = (value: BloubSpec, option?: number) =>
  Option.match(fitSpec(value), {
    onNone: () => Effect.fail(new NotASpec(option === undefined ? {} : { option })),
    onSome: Effect.succeed
  });

type Action = (input: AvatarInput, owners: () => readonly string[]) => Effect.Effect<Reply, NotASpec | SpecMissing | NoOwner, Wardrobe>;

const ACTIONS = {
  preview: ({ specs, spec }) =>
    Effect.gen(function* () {
      const checked = yield* Effect.forEach(specs ?? (spec ? [spec] : []), (each, index) => fitted(each, index + 1));

      if (checked.length === 0) return yield* new SpecMissing({ action: "preview" });

      return shown(`Showing ${checked.length}. Ask which one, or what to change; then set it.`, checked);
    }),
  roll: ({ count }) =>
    Effect.sync(() => {
      const many = Math.min(6, Math.max(1, Math.round(count ?? 3)));

      return shown(
        `Rolled ${many}. Ask which one, or what to change; then set it.`,
        Array.from({ length: many }, () => rollSpec(crypto.randomUUID()))
      );
    }),
  set: (input, owners) =>
    Effect.gen(function* () {
      const owner = input.for ?? KY_AVATAR;

      if (!owners().includes(owner)) return yield* new NoOwner({ owner });

      if (!input.spec) return yield* new SpecMissing({ action: "set" });
      const spec = yield* fitted(input.spec);
      yield* Wardrobe.use((wardrobe) => wardrobe.set(owner, spec));

      return shown(`Saved as ${owner === KY_AVATAR ? "ky's" : `@${owner}'s`} avatar.`, [spec]);
    }),
  clear: (input) => {
    const owner = input.for ?? KY_AVATAR;

    return Wardrobe.use((wardrobe) =>
      Effect.map(wardrobe.clear(owner), (had) => ({ text: had ? `${owner} looks as before again.` : `${owner} has no avatar saved.` }))
    );
  },
  list: () =>
    Wardrobe.use((wardrobe) =>
      Effect.map(wardrobe.all, (all) => {
        const saved = Object.entries(all);

        return saved.length === 0 ? { text: "No avatars saved." } : shown(`Saved: ${saved.map(([owner]) => owner).join(", ")}.`, saved.map(([, spec]) => spec));
      })
    )
} satisfies { readonly [Name in AvatarInput["action"]]: Action };

export const act = (input: AvatarInput, owners: () => readonly string[]) => ACTIONS[input.action](input, owners);
