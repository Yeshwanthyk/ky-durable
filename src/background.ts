/** A pi context with no values that is never cancelled. */
export const BACKGROUND = Object.freeze({
  abortSignal: undefined,
  value: () => undefined,
  toString: () => "[Context ky background]"
});
