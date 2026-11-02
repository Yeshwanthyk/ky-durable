import { createContext, useCallback, useContext, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../chat-kit/Icon";
import { useDismiss } from "./use-dismiss";

/** The spot at the right of a Settings page's head where its "+" goes; null until the head is drawn. */
export const PageAddSlot = createContext<{ slot: HTMLElement | null; setSlot: (slot: HTMLElement | null) => void }>({ slot: null, setSlot: () => undefined });

/** One thing a page's "+" adds: what its menu item says, and what choosing it does. */
export type AddChoice = { label: string; onChoose: () => void };

// A page's "+": a small button in its head that opens a menu of what the page can add. Whichever section owns the form
// draws it, so the form keeps its own state; the menu closes on a click outside or Escape, and that Escape stays off the page.
export function PageAdd({ label, choices }: { label: string; choices: readonly AddChoice[] }) {
  const { slot } = useContext(PageAddSlot);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useDismiss(open, root, close);

  if (slot === null || choices.length === 0) return null;

  return createPortal(
    <div
      className="page-add"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) event.preventDefault();
      }}
    >
      <button type="button" className="page-add-button pressable" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="plus" size={15} />
      </button>
      {open ? (
        <div className="group-menu page-add-menu" role="menu" aria-label={label}>
          {choices.map((choice) => (
            <button
              key={choice.label}
              type="button"
              role="menuitem"
              className="group-option pressable"
              onClick={() => {
                setOpen(false);
                choice.onChoose();
              }}
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>,
    slot,
  );
}
