import { type ReactNode, useRef, useState } from "react";
import type { ChatRow } from "../protocol";
import { ago } from "./time";
import { Icon } from "./Icon";
import { useChanges } from "./use-changes";

const ARCHIVE = { label: "Archive", icon: "archive" } as const;

const UNARCHIVE = { label: "Unarchive", icon: "unarchive" } as const;

/** How new a side chat must be to slide into the list rather than just be there. */
const FRESH_MS = 10_000;

// Whether a chat just gained news on screen, so its dot pops in and the row glows once.
// One that loads with a dot already shows it; `ready` is false until its time has arrived.
function useNews(unread: boolean, ready = true) {
  return useChanges(unread, ready) > 0 && unread;
}

// A side chat's name, being typed in place of its title. Enter or leaving it saves; Escape keeps the old one.
function RenameField({ title, onDone }: { title: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(title);
  // Enter ends it, then the field's removal blurs it; only the first counts.
  const ended = useRef(false);

  const done = (save: boolean) => {
    if (ended.current) return;

    ended.current = true;
    onDone(save && value.trim() !== "" && value.trim() !== title ? value : null);
  };

  return (
    <input
      className="chat-item chat-rename-field"
      aria-label="Chat name"
      value={value}
      maxLength={200}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") done(true);
        else if (event.key === "Escape") {
          // Escape here only cancels the rename, not whatever slides over the chat.
          event.stopPropagation();
          done(false);
        }
      }}
    />
  );
}

// One side chat in the list, with the buttons that rename it and archive it or put it back.
function SideChat({
  chat,
  current,
  unread,
  now,
  onOpen,
  onArchive,
  onRename,
}: {
  chat: ChatRow;
  current: boolean;
  unread: boolean;
  now: number;
  onOpen: (session: string) => void;
  onArchive: (session: string, archived: boolean) => Promise<void>;
  onRename: (session: string, title: string) => Promise<void>;
}) {
  const archived = chat.archived_at !== null;
  const action = archived ? UNARCHIVE : ARCHIVE;
  const news = useNews(unread);
  // A chat started moments ago opens its own space in the list; one there on load just shows.
  const [fresh] = useState(() => Date.now() - chat.created_at < FRESH_MS);
  const [editing, setEditing] = useState(false);
  // The name just given, shown until the list brings it back from the server.
  const [named, setNamed] = useState<string | null>(null);
  const [heard, setHeard] = useState(chat.title);

  if (heard !== chat.title) {
    setHeard(chat.title);
    setNamed(null);
  }

  const title = named ?? (chat.title || "New chat");

  if (editing) {
    return (
      <li className="chat-row">
        <RenameField
          title={chat.title}
          onDone={(next) => {
            setEditing(false);

            if (next === null) return;

            setNamed(next.trim());
            // The sidebar says why it failed; the row goes back to the name it has.
            onRename(chat.session, next).catch(() => setNamed(null));
          }}
        />
      </li>
    );
  }

  return (
    <li className="chat-row" data-fresh={fresh}>
      <button
        type="button"
        className="chat-item pressable pressable-row"
        aria-current={current ? "page" : undefined}
        data-unread={unread}
        data-news={news}
        onClick={() => onOpen(chat.session)}
        onDoubleClick={() => setEditing(true)}
      >
        <span className="chat-title" data-untitled={named === null && chat.title === ""}>
          {title}
        </span>
        <ChatTime time={chat.updated_at} unread={unread} news={news} now={now} />
      </button>
      <span className="chat-actions">
        <button
          type="button"
          className="icon-button pressable chat-rename"
          aria-label={`Rename ${title}`}
          title="Rename"
          onClick={() => setEditing(true)}
        >
          <Icon name="pencil" size={14} />
        </button>
        <button
          type="button"
          className="icon-button pressable chat-archive"
          aria-label={`${action.label} ${title}`}
          title={action.label}
          onClick={() => onArchive(chat.session, !archived).catch(() => undefined)}
        >
          <Icon name={action.icon} size={14} />
        </button>
      </span>
    </li>
  );
}

// When the chat last moved, with a dot when it has news the user has not opened.
function ChatTime({ time, unread, news, now }: { time: number; unread: boolean; news: boolean; now: number }) {
  return (
    <>
      {unread ? <span className="chat-unread" data-pop={news} role="img" aria-label="New" /> : null}
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
        className="sidebar-head sidebar-toggle pressable pressable-row"
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
  onRename,
  creating,
  error,
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
  onArchive: (session: string, archived: boolean) => Promise<void>;
  onRename: (session: string, title: string) => Promise<void>;
  creating: boolean;
  /** Why the last side chat change failed. */
  error: string | null;
}) {
  const active = chats.filter((chat) => chat.archived_at === null);
  const archived = chats.filter((chat) => chat.archived_at !== null);
  const mainUnread = unread(main);
  const mainNews = useNews(mainUnread, mainUpdatedAt > 0);

  const row = (chat: ChatRow) => (
    <SideChat
      key={chat.session}
      chat={chat}
      current={session === chat.session}
      unread={unread(chat.session)}
      now={now}
      onOpen={onOpen}
      onArchive={onArchive}
      onRename={onRename}
    />
  );

  return (
    <nav className="sidebar" aria-label="Chats">
      <button type="button" className="sidebar-search pressable pressable-row" onClick={onSearch}>
        <Icon name="search" size={14} />
        <span>Search</span>
        <kbd className="palette-kbd">⌘K</kbd>
      </button>
      <ul className="chat-list">
        <li>
          <button
            type="button"
            className="chat-item pressable pressable-row"
            aria-current={session === main ? "page" : undefined}
            data-unread={mainUnread}
            data-news={mainNews}
            onClick={() => onOpen(main)}
          >
            <span className="chat-title">Main chat</span>
            <ChatTime time={mainUpdatedAt} unread={mainUnread} news={mainNews} now={now} />
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
      {error ? (
        <p className="sidebar-error" role="alert">
          {error}
        </p>
      ) : null}
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
