import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Avatars, avatarTools } from "../../../src/avatars/legacy/avatars";
import { Setup } from "../../../src/avatars/legacy/setup";

type SqlStorageOf = ConstructorParameters<typeof Avatars>[0];

function sqlOf(db: DatabaseSync): SqlStorageOf {
  const exec = (query: string, ...bindings: SQLInputValue[]) => {
    const statement = db.prepare(query);

    if (statement.columns().length === 0) {
      const { changes } = statement.run(...bindings);

      return { toArray: () => [], rowsWritten: Number(changes) };
    }

    const rows = statement.all(...bindings).map((row) => ({ ...row }));

    return { toArray: () => rows, rowsWritten: 0 };
  };

  return { exec, databaseSize: 0 } as SqlStorageOf;
}

export function legacyOf(db: DatabaseSync, owners: () => readonly string[]) {
  const avatars = new Avatars(sqlOf(db));

  return { avatars, setup: new Setup(sqlOf(db)), tool: avatarTools(avatars, owners) };
}
