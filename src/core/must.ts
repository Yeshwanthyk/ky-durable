/** `value`, or an error saying `message` when it is missing: for lookups whose absence is a bug, in place of `!`. */
export function must<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) throw new Error(message);

  return value;
}
