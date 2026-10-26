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

  // SAFETY: B's avatars and setup use only exec (toArray) of the storage.
  return { exec, databaseSize: 0 } as SqlStorageOf;
}

export function legacyOf(db: DatabaseSync, owners: () => readonly string[]) {
  const avatars = new Avatars(sqlOf(db));
  const setup = new Setup(sqlOf(db));

  return {
    avatars: { all: () => avatars.all(), onChange: (listener: () => void) => avatars.onChange(listener) },
    setup: {
      onChange: (listener: () => void) => setup.onChange(listener),
      setRepo: (repo: string, page: string | null) => setup.setRepo(repo, page),
      view: () => setup.view(),
      selfEdit: () => setup.selfEdit(),
      firstStart: () => setup.firstStart(),
      origin: () => setup.origin(),
      opened: (page: string) => setup.opened(page),
      moved: (origin: string) => setup.moved(origin)
    },
    tool: avatarTools(avatars, owners)
  };
}
