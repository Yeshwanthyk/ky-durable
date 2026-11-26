import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { DeskView } from "../protocol";
import { Button } from "./kit/Button";
import { WorkRow } from "./kit/WorkRow";
import { clock, day } from "./time";

type DeskActions = {
  /** Whether the socket is open: the Desk reads when it opens, and again on each reconnect. */
  readonly open: boolean;
  readonly onView: () => Promise<DeskView>;
  /** Keep or discard what ky started; resolves with the Desk again, or `{ refused }`. */
  readonly onJudge: (start: string, verdict: "kept" | "discarded") => Promise<DeskView | { readonly refused: string }>;
};

/** What Activity › Desk reads and does; provided around the panel. */
export const DeskContext = createContext<DeskActions>({
  open: false,
  onView: () => Promise.reject(new Error("Not connected.")),
  onJudge: () => Promise.reject(new Error("Not connected."))
});

const STATE_WORD = new Map([
  ["open", "Open"],
  ["doing", "Doing"],
  ["waiting", "Waiting"]
]);

// What ky is keeping track of between looks: the work map, what it started on its own (each kept or discarded once),
// what arrived since, and the extra looks it spent today against the pace's budget. Hidden while all of it is empty.
export function Desk({ now, onOpen }: { now: number; onOpen: (session: string) => void }) {
  const actions = useContext(DeskContext);
  const [view, setView] = useState<DeskView | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const load = useCallback(() => actions.onView().then(setView, () => undefined), [actions]);

  useEffect(() => {
    if (actions.open) void load();
  }, [actions.open, load]);

  if (view === null || (view.map.length === 0 && view.starts.length === 0 && view.events.length === 0 && view.next === null)) return null;

  const judge = (start: string, verdict: "kept" | "discarded") => {
    setRefusal(null);
    void actions.onJudge(start, verdict).then((answer) => ("refused" in answer ? setRefusal(answer.refused) : setView(answer)), (error: Error) => setRefusal(error.message));
  };

  return (
    <section className="feed-group desk" aria-label="Keeping track">
      <h3 className="feed-head">
        Keeping track
        {/* The tally sits apart at the row's end, so it takes no separator. */}
        {view.extra.most > 0 ? (
          <span className="ledger-tally">
            {view.extra.used}/{view.extra.most} extra looks today
          </span>
        ) : null}
      </h3>
      {view.next === null ? null : (
        <p className="ledger-reason" aria-label="Next look">
          Next look {clock(view.next.at)}: {view.next.why}
        </p>
      )}
      <ul className="kit-rows">
        {view.starts.map((start) => (
          <WorkRow
            key={start.id}
            status={start.verdict === null ? "needs" : "done"}
            label={`Started: ${start.title}`}
            title={
              <button type="button" onClick={() => onOpen(start.session)}>
                {start.title}
              </button>
            }
            meta={`Started on its own · ${day(start.at, now)}`}
            trailing={
              start.verdict === null ? (
                <>
                  <Button size={28} aria-label={`Keep: ${start.title}`} onClick={() => judge(start.id, "kept")}>
                    Keep
                  </Button>
                  <Button size={28} variant="quiet" aria-label={`Discard: ${start.title}`} onClick={() => judge(start.id, "discarded")}>
                    Discard
                  </Button>
                </>
              ) : start.verdict === "kept" ? (
                "Kept"
              ) : (
                "Discarded"
              )
            }
          />
        ))}
        {view.map.map((item) => (
          <WorkRow
            key={item.id}
            status={item.state === "doing" ? "working" : "open"}
            label={item.title}
            title={item.title}
            meta={item.next === "" ? undefined : `Next: ${item.next}`}
            trailing={`${STATE_WORD.get(item.state) ?? item.state}${item.by === "" ? "" : ` · by ${item.by.slice(0, 10)}`}`}
            detail={
              <>
                {item.next === "" ? null : <p>Next: {item.next}</p>}
                <p>Updated {day(item.updated_at, now)}</p>
              </>
            }
          />
        ))}
        {view.events.map((event) => (
          <WorkRow
            key={event.id}
            status={event.look === null ? "open" : "done"}
            label={event.line}
            title={event.line}
            meta={event.look === null ? "Waiting for the next look" : "Seen by a look"}
          />
        ))}
      </ul>
      {refusal === null ? null : (
        <p className="ledger-refusal" role="status">
          {refusal}
        </p>
      )}
    </section>
  );
}
