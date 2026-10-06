import { useEffect, useRef, useState } from "react";
import type { MemoryView, SoulChange, SoulVersion, SoulView } from "../protocol";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { type MemoryActions, MemoryCard, MemorySheet } from "./Memory";
import { ago } from "./time";

const since = (time: number, now: number) => {
  const text = ago(time, now);

  return text === "now" ? text : `${text} ago`;
};

const pad = (value: number) => String(value).padStart(2, "0");

/** A card's date, MM.DD.YY. */
const stamp = (time: number) => {
  const date = new Date(time);

  return `${pad(date.getMonth() + 1)}.${pad(date.getDate())}.${pad(date.getFullYear() % 100)}`;
};

type Mode = "read" | "edit" | "history";

// ky's persona and memory: an Edit pill, the SOUL card and the MEMORY card, each opening its sheet.
export function Soul({
  soul,
  now,
  onChange,
  onHistory,
  memory,
  memoryActions,
}: {
  soul: SoulView | null;
  now: number;
  onChange: (change: SoulChange) => void;
  onHistory: () => Promise<readonly SoulVersion[]>;
  memory: MemoryView | null;
  memoryActions: MemoryActions;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [remembering, setRemembering] = useState(false);

  return (
    <div className="panel-body soul" data-scroll>
      <button type="button" className="pill soul-edit pressable" disabled={soul === null} onClick={() => setMode("edit")}>
        Edit
      </button>
      <div className="soul-cards">
        <button
          type="button"
          className="soul-card pressable"
          disabled={soul === null}
          aria-label="Open SOUL.md"
          onClick={() => setMode("read")}
        >
          <span className="soul-card-title">Soul</span>
          <span className="soul-card-caption">Access with care</span>
          <span className="soul-card-foot">
            <span className="soul-card-date">{soul ? stamp(soul.updated_at) : "--.--.--"}</span>
            <Icon name="heart" size={18} />
          </span>
        </button>
        <MemoryCard memory={memory} onOpen={() => setRemembering(true)} />
      </div>
      {memory !== null && remembering ? (
        <MemorySheet memory={memory} onClose={() => setRemembering(false)} {...memoryActions} />
      ) : null}
      {soul !== null && mode !== null ? (
        <SoulSheet
          soul={soul}
          now={now}
          mode={mode}
          onMode={setMode}
          onClose={() => setMode(null)}
          onChange={onChange}
          onHistory={onHistory}
        />
      ) : null}
    </div>
  );
}

// SOUL.md in a sheet over the page: rendered, as a plain text editor, or as its versions.
function SoulSheet({
  soul,
  now,
  mode,
  onMode,
  onClose,
  onChange,
  onHistory,
}: {
  soul: SoulView;
  now: number;
  mode: Mode;
  onMode: (mode: Mode) => void;
  onClose: () => void;
  onChange: (change: SoulChange) => void;
  onHistory: () => Promise<readonly SoulVersion[]>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [menu, setMenu] = useState(false);
  const [versions, setVersions] = useState<readonly SoulVersion[] | null>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    if (mode !== "history") return;
    setVersions(null);
    void onHistory().then(setVersions);
  }, [mode, onHistory, soul.version]);

  return (
    <dialog
      ref={dialog}
      className="soul-sheet"
      aria-label="SOUL.md"
      onClose={onClose}
      // A click on the backdrop lands on the dialog itself, not on its content.
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <header className="soul-sheet-head">
        <button
          type="button"
          className="soul-round pressable"
          aria-label="Close"
          onClick={() => dialog.current?.close()}
        >
          <Icon name="chevronDown" size={18} />
        </button>
        <h2 className="soul-sheet-title">SOUL.md</h2>
        <div className="soul-tools">
          <button
            type="button"
            className="pressable"
            aria-label="Edit SOUL.md"
            aria-pressed={mode === "edit"}
            onClick={() => onMode(mode === "edit" ? "read" : "edit")}
          >
            <Icon name="pencil" size={16} />
          </button>
          <button
            type="button"
            className="pressable"
            aria-label="More"
            aria-expanded={menu}
            onClick={() => setMenu((open) => !open)}
          >
            <Icon name="more" size={18} className="icon-more" />
          </button>
          {menu ? (
            <div className="soul-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  onMode(mode === "history" ? "read" : "history");
                }}
              >
                {mode === "history" ? "Back to SOUL.md" : "History and revert"}
              </button>
            </div>
          ) : null}
        </div>
      </header>
      <div className="soul-sheet-body" data-scroll>
        {mode === "edit" ? (
          <SoulForm
            body={soul.body}
            onCancel={() => onMode("read")}
            onSave={(body) => {
              onChange({ action: "edit", body });
              onMode("read");
            }}
          />
        ) : (
          <>
            <p className="soul-note">
              This file shapes how ky talks in every conversation. It starts from a template. ky may refine it over time
              and tells you when it does. You can edit it at any time. This note is not part of the file.
            </p>
            {mode === "history" ? (
              <SoulVersions
                versions={versions}
                now={now}
                onRevert={(version) => {
                  onChange({ action: "revert", version });
                  onMode("read");
                }}
              />
            ) : (
              <article className="soul-body">
                <Markdown source={soul.body} />
              </article>
            )}
            <p className="soul-meta">
              Version {soul.version} · changed {since(soul.updated_at, now)}
            </p>
          </>
        )}
      </div>
    </dialog>
  );
}

// SOUL.md's versions, newest first; any but the current one can be restored.
function SoulVersions({
  versions,
  now,
  onRevert,
}: {
  versions: readonly SoulVersion[] | null;
  now: number;
  onRevert: (version: number) => void;
}) {
  return (
    <ul className="skill-versions soul-versions" aria-label="SOUL.md versions">
      {versions === null ? <li className="row-sub">Loading…</li> : null}
      {versions?.map((version, index) => (
        <li key={version.id}>
          <span className="row-text">
            <span>
              v{version.id} · {version.action} by {version.actor}
            </span>
            <span className="row-sub">{since(version.created_at, now)}</span>
          </span>
          {index === 0 ? (
            <span className="row-sub">Current</span>
          ) : (
            <button type="button" className="pill" onClick={() => onRevert(version.id)}>
              Revert
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function SoulForm({ body, onCancel, onSave }: { body: string; onCancel: () => void; onSave: (body: string) => void }) {
  const [draft, setDraft] = useState(body);

  return (
    <form
      className="soul-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <textarea aria-label="SOUL.md" value={draft} spellCheck={false} onChange={(event) => setDraft(event.target.value)} />
      <div className="soul-form-actions">
        <button type="button" className="pill" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="pill soul-save" disabled={draft.trim() === "" || draft === body}>
          Save
        </button>
      </div>
    </form>
  );
}
