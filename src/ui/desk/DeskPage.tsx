import { useContext, useEffect, useRef } from "react";
import { Icon } from "../../chat-kit/Icon";
import type { BlobVariantId } from "../blob-catalog";
import { ApprovalsContext, useNeedingYou } from "../Approvals";
import { BotAvatar } from "../BotAvatar";
import { Desk } from "../Desk";
import { LastNight } from "../LastNight";
import { NAME } from "../open-chat";
import { Deck } from "./Deck";

const WORDS = ["One thing needs", "Two things need", "Three things need", "Four things need", "Five things need", "Six things need", "Seven things need", "Eight things need", "Nine things need"];

/** The greeting's one line: how many things wait on the user, in words while there are few. */
export const needsYou = (count: number) => (count === 0 ? "Nothing needs you" : `${WORDS[count - 1] ?? `${count} things need`} you`);

// What needs the user across every chat, then what ky did last night and what it is keeping track of. ky's bloub
// greets with how many things wait; with none, it says so and the rest of the page stays.
export function DeskPage({ now, variantId, onOpen, onChats }: { now: number; variantId: BlobVariantId; onOpen: (session: string) => void; onChats: () => void }) {
  const { approvals, waiting } = useContext(ApprovalsContext);
  const deck = useNeedingYou(approvals, waiting);
  const heading = useRef<HTMLHeadingElement>(null);

  // Opening the page puts the keyboard on it, so Y, N and L answer from the first key.
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);

  return (
    <section className="stage artifacts desk-page" aria-label="Desk">
      <header className="artifacts-head">
        <button type="button" className="icon-button pressable drawer-toggle" aria-label="Chats" onClick={onChats}>
          <Icon name="menu" size={18} />
        </button>
      </header>
      <div className="desk-scroll" data-scroll>
        <div className="desk-column">
          <header className="desk-greeting" data-clear={deck.length === 0}>
            <BotAvatar owner="ky" name={NAME} variantId={variantId} size={deck.length === 0 ? 56 : 36} />
            <h1 ref={heading} tabIndex={-1} aria-live="polite">
              {needsYou(deck.length)}
            </h1>
          </header>
          {/* Mounted while empty, so the last card can finish leaving; it draws nothing once it has. */}
          <Deck deck={deck} heading={heading} />
          <LastNight now={now} />
          <Desk now={now} onOpen={onOpen} />
        </div>
      </div>
    </section>
  );
}
