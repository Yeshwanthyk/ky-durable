import type { RefObject } from "react";
import type { BlobVariantId } from "./blob-catalog";
import { BotAvatar } from "./BotAvatar";
import { Icon } from "./Icon";

// In ky's chats, the drawer of chats (below the wide layout); in a subagent's, the way back.
function NavButton({
  talksToMain,
  drawerOpen,
  onDrawer,
  onBack,
}: {
  talksToMain: boolean;
  drawerOpen: boolean;
  onDrawer: () => void;
  onBack: () => void;
}) {
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
      aria-expanded={drawerOpen}
      onClick={onDrawer}
    >
      <Icon name="menu" size={18} />
    </button>
  );
}

// The agent pill: who is talking and how it is connected. A click shows or hides the panel.
function Who({
  whoRef,
  speaker,
  variantId,
  running,
  status,
  sub,
  panelOpen,
  panelShown,
  onToggle,
}: {
  whoRef: RefObject<HTMLButtonElement | null>;
  speaker: string;
  /** ky's own blob; a subagent's comes from its name. */
  variantId: BlobVariantId | undefined;
  running: boolean;
  status: { label: string; connected: boolean };
  /** The line under the name. */
  sub: string;
  panelOpen: boolean;
  panelShown: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      ref={whoRef}
      className="who pressable"
      aria-expanded={panelShown}
      aria-label={`${speaker}: ${status.label}. ${panelOpen ? "Hide" : "Show"} activity`}
      onClick={onToggle}
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

export type TopbarProps = Parameters<typeof NavButton>[0] &
  Parameters<typeof Who>[0] & {
    /** A newer deploy is serving; offer to reload. */
    updated: boolean;
  };

export function Topbar(props: TopbarProps) {
  return (
    <header className="topbar">
      <div className="topbar-side">
        <NavButton {...props} />
      </div>
      <Who {...props} />
      <div className="topbar-side end">
        {props.updated ? (
          <button type="button" className="pill pressable" onClick={() => location.reload()}>
            Reload
          </button>
        ) : null}
      </div>
    </header>
  );
}
