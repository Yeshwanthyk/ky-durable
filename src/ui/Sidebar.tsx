import { type ReactNode, useState } from "react";
import type { ChatRow } from "../protocol";
import { ago } from "./time";
import { Icon } from "./Icon";

const ARCHIVE = { label: "Archive", icon: "archive" } as const;

const UNARCHIVE = { label: "Unarchive", icon: "unarchive" } as const;

// One side chat in the list, with the button that archives it or puts it back.
function SideChat({
  chat,
  current,
  unread,
  now,
  onOpen,
  onArchive,
}: {
  chat: ChatRow;
  current: boolean;
  unread: boolean;
  now: number;
  onOpen: (session: string) => void;
  onArchive: (session: string, archived: boolean) => void;
}) {
  const archived = chat.archived_at !== null;
  const title = chat.title || "New chat";
  const action = archived ? UNARCHIVE : ARCHIVE;

  return (
    <li className="chat-row">
      <button
        type="button"
        className="chat-item pressable"
        aria-current={current ? "page" : undefined}
        data-unread={unread}
        onClick={() => onOpen(chat.session)}
      >
        <span className="chat-title" data-untitled={chat.title === ""}>
          {title}
        </span>
        <ChatTime time={chat.updated_at} unread={unread} now={now} />
      </button>
      <button
        type="button"
        className="icon-button pressable chat-archive"
        aria-label={`${action.label} ${title}`}
        title={action.label}
        onClick={() => onArchive(chat.session, !archived)}
      >
        <Icon name={action.icon} size={14} />
      </button>
    </li>
  );
}

// When the chat last moved, with a dot when it has news the user has not opened.
function ChatTime({ time, unread, now }: { time: number; unread: boolean; now: number }) {
  return (
    <>
      {unread ? <span className="chat-unread" role="img" aria-label="New" /> : null}
      {time > 0 ? <span className="chat-time tabular">{ago(time, now)}</span> : null}
    </>
  );
}

// The archived side chats, folded away under their count.
function ArchivedChats({ chats, row }: { chats: readonly ChatRow[]; row: (chat: ChatRow) => ReactNode }) {
  const [open, setOpen] = useState(false);

  if (chats.length === 0) return null;

  return (
    <>
      <button
        type="button"
        className="sidebar-head sidebar-toggle pressable"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          Archived <span className="tabular">{chats.length}</span>
        </span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
      </button>
      {open ? (
        <ul className="chat-list" data-scroll>
          {chats.map(row)}
        </ul>
      ) : null}
    </>
  );
}

// The chats you talk to ky in: the main one, then side chats. They share one memory.
export function Sidebar({
  chats,
  session,
  main,
  mainUpdatedAt,
  unread,
  now,
  onOpen,
  onNew,
  onSearch,
  onArchive,
  creating,
}: {
  chats: readonly ChatRow[];
  session: string;
  main: string;
  /** When ky last answered in the main chat; 0 if never. */
  mainUpdatedAt: number;
  /** Whether a chat has news the user has not opened. */
  unread: (session: string) => boolean;
  now: number;
  onOpen: (session: string) => void;
  onNew: () => void;
  onSearch: () => void;
  onArchive: (session: string, archived: boolean) => void;
  creating: boolean;
}) {
  const active = chats.filter((chat) => chat.archived_at === null);
  const archived = chats.filter((chat) => chat.archived_at !== null);

  const row = (chat: ChatRow) => (
    <SideChat
      key={chat.session}
      chat={chat}
      current={session === chat.session}
      unread={unread(chat.session)}
      now={now}
      onOpen={onOpen}
      onArchive={onArchive}
    />
  );

  return (
    <nav className="sidebar" aria-label="Chats">
      <button type="button" className="sidebar-search pressable" onClick={onSearch}>
        <Icon name="search" size={14} />
        <span>Search</span>
        <kbd className="palette-kbd">⌘K</kbd>
      </button>
      <ul className="chat-list">
        <li>
          <button
            type="button"
            className="chat-item pressable"
            aria-current={session === main ? "page" : undefined}
            data-unread={unread(main)}
            onClick={() => onOpen(main)}
          >
            <span className="chat-title">Main chat</span>
            <ChatTime time={mainUpdatedAt} unread={unread(main)} now={now} />
          </button>
        </li>
      </ul>
      <div className="sidebar-head">
        <span>Side chats</span>
        <button
          type="button"
          className="icon-button pressable"
          aria-label="New side chat"
          title="New side chat"
          disabled={creating}
          onClick={onNew}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      {active.length === 0 ? (
        <p className="sidebar-empty">Start one for a tangent. It remembers what the main chat does.</p>
      ) : (
        <ul className="chat-list" data-scroll>
          {active.map(row)}
        </ul>
      )}
      <ArchivedChats chats={archived} row={row} />
    </nav>
  );
}
