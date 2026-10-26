import type { FileRow } from "../../../src/files/contract";

type Store = {
  list(): FileRow[];
  forTask(task: string): FileRow[];
  untyped(): FileRow[];
  typed(types: ReadonlyMap<string, string>): void;
};

export function readsOf(store: Store) {
  const before = { list: store.list(), t1: store.forTask("t1"), t2: store.forTask("t2"), none: store.forTask("none"), untyped: store.untyped() };
  store.typed(new Map([["c0ffee00c0ffee00c0ffee00c0ffee01", "audio/webm"]]));

  return { before, after: { list: store.list(), untyped: store.untyped() } };
}
