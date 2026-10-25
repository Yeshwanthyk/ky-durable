import type { Static, TSchema } from "typebox";
import { decode } from "../../core/decode";

/** Every row a query returns, each checked against `schema`; `what` names a row in the error when one isn't. */
export function rows<Schema extends TSchema>(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>, schema: Schema, what: string): Array<Static<Schema>> {
  return cursor.toArray().map((row) => decode(schema, row, what));
}
