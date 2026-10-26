import { blocked, said, type Side } from "./legacy";

const SESSIONS = ["1", "2", "7", "8", "9"];

export async function readsOf(side: Side) {
  const ids = side.recent(50).map((row) => row.id);

  return {
    view: side.view(),
    list: await said(side.extension, { action: "list" }, "1"),
    read: await Promise.all([...ids, "none"].map((id) => said(side.extension, { action: "read", id }, "1"))),
    blocked: await Promise.all(SESSIONS.map((session) => blocked(side.extension, session)))
  };
}
