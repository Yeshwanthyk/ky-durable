import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A function with one identity for the component's life that always calls the
 * latest `fn`, so a memoised child handed it skips renders the parent's new
 * closures would otherwise cause. Only for handlers, not for render.
 */
export function useStableCallback<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(fn);

  useLayoutEffect(() => {
    latest.current = fn;
  });

  return useCallback((...args: Args) => latest.current(...args), []);
}

/** The value from the last render while it still equals this one, so a new but equal object keeps its identity. */
export function useSame<Value>(value: Value, equal: (a: Value, b: Value) => boolean): Value {
  const kept = useRef(value);

  if (kept.current !== value && !equal(kept.current, value)) kept.current = value;

  return kept.current;
}

/** Whether two objects hold the same values under the same keys, compared with Object.is. */
export function shallow<Value extends object>(a: Value, b: Value): boolean {
  // SAFETY: Object.keys lists the object's own keys, each a key of Value.
  const keys = Object.keys(a) as (keyof Value)[];

  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}
