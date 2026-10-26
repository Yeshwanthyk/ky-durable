import * as legacy from "../../../src/history/legacy/history";
import { plainSql, readsOf } from "./next";
import { chatSide, type Make } from "./world";

export const legacySide: Make = {
  open: (db) => new legacy.History(plainSql(db), chatSide.isChat, chatSide.name),
  reads: (db) => readsOf(legacy, plainSql(db))
};
