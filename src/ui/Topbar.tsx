import type { BlobVariantId } from "./blob-catalog";
import { BotAvatar } from "./BotAvatar";
import { Icon } from "./Icon";
import type { OpenChat } from "./open-chat";
import type { PanelState } from "./use-panel";

/** The chats drawer, below the wide layout. */
type Drawer = {
  readonly open: boolean;
  readonly onOpen: () => void;
};

/** The agent pill's view of the panel it opens. */
type PillPanel = Pick<PanelState, "whoRef" | "open" | "shown" | "toggle">;

/** How the connection is doing, in words. */
type Status = { readonly label: string; readonly connected: boolean };

// In ky's chats, the drawer of chats (below the wide layout); in a subagent's, the way back.
function NavButton({ talksToMain, drawer, onBack }: { talksToMain: boolean; drawer: Drawer; onBack: () => void }) {
  if (!talksToMain) {
    return (
      <button type="button" className="icon-button pressable" aria-label="Back to the main chat" onClick={onBack}>
        <Icon name="arrowLeft" size={18} />
      </button>
    );
  }

  return (
    <button
      type="button"
      className="icon-button pressable drawer-toggle"
      aria-label="Chats"
      aria-expanded={drawer.open}
      onClick={drawer.onOpen}
    >
      <Icon name="menu" size={18} />
    </button>
  );
}

// The agent pill: who is talking and how it is connected. A click shows or hides the panel.
function Who({
  speaker,
  variantId,
  running,
  status,
  sub,
  panel,
}: {
  speaker: string;
  variantId: BlobVariantId | undefined;
  running: boolean;
  status: Status;
  sub: string;
  panel: PillPanel;
}) {
  return (
    <button
      type="button"
      ref={panel.whoRef}
      className="who pressable"
      aria-expanded={panel.shown}
      aria-label={`${speaker}: ${status.label}. ${panel.open ? "Hide" : "Show"} activity`}
      onClick={panel.toggle}
    >
      <BotAvatar name={speaker} variantId={variantId} active={running} size={28} />
      <span className="who-text">
        <span className="who-name">
          {speaker}
          <span className="status-dot" data-connected={status.connected} />
        </span>
        <span className="who-sub">{sub}</span>
      </span>
    </button>
  );
}

export type TopbarProps = {
  /** The open chat: who is talking, and whether it is ky. */
  open: Pick<OpenChat, "talksToMain" | "speaker">;
  /** ky's own blob; a subagent's comes from its name. */
  variantId: BlobVariantId | undefined;
  running: boolean;
  status: Status;
  /** The line under the name. */
  sub: string;
  drawer: Drawer;
  onBack: () => void;
  panel: PillPanel;
  /** A newer deploy is serving; offer to reload. */
  updated: boolean;
};

export function Topbar({ open, variantId, running, status, sub, drawer, onBack, panel, updated }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="topbar-side">
        <NavButton talksToMain={open.talksToMain} drawer={drawer} onBack={onBack} />
      </div>
      <Who speaker={open.speaker} variantId={variantId} running={running} status={status} sub={sub} panel={panel} />
      <div className="topbar-side end">
        {updated ? (
          <button type="button" className="pill pressable" onClick={() => location.reload()}>
            Reload
          </button>
        ) : null}
      </div>
    </header>
  );
}
