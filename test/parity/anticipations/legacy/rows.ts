import * as Schema from "effect/Schema";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { StoredRow } from "../../skills/storage";

export type Value = string | number | null;

export type Row = Readonly<Record<string, Value>> | undefined;

type Cursor = Iterable<Readonly<Record<string, Value>>> & { readonly toArray: () => Readonly<Record<string, Value>>[]; readonly one: () => Row };

export type LegacySql = { readonly exec: (query: string, ...bindings: Value[]) => Cursor };

const plain = Schema.decodeUnknownSync(StoredRow);

export const sqlOf = (db: DatabaseSync): LegacySql => ({
  exec: (query: string, ...bindings: SQLInputValue[]) => {
    const rows = db
      .prepare(query)
      .all(...bindings)
      .map((row) => plain(row));

    return { [Symbol.iterator]: () => rows[Symbol.iterator](), toArray: () => rows, one: () => rows[0] };
  }
});
