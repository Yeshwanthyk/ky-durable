import type { DatabaseSync } from "node:sqlite";
import * as legacy from "../../../src/history/legacy/history";
import * as wiring from "../../../src/history/wiring";
import { chatSide, type Make, sqlOf, transactionOf } from "./world";

type Storage = ConstructorParameters<typeof wiring.History>[0];

// SAFETY: B's History and the reads call sql.exec and read toArray, one or its rows; nothing else of SqlStorage.
const legacySql = (db: DatabaseSync): Storage["sql"] => ({ ...sqlOf(db), databaseSize: 0 }) as Storage["sql"];

// SAFETY: the port reaches sql.exec (toArray, one, its rows) and transactionSync; nothing else of the storage.
const storage = (db: DatabaseSync): Storage => ({ sql: { ...sqlOf(db), databaseSize: 0 }, transactionSync: transactionOf(db) }) as Storage;

type Module = Pick<typeof wiring, "placedBy" | "ownMessages" | "startedByUser" | "runOpener" | "runInputs" | "wroteSince">;

const readsOf = (module: Module, sql: SqlStorage) => ({
  placedBy: (users: readonly number[]) => module.placedBy(sql, users),
  ownMessages: (users: readonly number[]) => module.ownMessages(sql, users),
  startedByUser: (conversation: string) => module.startedByUser(sql, conversation),
  runOpener: (conversation: string, before?: number) => module.runOpener(sql, conversation, before),
  runInputs: (conversation: string) => module.runInputs(sql, conversation),
  wroteSince: (conversation: string, at: number) => module.wroteSince(sql, conversation, at)
});

export const legacySide: Make = {
  open: (db) => new legacy.LegacyHistory(legacySql(db), chatSide.isChat, chatSide.name),
  reads: (db) => readsOf(legacy, legacySql(db))
};

export const nextSide: Make = {
  open: (db) => new wiring.History(storage(db), chatSide.isChat, chatSide.name),
  reads: (db) => readsOf(wiring, legacySql(db))
};
