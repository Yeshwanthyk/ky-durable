import * as Schema from "effect/Schema";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { decodeOr } from "../../../../src/core/decode";
import { DreamLedgerRow } from "../../../../src/dreaming/contract";
import { StoredRow } from "../../skills/storage";

export type Value = string | number | null;

export type Row = Readonly<Record<string, Value>> | undefined;

type Cursor = { readonly toArray: () => Readonly<Record<string, Value>>[]; readonly one: () => Row };

export type LegacySql = { readonly exec: (query: string, ...bindings: Value[]) => Cursor };

const plain = Schema.decodeUnknownSync(StoredRow);

export const sqlOf = (db: DatabaseSync): LegacySql => ({
  exec: (query: string, ...bindings: SQLInputValue[]) => {
    const rows = db
      .prepare(query)
      .all(...bindings)
      .map((row) => plain(row));

    return { toArray: () => rows, one: () => rows[0] };
  }
});

export const ledgerRow = (row: Row): DreamLedgerRow | undefined => decodeOr(DreamLedgerRow, row, undefined);
