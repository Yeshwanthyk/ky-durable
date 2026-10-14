import { useState } from "react";

/**
 * How many times a value has changed since mount, counted during render so the change shows in
 * the same frame. Something simply rendered in a state has 0, so it can skip its entrance. While
 * `ready` is false the value is still loading: it is tracked but not counted.
 */
export function useChanges<T>(value: T, ready = true): number {
  const [last, setLast] = useState({ value, ready });
  const [count, setCount] = useState(0);

  if (last.value !== value || last.ready !== ready) {
    setLast({ value, ready });

    if (last.ready && ready && last.value !== value) setCount((changes) => changes + 1);
  }

  return count;
}
