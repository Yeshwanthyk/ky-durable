import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Sql } from "../core/sql";
import { PROVIDER_TABLES, ProviderKind, type ProviderRecord } from "./contract";

const TABLE = PROVIDER_TABLES.providers;

const Row = Schema.Struct({
  id: Schema.String,
  kind: ProviderKind,
  vendor: Schema.NullOr(Schema.String),
  machine: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
  api: Schema.NullOr(Schema.String),
  label: Schema.String,
  enabled: Schema.Number
});

const rowOf = Schema.decodeUnknownOption(Row);

export class Records extends Context.Service<
  Records,
  {
    readonly list: Effect.Effect<ProviderRecord[]>;
    add(record: ProviderRecord): Effect.Effect<void>;
    remove(id: string): Effect.Effect<void>;
  }
>()("ky/providers/Records") {
  static readonly layer = Layer.effect(
    Records,
    Effect.gen(function* () {
      const sql = yield* Sql;

      yield* Effect.orDie(
        sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      vendor TEXT,
      machine TEXT,
      port INTEGER,
      api TEXT,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL)`)
      );

      return Records.of({
        list: Effect.map(Effect.orDie(sql.exec(`SELECT id, kind, vendor, machine, port, api, label, enabled FROM ${TABLE} ORDER BY rowid`)), (rows) =>
          rows.flatMap((row) => Option.match(rowOf(row), { onNone: () => [], onSome: ({ enabled, ...record }) => [{ ...record, enabled: enabled === 1 }] }))
        ),
        add: (record) =>
          Effect.asVoid(Effect.orDie(
            sql.exec(
              `INSERT INTO ${TABLE} (id, kind, vendor, machine, port, api, label, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, vendor = excluded.vendor, machine = excluded.machine,
         port = excluded.port, api = excluded.api`,
              record.id,
              record.kind,
              record.vendor,
              record.machine,
              record.port,
              record.api,
              record.label,
              record.enabled ? 1 : 0
            )
          )),
        remove: (id) => Effect.asVoid(Effect.orDie(sql.exec(`DELETE FROM ${TABLE} WHERE id = ?`, id)))
      });
    })
  );
}
