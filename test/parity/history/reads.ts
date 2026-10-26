import type { Json } from "../kit";
import { CONVERSATIONS, DAY, QUERIES, type Reads, saidJson, type Side } from "./world";

export function readAll(side: Side, reads: Reads, ids: readonly number[], now: number): Json {
  const span = { from: now - 3 * DAY, to: now, days: "the last three days" };

  return {
    search: QUERIES.flatMap((query) => [
      side.search(query, {}),
      side.search(query, { around: 1, caller: "2" }),
      side.search(query, { span }),
      side.search(query, { around: 2, batches: 0 })
    ]),
    since: [0, 1, 5, 20].flatMap((seq) =>
      [0, 2 * DAY, 30 * DAY].flatMap((back) => [120, 20_000].map((chars) => saidJson(side.since({ seq, at: now - back }, chars))))
    ),
    sinceAt: [saidJson(side.since({ seq: 0, at: 0 }, 20_000, now - 2 * DAY)), saidJson(side.since({ seq: 0, at: 0 }, 20_000, now + 9 * DAY))],
    latest: CONVERSATIONS.map((session) => side.latest(session)),
    placedBy: [...reads.placedBy(ids)].map(([entry, request]) => [entry, request ?? null]),
    ownMessages: [...reads.ownMessages(ids)],
    conversations: CONVERSATIONS.map((conversation) => ({
      startedByUser: reads.startedByUser(conversation),
      runOpener: reads.runOpener(conversation) ?? null,
      runOpenerBefore: ids.map((id) => reads.runOpener(conversation, id) ?? null),
      runInputs: reads.runInputs(conversation).map(({ entry, request }) => ({ entry, request: request ?? null })),
      wroteSince: [0, DAY, 10 * DAY].map((ago) => reads.wroteSince(conversation, now - ago))
    }))
  };
}
