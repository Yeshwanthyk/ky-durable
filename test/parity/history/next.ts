import type { DatabaseSync } from "node:sqlite";
import { History, ownMessages, placedBy, runInputs, runOpener, startedByUser, wroteSince } from "../../../src/history/wiring";
import { chatSide, type Make, type Reads, sqlOf, transactionOf } from "./world";

type Storage = ConstructorParameters<typeof History>[0];

// SAFETY: the reads call sql.exec and read toArray, one or its rows; nothing else of SqlStorage.
const plainSql = (db: DatabaseSync): Storage["sql"] => ({ ...sqlOf(db), databaseSize: 0 }) as Storage["sql"];

// SAFETY: the port reaches sql.exec (toArray, one, its rows) and transactionSync; nothing else of the storage.
const storage = (db: DatabaseSync): Storage => ({ sql: { ...sqlOf(db), databaseSize: 0 }, transactionSync: transactionOf(db) }) as Storage;

const readsOf = (sql: SqlStorage): Reads => ({
  placedBy: (users) => placedBy(sql, users),
  ownMessages: (users) => ownMessages(sql, users),
  startedByUser: (conversation) => startedByUser(sql, conversation),
  runOpener: (conversation, before) => runOpener(sql, conversation, before),
  runInputs: (conversation) => runInputs(sql, conversation),
  wroteSince: (conversation, at) => wroteSince(sql, conversation, at)
});

export const nextSide: Make = {
  open: (db) => new History(storage(db), chatSide.isChat, chatSide.name),
  reads: (db) => readsOf(plainSql(db))
};
