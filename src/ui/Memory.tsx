import { useEffect, useRef, useState } from "react";
import type { MemoryItem, MemoryRow, MemorySearch, MemoryView } from "../protocol";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";

/** A memory's date, YYYY-MM-DD, as a card's MM.DD.YY. */
const dayStamp = (date: string) => {
  const [year = "", month = "", day = ""] = date.split("-");

  return `${month}.${day}.${year.slice(-2)}`;
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** How many memories a block id like "16-31" spans. */
const span = (block: string) => {
  const [lo = 0, hi = 0] = block.split("-").map(Number);

  return hi - lo + 1;
};

export type MemoryActions = {
  readonly onSearch: (query: string) => Promise<MemorySearch>;
  readonly onZoom: (block: string) => Promise<readonly MemoryItem[]>;
  readonly onForget: (block: string) => void;
};

// The MEMORY card, beside SOUL: its newest memory's date and how many there are.
export function MemoryCard({ memory, onOpen }: { memory: MemoryView | null; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="soul-card memory-card pressable"
      disabled={memory === null}
      aria-label="Open memory"
      onClick={onOpen}
    >
      <span className="soul-card-title">Memory</span>
      <span className="soul-card-caption">Access with care</span>
      <span className="soul-card-foot">
        <span className="memory-card-stamp">
          {memory ? <span className="memory-card-count">{plural(memory.count, "memory", "memories")}</span> : null}
          <span className="soul-card-date">{memory?.newest ? dayStamp(memory.newest) : "--.--.--"}</span>
        </span>
        <Icon name="chat" size={18} />
      </span>
    </button>
  );
}

// What ky remembers, in a sheet: recent memories as written, older ones as summaries that open into their halves.
export function MemorySheet({
  memory,
  onClose,
  onSearch,
  onZoom,
  onForget,
}: { memory: MemoryView; onClose: () => void } & MemoryActions) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<MemorySearch | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [halves, setHalves] = useState<Readonly<Record<string, readonly MemoryItem[]>>>({});
  const requested = useRef(new Set<string>());
  const seen = useRef<MemoryView | null>(null);

  // Search as the user types, a beat after they stop; a late answer to an old query is dropped.
  useEffect(() => {
    const text = query.trim();

    if (text === "") {
      setFound(null);

      return;
    }

    let current = true;

    const timer = setTimeout(() => {
      void onSearch(text).then((result) => {
        if (current) setFound(result);
      });
    }, 200);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, onSearch, memory]);

  // Open blocks load their halves once, and again after the memory changes.
  useEffect(() => {
    if (seen.current !== memory) {
      seen.current = memory;
      requested.current.clear();
    }

    for (const block of open) {
      if (requested.current.has(block)) continue;
      requested.current.add(block);
      void onZoom(block).then((items) => setHalves((current) => ({ ...current, [block]: items })));
    }
  }, [open, memory, onZoom]);

  const tree = {
    open,
    halves,
    onForget,
    onToggle: (block: string) =>
      setOpen((current) => {
        const next = new Set(current);

        if (!next.delete(block)) next.add(block);

        return next;
      }),
  };

  return (
    <Sheet
      dialog={dialog}
      label="Memory"
      className="memory-sheet"
      onClose={onClose}
      tools={
        <div className="soul-tools">
          <button
            type="button"
            className="pressable"
            aria-label="More"
            aria-expanded={menu}
            onClick={() => setMenu((shown) => !shown)}
          >
            <Icon name="more" size={18} className="icon-more" />
          </button>
          {menu ? (
            <div className="soul-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                disabled={open.size === 0}
                onClick={() => {
                  setMenu(false);
                  setOpen(new Set());
                }}
              >
                Collapse all blocks
              </button>
            </div>
          ) : null}
        </div>
      }
    >
      <p className="soul-note">
        What ky remembers about you and your work. ky writes these itself as you talk. Ask ky in chat to remember or
        correct something.
      </p>
      <label className="memory-search">
        <Icon name="search" size={16} />
        <input
          type="search"
          aria-label="Search memories"
          placeholder="Search memories"
          value={query}
          spellCheck={false}
          autoCapitalize="off"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {query.trim() !== "" ? (
        <SearchResults found={found} />
      ) : memory.count === 0 ? (
        <p className="memory-empty">No memories yet. ky writes them as you talk.</p>
      ) : (
        <MemoryList items={memory.items} tree={tree} label="Memories, newest first" />
      )}
      <p className="soul-meta">
        {plural(memory.count, "memory", "memories")}
        {memory.newest ? ` · newest ${dayStamp(memory.newest)}` : ""}
      </p>
    </Sheet>
  );
}

