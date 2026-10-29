import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Memory } from "../../../src/dreaming/memory";
import { transactionOf } from "../history/world";

type Storage = ConstructorParameters<typeof Memory>[0];

function sqlOf(db: DatabaseSync) {
  return {
    exec: (query: string, ...bindings: SQLInputValue[]) => {
      const rows = db
        .prepare(query)
        .all(...bindings)
        .map((row) => ({ ...row }));

      const cursor = rows.values();

      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);

          return rows[0];
        },
        [Symbol.iterator]: (): IterableIterator<(typeof rows)[number]> => cursor
      };
    }
  };
}

/** A Durable Object's storage over node's SQLite, damaged rows and all, as memory and recall read it. */
// SAFETY: memory, recall and history's reads call sql.exec (toArray, one, its rows) and transactionSync; nothing else of the storage.
export const storageOf = (db: DatabaseSync): Storage => ({ sql: { ...sqlOf(db), databaseSize: 0 }, transactionSync: transactionOf(db) }) as Storage;
