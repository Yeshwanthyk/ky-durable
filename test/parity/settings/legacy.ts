import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Settings } from "../../../src/settings/legacy/settings";

type SqlStorageOf = ConstructorParameters<typeof Settings>[0];

function sqlOf(db: DatabaseSync): SqlStorageOf {
  const exec = (query: string, ...bindings: SQLInputValue[]) => {
    const rows = db
      .prepare(query)
      .all(...bindings)
      .map((row) => ({ ...row }));

    return { toArray: () => rows, one: () => rows[0] };
  };

  // SAFETY: B's Settings calls sql.exec and reads toArray; nothing else of SqlStorage.
  return { exec, databaseSize: 0 } as SqlStorageOf;
}

export function legacyOf(db: DatabaseSync, valid: ConstructorParameters<typeof Settings>[1]) {
  return new Settings(sqlOf(db), valid);
}
