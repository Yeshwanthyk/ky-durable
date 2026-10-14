/**
 * The one place untrusted values become typed ones. Anything that crosses a boundary (a socket frame,
 * a fetch body, a JSON column, a runner report, a file) is checked against its schema here, so the
 * rest of ky never casts what it did not check. Lint bans `JSON.parse` and `.json()` everywhere else.
 */
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

/** `value` as `schema` says, or an error saying `what` isn't what ky expects. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the boundary: this is where unknown input is checked.
export function decode<Schema extends TSchema>(schema: Schema, value: unknown, what: string): Static<Schema> {
  if (!Value.Check(schema, value)) throw new Error(`${what} isn't what ky expects.`);

  return value;
}

/** `value` as `schema` says, or `fallback` when it isn't: for stored values a restore or an old version may have damaged. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the boundary: this is where unknown input is checked.
export function decodeOr<Schema extends TSchema, Fallback>(schema: Schema, value: unknown, fallback: Fallback): Static<Schema> | Fallback {
  return Value.Check(schema, value) ? value : fallback;
}

/** `text` parsed as JSON, or `undefined` when it isn't JSON; private, so only the checks above see it. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- the boundary: callers get it only through decode.
function json(text: string): unknown {
  try {
    // oxlint-disable-next-line ky/no-unchecked-parse -- the one sanctioned parse.
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `text` as JSON that `schema` says, or an error saying `what` is damaged. */
export function parseAs<Schema extends TSchema>(schema: Schema, text: string, what: string): Static<Schema> {
  const value = json(text);

  if (value === undefined) throw new Error(`${what} isn't JSON.`);

  return decode(schema, value, what);
}

/** `text` as JSON that `schema` says, or `fallback` when it is damaged. */
export function parseOr<Schema extends TSchema, Fallback>(schema: Schema, text: string, fallback: Fallback): Static<Schema> | Fallback {
  return decodeOr(schema, json(text), fallback);
}

/** A fetch response's body as `schema` says, or an error saying `what` isn't what ky expects. */
export async function bodyAs<Schema extends TSchema>(response: Response, schema: Schema, what: string): Promise<Static<Schema>> {
  return parseAs(schema, await response.text(), what);
}
