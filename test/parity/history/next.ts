import type { DatabaseSync } from "node:sqlite";
import * as wiring from "../../../src/history/wiring";
import { chatSide, type Make, type Reads, sqlOf, transactionOf } from "./world";

type Storage = ConstructorParameters<typeof wiring.History>[0];

// SAFETY: the reads call sql.exec and read toArray, one or its rows; nothing else of SqlStorage.
export const plainSql = (db: DatabaseSync): Storage["sql"] => ({ ...sqlOf(db), databaseSize: 0 }) as Storage["sql"];

// SAFETY: the port reaches sql.exec (toArray, one, its rows) and transactionSync; nothing else of the storage.
const storage = (db: DatabaseSync): Storage => ({ sql: { ...sqlOf(db), databaseSize: 0 }, transactionSync: transactionOf(db) }) as Storage;

type Module = Pick<typeof wiring, "placedBy" | "ownMessages" | "startedByUser" | "runOpener" | "runInputs" | "wroteSince">;

export const readsOf = (module: Module, sql: SqlStorage): Reads => ({
  placedBy: (users) => module.placedBy(sql, users),
  ownMessages: (users) => module.ownMessages(sql, users),
  startedByUser: (conversation) => module.startedByUser(sql, conversation),
  runOpener: (conversation, before) => module.runOpener(sql, conversation, before),
  runInputs: (conversation) => module.runInputs(sql, conversation),
  wroteSince: (conversation, at) => module.wroteSince(sql, conversation, at)
});

export const nextSide: Make = {
  open: (db) => new wiring.History(storage(db), chatSide.isChat, chatSide.name),
  reads: (db) => readsOf(wiring, plainSql(db))
};
