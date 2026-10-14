import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

export type Command = {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly icon: IconName;
  /** Shown at the right, like a time or a shortcut. */
  readonly hint?: string;
  /** Extra words it answers to. */
  readonly keywords?: string;
  readonly run: () => void;
};

// Every word typed has to start a word in the label or keywords, so "si c" finds "Side chat".
function matches(command: Command, query: string): boolean {
  const words = `${command.label} ${command.keywords ?? ""} ${command.group}`.toLowerCase().split(/[\s·:/-]+/);

  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => words.some((word) => word.startsWith(part)));
}

// ⌘K: go to any chat, start one, or open activity and settings, without the mouse.
export function CommandPalette({ commands, onClose }: { commands: readonly Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  const shown = useMemo(() => commands.filter((command) => matches(command, query)), [commands, query]);
  const active = Math.min(index, Math.max(0, shown.length - 1));

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // One highlight glides between rows as the pointer moves. It lands without moving when the
  // palette opens, the results change or the arrow keys step, so typing never waits on it.
  const [highlight, setHighlight] = useState<{ top: number; height: number; glide: boolean }>();
  const placed = useRef<string>(undefined);
  const pointing = useRef(false);
  const results = shown.map((command) => command.id).join("\n");

  useLayoutEffect(() => {
    const item = list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    setHighlight(item ? { top: item.offsetTop, height: item.offsetHeight, glide: pointing.current && placed.current === results } : undefined);
    placed.current = results;
  }, [active, results]);

  const run = (command: Command | undefined) => {
    if (command === undefined) return;
    onClose();
    command.run();
  };

  return (
    <div className="palette-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Commands">
        <label className="palette-search">
          <Icon name="search" size={16} />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={shown.length > 0 ? `${id}-${active}` : undefined}
            aria-label="Search chats and commands"
            placeholder="Search chats and commands"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              pointing.current = false;

              if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
                event.preventDefault();
                setIndex((active + 1) % Math.max(1, shown.length));
              } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
                event.preventDefault();
                setIndex((active - 1 + shown.length) % Math.max(1, shown.length));
              } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                run(shown[active]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }
            }}
          />
          <kbd className="palette-kbd">esc</kbd>
        </label>
        {shown.length === 0 ? (
          <p className="palette-empty">Nothing matches “{query}”.</p>
        ) : (
          <ul ref={list} id={`${id}-list`} className="palette-list" role="listbox" aria-label="Results">
            {highlight ? (
              <li
                className="palette-highlight"
                role="presentation"
                aria-hidden="true"
                data-glide={highlight.glide}
                style={{ height: highlight.height, transform: `translateY(${highlight.top}px)` }}
              />
            ) : null}
            {shown.map((command, at) => (
              <li key={command.id} role="presentation">
                {at === 0 || shown[at - 1]!.group !== command.group ? (
                  <div className="palette-group" role="presentation">
                    {command.group}
                  </div>
                ) : null}
                <div
                  id={`${id}-${at}`}
                  role="option"
                  aria-selected={at === active}
                  data-index={at}
                  className="palette-item"
                  onPointerMove={() => {
                    pointing.current = true;

                    if (at !== active) setIndex(at);
                  }}
                  onClick={() => run(command)}
                >
                  <Icon name={command.icon} size={16} />
                  <span className="palette-label">{command.label}</span>
                  {command.hint ? <span className="palette-hint tabular">{command.hint}</span> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
