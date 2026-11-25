import { type AnimationEvent, useContext, useEffect, useRef, useState } from "react";
import type { ApprovalView } from "../../approvals/contract";
import { ApprovalsContext, DecisionCard, snooze, stillWaiting } from "../Approvals";
import { Problem } from "../Subscriptions";
import { useStableCallback } from "../use-stable";

/** What the Deck can answer: a hand-off of ky's browser takes the user to the live page, so it stays in its chat. */
export const deckOf = (approvals: readonly ApprovalView[], put: ReadonlySet<string>) =>
  stillWaiting(approvals, put).filter((approval) => approval.kind !== "browser-handoff");

type Answer = "accept" | "decline" | "later";

const KEYS = new Map<string, Answer>([
  ["y", "accept"],
  ["n", "decline"],
  ["l", "later"]
]);

/** A key the Deck leaves alone: one typed into a field, or with a modifier for a shortcut. */
const typing = (event: KeyboardEvent) =>
  event.metaKey ||
  event.ctrlKey ||
  event.altKey ||
  event.repeat ||
  (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.closest("input, textarea, select, dialog") !== null));

// The approvals of every chat, one card at a time with the rest stacked behind it. Y, N and L answer the top one at
// once; a tap lets it leave as the next arrives. Later puts it off for this tab, as it does in its chat.
export function Deck({ deck, onAnswered }: { deck: readonly ApprovalView[]; onAnswered: (approval: string, answered: boolean) => void }) {
  const { onDecide, waiting } = useContext(ApprovalsContext);
  const [refused, setRefused] = useState<string>();
  // The card a tap just answered, drawn over the next as it leaves.
  const [leaving, setLeaving] = useState<ApprovalView | null>(null);
  const [instant, setInstant] = useState(false);
  // Whether the answer in hand came from a pointer: a click's detail counts its presses, a key's is 0.
  const pointer = useRef(false);
  const top = deck[0];

  const answer = useStableCallback((approval: ApprovalView, action: Answer, animate: boolean) => {
    setInstant(!animate);
    setLeaving(animate ? approval : null);
    setRefused(undefined);

    if (action === "later") return snooze(approval.id);

    onAnswered(approval.id, true);
    void onDecide(approval.id, action).then((reason) => {
      if (reason === undefined) return;

      setRefused(reason);
      onAnswered(approval.id, false);
    });
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = KEYS.get(event.key.toLowerCase());

      if (action === undefined || top === undefined || typing(event)) return;
      event.preventDefault();
      answer(top, action, false);
    };

    addEventListener("keydown", onKey);

    return () => removeEventListener("keydown", onKey);
  }, [top, answer]);

  const onLeft = (event: AnimationEvent) => {
    if (event.target === event.currentTarget) setLeaving(null);
  };

  return (
    <section className="desk-deck-group" aria-label="Only you can decide">
      <header className="desk-section-head">
        <h2>Only you can decide</h2>
        <p className="desk-keys" aria-hidden>
          <kbd>Y</kbd> Yes <kbd>N</kbd> No <kbd>L</kbd> Later
        </p>
      </header>
      <div
        className="desk-deck"
        data-instant={instant}
        data-behind={Math.min(deck.length - 1, 2)}
        onClickCapture={(event) => {
          pointer.current = event.detail > 0;
        }}
      >
        {top ? (
          <DecisionCard
            key={top.id}
            approval={top}
            onDecide={(action) => answer(top, action, pointer.current)}
            onLater={() => answer(top, "later", pointer.current)}
            position={{ index: 0, of: deck.length }}
            waiting={waiting.get(top.id)}
          />
        ) : null}
        {leaving ? (
          <div className="desk-ghost" inert aria-hidden onAnimationEnd={onLeft}>
            <DecisionCard approval={leaving} onDecide={() => {}} position={{ index: 0, of: deck.length + 1 }} />
          </div>
        ) : null}
        <span className="desk-edge" aria-hidden />
        <span className="desk-edge" aria-hidden />
      </div>
      <Problem text={refused} />
    </section>
  );
}
