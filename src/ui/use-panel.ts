import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { wide } from "./layout";
import type { PanelTab } from "./Panel";

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
  /** Open Settings at one of its sections, by its element id, and put focus in it. */
  readonly openSection: (id: string) => void;
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

/** How long to wait for a Settings section to render before giving up on scrolling to it. */
const REVEAL_FRAMES = 30;

// Scroll a Settings section into view once it renders, and focus its first field or button.
function reveal(id: string, frames = REVEAL_FRAMES) {
  requestAnimationFrame(() => {
    const section = document.getElementById(id);

    if (section === null) {
      if (frames > 0) reveal(id, frames - 1);

      return;
    }

    section.scrollIntoView({ block: "start", behavior: "smooth" });
    section.querySelector<HTMLElement>("input, select, button")?.focus({ preventScroll: true });
  });
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
    openSection: (id) => {
      setTab("settings");
      setOpen(true);
      reveal(id);
    },
    settle,
    whoRef,
    panelRef
  };
}
