import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Sql } from "../core/sql";
import { type ModelChoice, ModelChoice as Choice, NotAvailable, type Purpose, SETTINGS_TABLES } from "./contract";

const TABLE = SETTINGS_TABLES.purposes;

const Stored = Schema.fromJsonString(Choice);

const PurposeRow = Schema.Struct({ value: Stored });

export type Valid = (choice: ModelChoice) => ModelChoice | undefined;

export class Purposes extends Context.Service<
  Purposes,
  {
    get(purpose: Purpose): Effect.Effect<ModelChoice | undefined>;
    set(purpose: Purpose, choice: ModelChoice): Effect.Effect<ModelChoice, NotAvailable>;
  }
>()("ky/settings/Purposes") {
  static readonly layer = (validOf: Valid) =>
    Layer.effect(
      Purposes,
      Effect.gen(function* () {
        const sql = yield* Sql;

        yield* Effect.orDie(
          sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      purpose TEXT PRIMARY KEY, value TEXT NOT NULL)`)
        );

        return Purposes.of({
          get: (purpose) =>
            Effect.map(Effect.orDie(sql.exec(`SELECT value FROM ${TABLE} WHERE purpose = ?`, purpose)), ([row]) =>
              Option.getOrUndefined(Option.flatMapNullishOr(Schema.decodeUnknownOption(PurposeRow)(row), (stored) => validOf(stored.value)))
            ),
          set: Effect.fnUntraced(function* (purpose, choice) {
            const valid = validOf(choice);

            if (!valid) return yield* new NotAvailable({ provider: choice.provider, modelId: choice.modelId });
            const value = yield* Effect.orDie(Schema.encodeEffect(Stored)(valid));
            yield* Effect.orDie(sql.exec(`INSERT INTO ${TABLE} (purpose, value) VALUES (?, ?) ON CONFLICT(purpose) DO UPDATE SET value = excluded.value`, purpose, value));

            return { provider: valid.provider, modelId: valid.modelId, thinkingLevel: valid.thinkingLevel };
          })
        });
      })
    );
}
