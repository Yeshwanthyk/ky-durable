import { type AnimationEvent, type RefObject, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ApprovalView } from "../../approvals/contract";
import { ApprovalsContext, DecisionCard, markAnswered, snooze } from "../Approvals";
import { Problem } from "../Subscriptions";
import { useStableCallback } from "../use-stable";

type Answer = "accept" | "decline" | "later";

const KEYS = new Map<string, Answer>([
  ["y", "accept"],
  ["n", "decline"],
  ["l", "later"]
]);

/** A key the Deck leaves alone: one held with any modifier, or typed into a field or a dialog. */
const ignored = (event: KeyboardEvent) =>
  event.metaKey ||
  event.ctrlKey ||
  event.altKey ||
  event.shiftKey ||
  event.repeat ||
  (event.target instanceof HTMLElement &&
    (event.target.isContentEditable || event.target.closest("input, textarea, select, dialog, [role=dialog], [role=alertdialog]") !== null));

/** Whether the keyboard is on the Desk page `page`: nothing focused, the sidebar's Desk row that opened it, or something on the page itself. */
function onPage(page: Element | null | undefined): boolean {
  const active = document.activeElement;

  if (active === null || active === document.body || active.closest(".desk-entry") !== null) return true;

  return page?.contains(active) === true && active.closest("dialog, [role=dialog], [role=alertdialog]") === null;
}

// The approvals of every chat, one card at a time with the rest stacked behind it. Y, N and L answer the top one at
// once; a tap lets it leave as the next arrives. Later puts it off for this tab, as it does in its chat. After an
// answer the keyboard lands on the next card's Approve, or on `heading` once none is left. With an empty deck it draws
// nothing, but for the last card's leaving.
export function Deck({ deck, heading }: { deck: readonly ApprovalView[]; heading?: RefObject<HTMLElement | null> }) {
  const { onDecide, waiting } = useContext(ApprovalsContext);
  const [refused, setRefused] = useState<string>();
  // The card a tap just answered, drawn over the next as it leaves.
  const [leaving, setLeaving] = useState<ApprovalView | null>(null);
  const [instant, setInstant] = useState(false);
  // Whether the answer in hand came from a pointer: a click's detail counts its presses, a key's is 0.
  const pointer = useRef(false);
  // The answers on their way, by approval: a second one for the same card does nothing.
  const pending = useRef(new Set<string>());
  // Set by an answer, so the card that follows takes the focus the answered one had.
  const refocus = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const top = deck[0];

  const answer = useStableCallback((approval: ApprovalView, action: Answer, animate: boolean) => {
    if (pending.current.has(approval.id) || waiting.has(approval.id)) return;

    setInstant(!animate);
    setLeaving(animate ? approval : null);
    setRefused(undefined);
    refocus.current = true;

    if (action === "later") return snooze(approval.id);

    pending.current.add(approval.id);
    markAnswered(approval.id, true);
    void onDecide(approval.id, action).then((reason) => {
      pending.current.delete(approval.id);

      if (reason === undefined) return;

      setRefused(reason);
      markAnswered(approval.id, false);
    });
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = KEYS.get(event.key.toLowerCase());

      if (action === undefined || top === undefined || ignored(event) || !onPage(box.current?.closest(".desk-page"))) return;
      event.preventDefault();
      answer(top, action, false);
    };

    addEventListener("keydown", onKey);

    return () => removeEventListener("keydown", onKey);
  }, [top, answer]);

  // The answered card's buttons went with it: the next card's Approve takes the focus, or the heading once none is left.
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;

    const next = box.current?.querySelector<HTMLButtonElement>(':scope > .decision-card [data-variant="primary"]');

    (next ?? heading?.current)?.focus({ preventScroll: true });
  }, [top?.id, heading]);

  const onLeft = (event: AnimationEvent) => {
    if (event.target === event.currentTarget) setLeaving(null);
  };

  if (top === undefined && leaving === null) return <Problem text={refused} />;

  return (
    <section className="desk-deck-group" aria-label="Only you can decide">
      <header className="desk-section-head">
        <h2>Only you can decide</h2>
        <p className="desk-keys" aria-hidden>
          <kbd>Y</kbd> Yes <kbd>N</kbd> No <kbd>L</kbd> Later
        </p>
      </header>
      <div
        ref={box}
        className="desk-deck"
        data-instant={instant}
        data-behind={Math.max(Math.min(deck.length - 1, 2), 0)}
        onClickCapture={(event) => {
          // A double tap's second press would land on the card that took the answered one's place.
          if (event.detail > 1) {
            event.preventDefault();
            event.stopPropagation();

            return;
          }

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
