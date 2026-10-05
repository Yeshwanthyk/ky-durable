import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { PanelTab } from "./Panel";

/** The sidebar and panel sit beside the chat from this width; below it they slide over it. */
const WIDE = "(min-width: 1024px)";

export const wide = () => window.matchMedia(WIDE).matches;

export type PanelState = {
  /** On screen, including while it pours back into the agent pill. */
  readonly open: boolean;
  /** Kept on screen while it pours back into the agent pill. */
  readonly closing: boolean;
  /** Only a click plays the genie; the panel that is open on load just sits there. */
  readonly genie: boolean;
  /** Open and staying open. */
  readonly shown: boolean;
  readonly tab: PanelTab;
  readonly setTab: (tab: PanelTab) => void;
  readonly setOpen: (open: boolean) => void;
  readonly toggle: () => void;
  readonly openTab: (tab: PanelTab) => void;
  /** Ends the genie: the closing panel goes away, the opening one stays. */
  readonly settle: () => void;
  readonly whoRef: RefObject<HTMLButtonElement | null>;
  readonly panelRef: RefObject<HTMLDivElement | null>;
};

// The genie pours out of the agent pill: aim the panel's narrow end at it.
function aim(panel: HTMLDivElement | null, who: HTMLButtonElement | null) {
  if (panel === null || who === null) return;
  const from = who.getBoundingClientRect();
  const to = panel.getBoundingClientRect();
  panel.style.setProperty("--genie-x", `${from.left + from.width / 2 - (to.left + to.width / 2)}px`);
  panel.style.setProperty("--genie-y", `${from.top + from.height / 2 - to.top}px`);
}

// The activity and settings panel: which tab, and opening and closing it with the genie.
export function usePanel(): PanelState {
  const [open, setOpenState] = useState(wide);
  const [closing, setClosing] = useState(false);
  const [genie, setGenie] = useState(false);
  const [tab, setTab] = useState<PanelTab>("activity");
  const whoRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const shown = open && !closing;

  const setOpen = (next: boolean) => {
    if (next === shown) return;
    setGenie(true);

    if (next) {
      setClosing(false);
      setOpenState(true);
    } else if (open) setClosing(true);
  };

  const settle = () => {
    if (closing) {
      setClosing(false);
      setOpenState(false);
    }

    setGenie(false);
  };

  // animationend normally ends the genie, but a tab that is not painting never runs it, so
  // settle it anyway a little after it should have finished. A click mid-way restarts the wait.
  useEffect(() => {
    if (!genie) return;

    const timer = setTimeout(settle, 600);

    return () => clearTimeout(timer);
  }, [genie, closing]);

  useLayoutEffect(() => {
    if (open && genie) aim(panelRef.current, whoRef.current);
  }, [open, closing, genie]);

  return {
    open,
    closing,
    genie,
    shown,
    tab,
    setTab,
    setOpen,
    toggle: () => setOpen(!shown),
    openTab: (next) => {
      setTab(next);
      setOpen(true);
    },
    settle,
    whoRef,
    panelRef
  };
}
