import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { FileStore } from "../../../src/files/legacy/files";

type SqlStorageOf = ConstructorParameters<typeof FileStore>[0];

function sqlOf(db: DatabaseSync): SqlStorageOf {
  const exec = (query: string, ...bindings: SQLInputValue[]) => {
    const rows = db
      .prepare(query)
      .all(...bindings)
      .map((row) => ({ ...row }));

    return { toArray: () => rows, one: () => rows[0] };
  };

  // SAFETY: B's FileStore calls sql.exec and reads toArray; nothing else of SqlStorage.
  return { exec, databaseSize: 0 } as SqlStorageOf;
}

export const legacyStore = (db: DatabaseSync) => new FileStore(sqlOf(db));


export { upload } from "../../../src/files/legacy/files";

export { retype, uploadedType } from "../../../src/files/legacy/file-types";

export { checkInput, imageSupport, imagesOf } from "../../../src/files/legacy/images";

export { baseType, clock, mediaKind, mediaTag, readMedia, spokenText } from "../../../src/files/legacy/media";

export { uploadMedia } from "../../../src/files/legacy/media-upload";
