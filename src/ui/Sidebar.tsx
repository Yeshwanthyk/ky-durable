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
  now,
  onOpen,
  onArchive,
}: {
  chat: ChatRow;
  current: boolean;
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
        onClick={() => onOpen(chat.session)}
      >
        <span className="chat-title" data-untitled={chat.title === ""}>
          {title}
        </span>
        <span className="chat-time tabular">{ago(chat.updated_at, now)}</span>
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
            onClick={() => onOpen(main)}
          >
            <span className="chat-title">Main chat</span>
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
