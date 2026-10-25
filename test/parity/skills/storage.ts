/**
 * The skills domain over a real SQLite, for its parity runs and its invariants: a Durable Object's storage made
 * from node:sqlite, and the skills extension's tool and hook called as pi calls them.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension, HookApi, ToolExecutionApi, ToolHookCall, ToolHooks } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ReviewHost, SkillChange } from "../../../src/skills/contract";
import type { Skills } from "../../../src/skills/wiring";

/** A Durable Object's storage, as the port takes it. */
type Storage = ConstructorParameters<typeof Skills>[0];

/** A real SQLite as a Durable Object's `sql`: `exec` with `toArray` and `one`. */
export function sqlOf(db: DatabaseSync) {
  return {
    exec: (query: string, ...bindings: SQLInputValue[]) => {
      const rows = db
        .prepare(query)
        .all(...bindings)
        .map((row) => ({ ...row }));

      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);

          return rows[0];
        }
      };
    }
  };
}

/** `db` as a Durable Object's storage: its `sql`, and `transactionSync` over SQLite's savepoints. */
export function storageOf(db: DatabaseSync): Storage {
  const transactionSync = <T>(work: () => T): T => {
    db.exec("SAVEPOINT tx");

    try {
      const done = work();
      db.exec("RELEASE tx");

      return done;
    } catch (error) {
      db.exec("ROLLBACK TO tx");
      db.exec("RELEASE tx");
      throw error;
    }
  };

  // SAFETY: the library and the review log use sql.exec (toArray) and transactionSync, nothing else of the storage.
  return { sql: sqlOf(db), transactionSync } as Storage;
}

/** A stored row: the skill tables hold only numbers, strings and nulls. */
export const StoredRow = Schema.Record(Schema.String, Schema.NullOr(Schema.Union([Schema.String, Schema.Number])));

/** Each row of `table`, in the order it was written. */
export const rowsOf = (db: DatabaseSync, table: string) =>
  db
    .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
    .all()
    .map((row) => Schema.decodeUnknownSync(StoredRow)({ ...row }));

/** The extension's host is used only by a review it starts after a busy turn, which no caller here reaches. */
// SAFETY: see above; nothing here calls a member of it.
export const HOST = {} as ReviewHost;

/** Runs a skill tool as conversation `from` calls it: its text, and whether it failed. */
export async function callTool(extension: Extension, name: string, args: SkillChange | { readonly name: string; readonly history: boolean }, from: string) {
  const tool = extension.tools?.find((each) => each.name === name);

  if (!tool) throw new Error(`No tool ${name}`);
  // SAFETY: the skill tools read only the calling conversation from their api.
  const api = { conversationId: Number(from), taskId: 1, callId: "call-1" } as ToolExecutionApi;
  const result = await tool.execute(args, api, BACKGROUND_CONTEXT);

  return { text: (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""), failed: result.isError === true };
}

/** The allowlist's verdict on conversation `from` calling `name`: the block's words, or null. */
export async function blockOf(extension: Extension, name: string, from: string): Promise<string | null> {
  // SAFETY: a hook's handlers are its task's hooks; the skills extension's ToolTask hook is the one with beforeTool.
  const hooks = (extension.hooks ?? []).map(({ handlers }) => handlers as Partial<ToolHooks>);
  const beforeTool = hooks.find((each) => each.beforeTool)?.beforeTool;

  if (!beforeTool) throw new Error("No beforeTool hook");
  // SAFETY: the allowlist reads the call's name, nothing else of it.
  const toolCall = { name } as ToolHookCall;
  // SAFETY: the allowlist reads the calling conversation, nothing else of the api.
  const api = { conversationId: Number(from) } as HookApi;
  const verdict = await beforeTool(toolCall, api, BACKGROUND_CONTEXT);

  return verdict?.block ?? null;
}
