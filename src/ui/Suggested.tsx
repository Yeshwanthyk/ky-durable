import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ProposalView } from "../protocol";
import { cronInWords } from "./Automations";
import { Icon } from "./Icon";

type SuggestedActions = {
  /** Whether the socket is open: the list reads when it opens, and again on each reconnect. */
  readonly open: boolean;
  /** The open proposals, oldest first; none while proactivity is off. */
  readonly onView: () => Promise<readonly ProposalView[]>;
  /** The list was on the user's screen with these proposals. */
  readonly onSeen: (ids: readonly number[]) => void;
  /** Accept one: its automation is created as the user's; resolves with why it was refused, if it was. */
  readonly onAccept: (proposal: number) => Promise<string | undefined>;
  /** Dismiss one for good; resolves with why it was refused, if it was. */
  readonly onDismiss: (proposal: number) => Promise<string | undefined>;
};

/** What Activity › Suggested reads and does; provided around the panel. */
export const SuggestedContext = createContext<SuggestedActions>({
  open: false,
  onView: () => Promise.reject(new Error("Not connected.")),
  onSeen: () => undefined,
  onAccept: () => Promise.resolve("Not connected."),
  onDismiss: () => Promise.resolve("Not connected.")
});

// Automations the dream suggested from a check the user kept doing by hand: each says why, and waits for Accept or Dismiss.
export function Suggested({ now }: { now: number }) {
  const actions = useContext(SuggestedContext);
  const [rows, setRows] = useState<readonly ProposalView[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [refusals, setRefusals] = useState<Readonly<Record<number, string | undefined>>>({});
  const load = useCallback(() => actions.onView().then(setRows, () => undefined), [actions]);
  const { onSeen } = actions;
  const ids = rows.map((row) => row.id).join(",");

  useEffect(() => {
    if (actions.open) void load();
  }, [actions.open, load]);

  // Shown means seen: each listed proposal is recorded as surfaced once the list is on screen.
  useEffect(() => {
    if (ids !== "") onSeen(ids.split(",").map(Number));
  }, [ids, onSeen]);

  if (rows.length === 0) return null;

  const decide = (id: number, act: (proposal: number) => Promise<string | undefined>) => {
    setBusy(id);
    setRefusals((current) => ({ ...current, [id]: undefined }));
    void act(id)
      .then((refusal) => setRefusals((current) => ({ ...current, [id]: refusal })))
      .then(load)
      .finally(() => setBusy(null));
  };

  return (
    <section className="feed-group suggested" aria-label="Suggested">
      <h3 className="feed-head">Suggested</h3>
      <ul className="feed">
        {rows.map((row) => (
          <li key={row.id} className="feed-item ledger-change" aria-label={row.title}>
            <span className="feed-button">
              <span className="feed-glyph">
                <Icon name="sparkle" size={16} />
              </span>
              <span className="feed-text">
                <span className="feed-title">{row.title}</span>
                <span className="ledger-reason">{row.why}</span>
                <span className="ledger-reason">{cronInWords(row.cron, now)}</span>
                <details className="suggested-spec">
                  <summary>What it runs</summary>
                  <span className="suggested-spec-label">Prompt</span>
                  <pre aria-label="Prompt">{row.prompt}</pre>
                  {row.gate === null ? null : (
                    <>
                      <span className="suggested-spec-label">Gate</span>
                      <pre aria-label="Gate">{row.gate}</pre>
                    </>
                  )}
                </details>
                {refusals[row.id] === undefined ? null : (
                  <span className="ledger-refusal" role="status">
                    {refusals[row.id]}
                  </span>
                )}
              </span>
              <button type="button" className="automation-text pressable" aria-label={`Accept: ${row.title}`} disabled={busy === row.id} onClick={() => decide(row.id, actions.onAccept)}>
                Accept
              </button>
              <button type="button" className="automation-text pressable" aria-label={`Dismiss: ${row.title}`} disabled={busy === row.id} onClick={() => decide(row.id, actions.onDismiss)}>
                Dismiss
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
