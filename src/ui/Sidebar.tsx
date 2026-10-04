import type { ChatRow } from "../protocol";
import { ago } from "./time";
import { Icon } from "./Icon";

// The chats you talk to ky in: the main one, then side chats. They share one memory.
export function Sidebar({
  chats,
  session,
  main,
  now,
  onOpen,
  onNew,
  onSearch,
  creating,
}: {
  chats: readonly ChatRow[];
  session: string;
  main: string;
  now: number;
  onOpen: (session: string) => void;
  onNew: () => void;
  onSearch: () => void;
  creating: boolean;
}) {
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
      {chats.length === 0 ? (
        <p className="sidebar-empty">Start one for a tangent. It remembers what the main chat does.</p>
      ) : (
        <ul className="chat-list" data-scroll>
          {chats.map((chat) => (
            <li key={chat.session}>
              <button
                type="button"
                className="chat-item pressable"
                aria-current={session === chat.session ? "page" : undefined}
                onClick={() => onOpen(chat.session)}
              >
                <span className="chat-title" data-untitled={chat.title === ""}>
                  {chat.title || "New chat"}
                </span>
                <span className="chat-time tabular">{ago(chat.updated_at, now)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
