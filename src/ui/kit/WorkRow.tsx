import { type MouseEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../chat-kit/Icon";
import { type GlyphStatus, StatusGlyph } from "./StatusGlyph";

/** A row's lead: a status glyph for work, or any icon for what ky changed. */
export type RowMark = { readonly status: GlyphStatus } | { readonly icon: ReactNode };

type RowProps = RowMark & {
  /** The row's name for screen readers. */
  readonly label: string;
  /** Gets the row's full width; may be a button of its own when there is no `detail`. */
  readonly title: ReactNode;
  /** One quiet line under the title. */
  readonly meta?: ReactNode;
  /** Words or actions in the slot at the row's end; only words when the row has `detail`, as the row is then a button. */
  readonly trailing?: ReactNode;
  /** What the row shows when it opens; without one the row doesn't open. */
  readonly detail?: ReactNode;
  /** Marks the row done with, as an undone change: its title is struck through. */
  readonly settled?: boolean;
};

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The rows after this one in its list: what moves when it opens or closes. */
const below = (row: Element | null) => {
  const rows: HTMLElement[] = [];

  for (let next = row?.nextElementSibling; next instanceof HTMLElement; next = next.nextElementSibling) rows.push(next);

  return rows;
};

/** A row's duration and easing from the tokens, read off the page so the CSS stays their one home. */
function motion(row: Element): KeyframeAnimationOptions {
  const style = getComputedStyle(row);

  return { duration: Number.parseFloat(style.getPropertyValue("--enter")) || 200, easing: style.getPropertyValue("--ease-in-out").trim() || "ease-in-out" };
}

// A piece of work in a list: its glyph, a title with the whole width, a quiet line under it, and a fixed slot at the end
// for its word or actions. One with detail opens; the rows below slide to their new place (FLIP), unless the row was
// opened from the keyboard or motion is reduced.
export function WorkRow(props: RowProps) {
  const { label, title, meta, trailing, detail, settled } = props;
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const tops = useRef<ReadonlyMap<HTMLElement, number> | null>(null);

  useLayoutEffect(() => {
    const before = tops.current;
    tops.current = null;

    if (before === null || row.current === null) return;

    const options = motion(row.current);

    for (const [moved, top] of before) {
      const shift = top - moved.getBoundingClientRect().top;

      if (shift !== 0) moved.animate([{ transform: `translateY(${shift}px)` }, { transform: "none" }], options);
    }
  }, [open]);

  const toggle = (event: MouseEvent) => {
    // A click from Enter or Space has no pointer detail.
    const keyboard = event.detail === 0;
    const moving = below(row.current);
    moving.forEach((moved) => moved.getAnimations().forEach((animation) => animation.cancel()));
    tops.current = keyboard || reduced() ? null : new Map(moving.map((moved) => [moved, moved.getBoundingClientRect().top]));
    setInstant(keyboard);
    setOpen(!open);
  };

  const lead = <span className="kit-work-lead">{"status" in props ? <StatusGlyph status={props.status} /> : props.icon}</span>;

  const text = (
    <span className="kit-work-text">
      <span className="kit-work-title">{title}</span>
      {meta === undefined ? null : <span className="kit-work-meta">{meta}</span>}
    </span>
  );

  const trail = trailing === undefined ? null : <span className="kit-work-trail">{trailing}</span>;

  return (
    <li ref={row} className="kit-work" aria-label={label} data-open={open || undefined} data-settled={settled || undefined}>
      {detail === undefined ? (
        <div className="kit-work-row">
          {lead}
          {text}
          {trail}
        </div>
      ) : (
        <button type="button" className="kit-work-row kit-work-opener" aria-expanded={open} onClick={toggle}>
          {lead}
          {text}
          {trail}
          <Icon name="chevronRight" size={12} className="kit-work-chevron" />
        </button>
      )}
      {open && detail !== undefined ? (
        <div className="kit-work-detail" data-instant={instant || undefined}>
          {detail}
        </div>
      ) : null}
    </li>
  );
}
