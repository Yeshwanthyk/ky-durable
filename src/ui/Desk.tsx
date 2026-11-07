import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { DeskView } from "../protocol";
import { Icon } from "../chat-kit/Icon";
import { day } from "./time";

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

  if (view === null || (view.map.length === 0 && view.starts.length === 0 && view.events.length === 0)) return null;

  const judge = (start: string, verdict: "kept" | "discarded") => {
    setRefusal(null);
    void actions.onJudge(start, verdict).then((answer) => ("refused" in answer ? setRefusal(answer.refused) : setView(answer)), (error: Error) => setRefusal(error.message));
  };

  return (
    <section className="feed-group desk" aria-label="Desk">
      <h3 className="feed-head">
        Desk
        {view.extra.most > 0 ? (
          <span className="ledger-tally">
            {" "}
            · {view.extra.used}/{view.extra.most} extra looks today
          </span>
        ) : null}
      </h3>
      <ul className="feed">
        {view.starts.map((start) => (
          <li key={start.id} className="feed-item desk-start" aria-label={`Started: ${start.title}`}>
            <span className="feed-button">
              <span className="feed-glyph">
                <Icon name="plus" size={16} />
              </span>
              <span className="feed-text">
                <button type="button" className="feed-title automation-text pressable" onClick={() => onOpen(start.session)}>
                  {start.title}
                </button>
                <span className="ledger-reason">Started on its own · {day(start.at, now)}</span>
              </span>
              {start.verdict === null ? (
                <>
                  <button type="button" className="automation-text pressable" aria-label={`Keep: ${start.title}`} onClick={() => judge(start.id, "kept")}>
                    Keep
                  </button>
                  <button type="button" className="automation-text pressable" aria-label={`Discard: ${start.title}`} onClick={() => judge(start.id, "discarded")}>
                    Discard
                  </button>
                </>
              ) : (
                <span className="ledger-undone">{start.verdict === "kept" ? "Kept" : "Discarded"}</span>
              )}
            </span>
          </li>
        ))}
        {view.map.map((item) => (
          <li key={item.id} className="feed-item desk-map" aria-label={item.title}>
            <span className="feed-button">
              <span className="feed-glyph">
                <Icon name="list" size={16} />
              </span>
              <span className="feed-text">
                <span className="feed-title">{item.title}</span>
                {item.next === "" ? null : <span className="ledger-reason">Next: {item.next}</span>}
              </span>
              <span className="ledger-tally">
                {STATE_WORD.get(item.state) ?? item.state}
                {item.by === "" ? "" : ` · by ${item.by.slice(0, 10)}`}
              </span>
            </span>
          </li>
        ))}
        {view.events.map((event) => (
          <li key={event.id} className="feed-item desk-event" aria-label={event.line}>
            <span className="feed-button">
              <span className="feed-glyph">
                <Icon name="mail" size={16} />
              </span>
              <span className="feed-text">
                <span className="feed-title">{event.line}</span>
                <span className="ledger-reason">{event.look === null ? "Waiting for the next look" : "Seen by a look"}</span>
              </span>
            </span>
          </li>
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
