import { useState } from "react";
import { wide } from "./layout";
import type { PanelState } from "./use-panel";
import { useShortcuts } from "./use-shortcuts";

export type Shell = {
  /** Only below the wide layout: above it the sidebar is there unless hidden. */
  readonly drawerOpen: boolean;
  readonly setDrawerOpen: (open: boolean) => void;
  /** In the wide layout, the user hid the sidebar; remembered across visits. */
  readonly sidebarHidden: boolean;
  /** Hide or show the sidebar where it sits beside the chat; below that, open or close the drawer. */
  readonly toggleSidebar: () => void;
  /** Bring the chats out: the sidebar where it was hidden, or the drawer. */
  readonly showChats: () => void;
  readonly paletteOpen: boolean;
  readonly setPaletteOpen: (open: boolean) => void;
  /** A side chat is being created. */
  readonly creating: boolean;
  /** Goes to a chat, closing whatever slides over it. */
  readonly openSession: (session: string) => void;
  /** Creates a side chat and opens it. */
  readonly startChat: () => void;
};

/** Where the wide layout remembers whether the sidebar is hidden. */
const SIDEBAR_KEY = "ky:sidebar";

// What slides over the chat (the drawer, the palette) and moving between chats.
export function useShell(go: (session: string) => void, panel: PanelState, newChat: () => Promise<string>): Shell {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(() => localStorage.getItem(SIDEBAR_KEY) === "hidden");

  const hideSidebar = (hidden: boolean) => {
    setSidebarHidden(hidden);
    localStorage.setItem(SIDEBAR_KEY, hidden ? "hidden" : "shown");
  };

  const toggleSidebar = () => (wide() ? hideSidebar(!sidebarHidden) : setDrawerOpen((open) => !open));
  const showChats = () => (wide() ? hideSidebar(false) : setDrawerOpen(true));

  // Escape closes whatever is sliding over the chat; ⌘K opens the palette from anywhere.
  useShortcuts(
    () => setPaletteOpen((open) => !open),
    () => {
      if (paletteOpen || wide()) return;
      setDrawerOpen(false);
      panel.setOpen(false);
    }
  );

  const openSession = (next: string) => {
    setDrawerOpen(false);

    if (!wide()) panel.setOpen(false);
    go(next);
  };

  const startChat = () => {
    setCreating(true);
    newChat()
      .then(openSession)
      .catch(() => undefined)
      .finally(() => setCreating(false));
  };

  return { drawerOpen, setDrawerOpen, sidebarHidden, toggleSidebar, showChats, paletteOpen, setPaletteOpen, creating, openSession, startChat };
}
