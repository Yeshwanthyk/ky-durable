import { useRef } from "react";
import type { Activity } from "./activity";
import type { BlobVariantId } from "./blob-catalog";
import { BotAvatar } from "./BotAvatar";
import { KY_AVATAR } from "../avatar-spec";
import { CrewCount, CrewRow, crewSays, kyGaze } from "./Crew";
import type { Crew } from "./crew-of";
import { type Group, GroupMembers } from "./GroupMembers";
import { Icon } from "./Icon";
import type { OpenChat } from "./open-chat";
import type { PanelState } from "./use-panel";
import { useChanges } from "./use-changes";
import { useFitWidth, WhoSub } from "./WhoSub";

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

// The agent pill: who is talking, how it is connected, and what it is doing, with the specialists
// working for the chat sat beside it. A click shows or hides the panel.
function Who({
  speaker,
  variantId,
  running,
  status,
  sub,
  activity,
  panel,
  crew,
}: {
  speaker: string;
  variantId: BlobVariantId | undefined;
  running: boolean;
  status: Status;
  sub: string;
  activity: Activity | null;
  panel: PillPanel;
  crew: Crew;
}) {
  const innerRef = useRef<HTMLSpanElement>(null);
  useFitWidth(panel.whoRef, innerRef);
  // The dot pops when the connection changes on screen, not when it is first drawn.
  const reconnected = useChanges(status.connected) > 0;

  return (
    <button
      type="button"
      ref={panel.whoRef}
      className="who pressable"
      data-busy={activity !== null}
      aria-expanded={panel.shown}
      aria-label={`${speaker}: ${status.label}.${crewSays(crew)} ${panel.open ? "Hide" : "Show"} activity`}
      onClick={panel.toggle}
    >
      <span className="who-inner" ref={innerRef}>
        <span className="who-faces">
          <BotAvatar name={speaker} variantId={variantId} owner={variantId && KY_AVATAR} active={running} gaze={kyGaze(crew)} size={28} />
          <CrewRow faces={crew.faces} />
        </span>
        <span className="who-text">
          <span className="who-name">
            {speaker}
            <span className="status-dot" data-connected={status.connected} data-pop={reconnected} />
            <CrewCount crew={crew} />
          </span>
          <WhoSub activity={activity} idle={sub} />
        </span>
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
  /** The line under the name while idle. */
  sub: string;
  /** What the agent is doing now, shown in place of `sub`. */
  activity: Activity | null;
  drawer: Drawer;
  onBack: () => void;
  panel: PillPanel;
  /** A newer deploy is serving; offer to reload. */
  updated: boolean;
  /** The chat's specialists, when there are specialists to have. */
  group?: Group;
  /** The specialists working for the chat now, sat in the pill. */
  crew: Crew;
};

export function Topbar({ open, variantId, running, status, sub, activity, drawer, onBack, panel, updated, group, crew }: TopbarProps) {
  return (
    <header className="topbar">
      <div className="topbar-side">
        <NavButton talksToMain={open.talksToMain} drawer={drawer} onBack={onBack} />
      </div>
      <Who speaker={open.speaker} variantId={variantId} running={running} status={status} sub={sub} activity={activity} panel={panel} crew={crew} />
      <div className="topbar-side end">
        {updated ? (
          <button type="button" className="pill pressable" onClick={() => location.reload()}>
            Reload
          </button>
        ) : null}
        {group && group.specialists.length > 0 ? <GroupMembers {...group} /> : null}
      </div>
    </header>
  );
}
