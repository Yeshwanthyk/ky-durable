import type { JsonValue } from "@earendil-works/pi-ai";
import { Guard } from "typebox/guard";

/** `value` as JSON with every object's keys sorted, so two calls with the same arguments in another order compare equal. */
export function canonical(value: JsonValue): string {
  return JSON.stringify(sorted(value));
}

const isList = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

function sorted(value: JsonValue): JsonValue {
  if (isList(value)) return value.map(sorted);

  if (value === null || !Guard.IsObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, sorted(item)])
  );
}
