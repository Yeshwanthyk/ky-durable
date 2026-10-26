import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { credentialFetch, signedWith } from "../../../src/inbound/legacy/credentials";
import { Inbound } from "../../../src/inbound/legacy/inbound";
import { hookRoute, inboundRoute } from "../../../src/inbound/legacy/routes";
import type { Side } from "./world";

function sqlOf(db: DatabaseSync): never {
  const exec = (query: string, ...bindings: SQLInputValue[]) => {
    const rows = db
      .prepare(query)
      .all(...bindings)
      .map((row) => ({ ...row }));

    const written = /^\s*(INSERT|UPDATE|DELETE)/i.test(query) ? Number(db.prepare("SELECT changes() AS n").get()?.n ?? 0) : 0;

    return { toArray: () => rows, one: () => rows[0], rowsWritten: written };
  };

  // SAFETY: B's Inbound and runInputs call sql.exec and read toArray, one or rowsWritten; nothing else of SqlStorage.
  return { exec, databaseSize: 0 } as never;
}

export const legacy: Side = {
  make: (db, desk) => new Inbound(sqlOf(db), desk),
  hookRoute,
  inboundRoute,
  credentialFetch,
  signedWith
};
