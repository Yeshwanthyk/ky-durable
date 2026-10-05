import { useState } from "react";
import type { PanelState } from "./use-panel";
import { wide } from "./use-panel";
import { useShortcuts } from "./use-shortcuts";

export type Shell = {
  /** Only below the wide layout: above it the sidebar is always there. */
  readonly drawerOpen: boolean;
  readonly setDrawerOpen: (open: boolean) => void;
  readonly paletteOpen: boolean;
  readonly setPaletteOpen: (open: boolean) => void;
  /** A side chat is being created. */
  readonly creating: boolean;
  /** Goes to a chat, closing whatever slides over it. */
  readonly openSession: (session: string) => void;
  /** Creates a side chat and opens it. */
  readonly startChat: () => void;
};

// What slides over the chat (the drawer, the palette) and moving between chats.
export function useShell(go: (session: string) => void, panel: PanelState, newChat: () => Promise<string>): Shell {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);

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

  return { drawerOpen, setDrawerOpen, paletteOpen, setPaletteOpen, creating, openSession, startChat };
}