type Tree = {
  readonly open: ReadonlySet<string>;
  readonly halves: Readonly<Record<string, readonly MemoryItem[]>>;
  readonly onToggle: (block: string) => void;
  readonly onForget: (block: string) => void;
};

function SearchResults({ found }: { found: MemorySearch | null }) {
  if (found === null) return <p className="memory-empty">Searching…</p>;

  if (found.total === 0) return <p className="memory-empty">No match.</p>;

  return (
    <>
      <p className="memory-found">
        {found.matches.length < found.total
          ? `Newest ${found.matches.length} of ${found.total} matches`
          : plural(found.total, "match", "matches")}
        {found.regex ? "" : " · as plain text"}
      </p>
      <ul className="memory-list" aria-label="Search results">
        {found.matches.map((row) => (
          <MemoryLine key={row.id} row={row} />
        ))}
      </ul>
    </>
  );
}

function MemoryList({ items, tree, label }: { items: readonly MemoryItem[]; tree: Tree; label?: string }) {
  return (
    <ul className="memory-list" aria-label={label}>
      {items.map((item) =>
        item.kind === "memory" ? (
          <MemoryLine key={item.id} row={item} />
        ) : (
          <MemoryBlock key={item.block} item={item} tree={tree} />
        ),
      )}
    </ul>
  );
}

function MemoryLine({ row }: { row: MemoryRow }) {
  return (
    <li className="memory-row">
      <span className="memory-tag">
        #{row.id} · {dayStamp(row.date)}
      </span>
      <p>{row.text}</p>
    </li>
  );
}

// An older block: its summary, which opens into its two halves, and a menu to have ky write the summary again.
function MemoryBlock({ item, tree }: { item: Extract<MemoryItem, { kind: "block" }>; tree: Tree }) {
  const [menu, setMenu] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const expanded = tree.open.has(item.block);
  const halves = tree.halves[item.block];
  const dates = item.from === item.to ? dayStamp(item.from) : `${dayStamp(item.from)} – ${dayStamp(item.to)}`;

  return (
    <li className="memory-block" data-open={expanded || undefined}>
      <div className="memory-block-head">
        <button
          type="button"
          className="memory-block-toggle"
          aria-expanded={expanded}
          aria-label={`Block #${item.block}`}
          onClick={() => tree.onToggle(item.block)}
        >
          <span className="memory-tag">
            <Icon name="chevronRight" size={12} className="memory-chevron" />#{item.block} · {span(item.block)} memories ·{" "}
            {dates}
          </span>
          {item.text === null ? (
            <p className="memory-pending">Not summarized yet. ky writes it after its next note.</p>
          ) : (
            <p>{item.text}</p>
          )}
        </button>
        <div className="memory-block-tools">
          <button
            type="button"
            className="pressable"
            aria-label={`More for #${item.block}`}
            aria-expanded={menu}
            onClick={() => setMenu((shown) => !shown)}
          >
            <Icon name="more" size={16} className="icon-more" />
          </button>
          {menu ? (
            <div className="soul-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                disabled={item.text === null}
                onClick={() => {
                  setMenu(false);
                  setConfirming(true);
                }}
              >
                Rebuild summary
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {confirming ? (
        <div className="memory-confirm" role="alertdialog" aria-label={`Rebuild summary #${item.block}`}>
          <p>
            Drop this summary, and the larger ones built on it? ky writes them again from the memories, which stay as
            they are.
          </p>
          <div className="soul-form-actions">
            <button type="button" className="pill" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="pill soul-save"
              onClick={() => {
                setConfirming(false);
                tree.onForget(item.block);
              }}
            >
              Rebuild
            </button>
          </div>
        </div>
      ) : null}
      {expanded ? (
        halves === undefined ? (
          <p className="memory-empty">Loading…</p>
        ) : (
          <MemoryList items={halves} tree={tree} />
        )
      ) : null}
    </li>
  );
}
