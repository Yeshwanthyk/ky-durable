import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Activity } from "./activity";
import { Icon } from "./Icon";

/** How long an outgoing subtitle takes to fade; matches shell.css. */
const FADE_MS = 220;

type Line = { readonly key: number; readonly text: string; readonly activity: Activity | null };

/**
 * The header pill's subtitle: what the agent is doing while it works, its usual line otherwise.
 * A change cross-fades; the pill resizes to fit (see useFitWidth).
 */
export function WhoSub({ activity, idle }: { activity: Activity | null; idle: string }) {
  const counter = useRef(0);
  const text = activity?.label ?? idle;
  const [current, setCurrent] = useState<Line>({ key: 0, text, activity });
  const [previous, setPrevious] = useState<Line | null>(null);

  useEffect(() => {
    if (current.text === text) return;
    setPrevious(current);
    setCurrent({ key: ++counter.current, text, activity });
    // Only new words are a new line; a new object with the same words is not.
  }, [text]);

  useEffect(() => {
    if (previous === null) return;
    const timer = setTimeout(() => setPrevious(null), FADE_MS);

    return () => clearTimeout(timer);
  }, [previous]);

  return (
    <span className="who-sub">
      {previous ? <SubLine key={previous.key} line={previous} out /> : null}
      <SubLine key={current.key} line={current} animate={current.key > 0} />
    </span>
  );
}

function SubLine({ line, out = false, animate = true }: { line: Line; out?: boolean; animate?: boolean }) {
  return (
    <span
      className="who-sub-line"
      data-out={out}
      data-animate={animate}
      data-busy={line.activity !== null}
      aria-hidden={out}
    >
      {line.activity ? <Icon name={line.activity.icon} size={11} /> : null}
      <span className="who-sub-text">{line.text}</span>
    </span>
  );
}

/**
 * Sizes an element to its content's natural width as an explicit pixel width, so CSS can
 * transition it; `width: auto` does not animate everywhere (iOS Safari).
 */
export function useFitWidth(outer: RefObject<HTMLElement | null>, inner: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    // offsetWidth ignores the press scale on the pill; +1 covers its rounding.
    const fit = () => {
      const style = getComputedStyle(box);
      const chrome =
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight) +
        parseFloat(style.borderLeftWidth) +
        parseFloat(style.borderRightWidth);
      box.style.width = `${Math.ceil(content.offsetWidth + 1 + chrome)}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(content);

    return () => observer.disconnect();
  }, [outer, inner]);
}
