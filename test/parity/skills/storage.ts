import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Extension, HookApi, ToolHookCall, ToolHooks } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ReviewHost } from "../../../src/skills/contract";
import type { Skills } from "../../../src/skills/wiring";

type Storage = ConstructorParameters<typeof Skills>[0];

function sqlOf(db: DatabaseSync) {
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

export const StoredRow = Schema.Record(Schema.String, Schema.NullOr(Schema.Union([Schema.String, Schema.Number])));

// SAFETY: see above; nothing here calls a member of it.
export const HOST = {} as ReviewHost;

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
