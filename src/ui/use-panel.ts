import { createContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Purpose } from "../protocol";
import { wide } from "./layout";
import type { PanelTab } from "./Panel";

/** Which page of Settings is showing: its list of groups, a group, or one model choice or machine. */
export type SettingsPage =
  | { readonly kind: "home" }
  | { readonly kind: "models" }
  | { readonly kind: "model"; readonly purpose: Purpose }
  | { readonly kind: "providers" }
  | { readonly kind: "machines" }
  | { readonly kind: "machine"; readonly name: string }
  | { readonly kind: "subscriptions" }
  | { readonly kind: "peers" }
  | { readonly kind: "mail" }
  | { readonly kind: "inbound" }
  | { readonly kind: "proactivity" }
  | { readonly kind: "spend" }
  | { readonly kind: "tools" }
  | { readonly kind: "appearance" }
  | { readonly kind: "self-edits" };

export const SETTINGS_HOME: SettingsPage = { kind: "home" };

/** The page each Settings section is on, by its element id. */
const SECTION_PAGES = new Map<string, SettingsPage>([
  ["settings-providers", { kind: "providers" }],
  ["settings-subscriptions", { kind: "subscriptions" }],
  ["settings-machines", { kind: "machines" }],
  ["settings-executor", { kind: "tools" }],
  ["settings-peers", { kind: "peers" }],
  ["settings-mail", { kind: "mail" }],
  ["settings-inbound", { kind: "inbound" }],
  ["settings-proactivity", { kind: "proactivity" }],
  ["settings-spend", { kind: "spend" }]
]);

/** Settings' page, moving between its pages, and opening the page a section is on. */
type SettingsNav = {
  readonly page: SettingsPage;
  readonly go: (page: SettingsPage) => void;
  /** Open Settings at one of its sections, by its element id, and put focus in it. */
  readonly openSection: (id: string) => void;
};

/** Settings' pages, provided around the panel; links inside it open a section with openSection. */
export const SettingsNavContext = createContext<SettingsNav>({ page: SETTINGS_HOME, go: () => undefined, openSection: (id) => reveal(id) });

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
  readonly page: SettingsPage;
  readonly setPage: (page: SettingsPage) => void;
  readonly setOpen: (open: boolean) => void;
  readonly toggle: () => void;
  readonly openTab: (tab: PanelTab) => void;
  /** Open Settings at one of its sections, by its element id, and put focus in it. */
  readonly openSection: (id: string) => void;
  readonly whoRef: RefObject<HTMLButtonElement | null>;
  readonly panelRef: RefObject<HTMLDivElement | null>;
};

/** chat.css's --ease-out; element.animate cannot read a CSS variable. */
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

/** iOS's drawer curve: quick off the mark and a long, soft landing. */
const IOS = "cubic-bezier(0.32, 0.72, 0, 1)";

/** Closing starts at full speed and lands without a long tail, so it never hangs before going. */
const BACK = "cubic-bezier(0.25, 0.8, 0.25, 1)";

/** How long each way takes: closing is quicker than opening. */
const OPEN_MS = 420;

const CLOSE_MS = 240;

/** Settles the genie if its animation never reports finishing; longer than the longest one. */
const SETTLE_MS = 600;

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Look = { readonly transform: string; readonly opacity: string };

const SHOWN: Look = { transform: "none", opacity: "1" };

// Where the panel is right now, mid-genie included.
function look(panel: HTMLElement): Look {
  const style = getComputedStyle(panel);

  return { transform: style.transform, opacity: style.opacity };
}

// The panel shrunk to the pill: one uniform scale, down to about the pill's width, its top centred on the pill.
// transform-origin is its top left (shell.css). offset* ignore the transform a genie mid-way has on it.
function inPill(panel: HTMLElement, who: HTMLElement | null): string {
  if (who === null) return "scale(0.6)";

  const pill = who.getBoundingClientRect();
  const scale = Math.min(Math.max(pill.width / panel.offsetWidth, 0.25), 0.6);
  const x = pill.left + pill.width / 2 - panel.offsetLeft - (panel.offsetWidth * scale) / 2;

  return `translate(${x}px, ${pill.top - panel.offsetTop}px) scale(${scale})`;
}

// Opens or closes the panel from `from`, where it is now. Returns its animations, the one to wait on first.
function pour(panel: HTMLElement, who: HTMLElement | null, closing: boolean, from: Look | null): Animation[] {
  const fill = "both";

  // Reduced motion: only a fade.
  if (reduced()) {
    const start = from ?? (closing ? SHOWN : { ...SHOWN, opacity: "0" });

    return [panel.animate({ opacity: [start.opacity, closing ? "0" : "1"] }, { duration: closing ? 120 : 180, easing: EASE_OUT, fill })];
  }

  // Docked on desktop, the panel is part of the page, so it only eases in and out from the side.
  if (wide()) {
    const aside: Look = { transform: "translateX(8px)", opacity: "0" };
    const start = from ?? (closing ? SHOWN : aside);
    const end = closing ? aside : SHOWN;

    return [panel.animate([start, end], { duration: closing ? 140 : 200, easing: EASE_OUT, fill })];
  }

  // Over the chat it is a card of its own, so it grows out of the pill and shrinks back into it.
  // Opacity runs on its own clock: opaque within the first frames, so the chat never shows through
  // the growing card, and opaque until most of the way back, so it fades only as it lands.
  const pill = inPill(panel, who);

  if (closing) {
    const start = from ?? SHOWN;

    return [
      panel.animate({ transform: [start.transform, pill] }, { duration: CLOSE_MS, easing: BACK, fill }),
      panel.animate({ opacity: [start.opacity, start.opacity, "0"], offset: [0, 0.4, 1] }, { duration: CLOSE_MS, fill })
    ];
  }

  const start = from ?? { transform: pill, opacity: "0" };

  return [
    panel.animate({ transform: [start.transform, "none"] }, { duration: OPEN_MS, easing: IOS, fill }),
    panel.animate({ opacity: [start.opacity, "1"] }, { duration: 50, fill })
  ];
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
  const [page, setPage] = useState<SettingsPage>(SETTINGS_HOME);
  const whoRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const motion = useRef<Animation[]>([]);
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

  // The genie's animation finishing ends it, but a tab that is not painting may never finish it, so
  // settle it anyway a little after it should have finished. A click mid-way restarts the wait.
  useEffect(() => {
    if (!genie) return;

    const timer = setTimeout(settle, SETTLE_MS);

    return () => clearTimeout(timer);
  }, [genie, closing]);

  // Play the genie whenever it turns around. Mid-way, the new one starts from where the old one has
  // got to, read off the panel, so a click mid-open closes it from there and one mid-close reopens it.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const playing = motion.current.some((animation) => animation.playState !== "finished");
    const from = playing && panel !== null ? look(panel) : null;

    for (const animation of motion.current) animation.cancel();
    motion.current = [];

    if (!genie || !open || panel === null) return;

    motion.current = pour(panel, whoRef.current, closing, from);
    // A cancelled one rejects: whatever replaced it settles instead.
    motion.current[0]?.finished.then(settle, () => undefined);
  }, [open, closing, genie]);

  return {
    open,
    closing,
    genie,
    shown,
    tab,
    setTab,
    page,
    setPage,
    setOpen,
    toggle: () => setOpen(!shown),
    openTab: (next) => {
      setTab(next);
      setOpen(true);
    },
    openSection: (id) => {
      setTab("settings");
      setPage(SECTION_PAGES.get(id) ?? SETTINGS_HOME);
      setOpen(true);
      reveal(id);
    },
    whoRef,
    panelRef
  };
}
