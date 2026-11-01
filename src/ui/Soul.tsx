import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type {
  AccessChange,
  MachineInfo,
  MemoryView,
  ProviderInfo,
  SoulChange,
  SoulVersion,
  SoulView,
  SpecialistAccess,
  SpecialistDraft,
  SpecialistView,
} from "../protocol";
import { ModelPicks, modelChoices, modelFields, Pick, choiceOf } from "./Automations";
import { isMac } from "../machines/contract";
import { BotAvatar } from "./BotAvatar";
import { SpecialistPage } from "./SpecialistPage";
import { SpecialistTools } from "./Executor";
import { Switch } from "./Controls";
import { Icon } from "../chat-kit/Icon";
import { Markdown } from "./Markdown";
import { type MemoryActions, MemoryCard, MemorySheet } from "./Memory";
import { Sheet } from "./Sheet";
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

export type SpecialistActions = {
  onSave: (id: string, draft: SpecialistDraft, create: boolean) => Promise<string | undefined>;
  /** The user's own changes to a specialist's machines; resolves with why one was refused. */
  onAccess: (id: string, change: AccessChange) => Promise<string | undefined>;
  onDelete: (id: string) => Promise<string | undefined>;
  onBrief: (id: string, change: SoulChange) => void;
  onHistory: (id: string) => Promise<readonly SoulVersion[]>;
  /** Asks ky in chat to design a new bloub for the specialist, with the avatar tool. */
  onAvatar: (id: string) => void;
  /** Asks the specialist in the chat, as "@id text". */
  onAsk: (id: string, text: string) => void;
};

const SOUL_NOTE =
  "This file shapes how ky talks in every conversation. It starts from a template. ky may refine it over time and tells you when it does. You can edit it at any time. This note is not part of the file.";

const BRIEF_NOTE =
  "This brief is the specialist's standing instructions, in every conversation it has. ky may refine it and tells you when it does. Ask it in chat with @id. This note is not part of the brief.";

// ky's persona, memory and specialists: an Edit action, the SOUL and MEMORY cards, and the specialists' rows, each opening its sheet.
export function Soul({
  soul,
  now,
  onChange,
  onHistory,
  memory,
  memoryActions,
  specialists,
  specialistAccess,
  specialistActions,
  providers,
  machines,
}: {
  soul: SoulView | null;
  now: number;
  onChange: (change: SoulChange) => void;
  onHistory: () => Promise<readonly SoulVersion[]>;
  memory: MemoryView | null;
  memoryActions: MemoryActions;
  specialists: readonly SpecialistView[];
  specialistAccess: Readonly<Record<string, SpecialistAccess>>;
  specialistActions: SpecialistActions;
  providers: readonly ProviderInfo[];
  machines: readonly MachineInfo[];
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [remembering, setRemembering] = useState(false);

  return (
    <div className="panel-body soul" data-scroll>
      <section className="group">
        <div className="group-head">
          <h3 className="group-label">Soul and memory</h3>
          <button type="button" className="group-action pressable" disabled={soul === null} onClick={() => setMode("edit")}>
            Edit
          </button>
        </div>
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
      </section>
      <SpecialistList
        specialists={specialists}
        access={specialistAccess}
        actions={specialistActions}
        now={now}
        providers={providers}
        machines={machines}
      />
      {memory !== null && remembering ? (
        <MemorySheet memory={memory} onClose={() => setRemembering(false)} {...memoryActions} />
      ) : null}
      {soul !== null && mode !== null ? (
        <SoulSheet
          label="SOUL.md"
          note={SOUL_NOTE}
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

// The specialists' rows, each opening its brief; "+ Specialist" and the brief's menu open the settings sheet.
function SpecialistList({
  specialists,
  access,
  actions,
  now,
  providers,
  machines,
}: {
  specialists: readonly SpecialistView[];
  access: Readonly<Record<string, SpecialistAccess>>;
  actions: SpecialistActions;
  now: number;
  providers: readonly ProviderInfo[];
  machines: readonly MachineInfo[];
}) {
  const [brief, setBrief] = useState<{ id: string; mode: Mode } | null>(null);
  /** The specialist whose settings are open, or "" for a new one. */
  const [editing, setEditing] = useState<string | null>(null);
  /** The specialist whose page is open. */
  const [page, setPage] = useState<string | null>(null);
  const shown = specialists.find((each) => each.id === page);
  const { onHistory } = actions;
  const id = brief?.id;
  const open = specialists.find((each) => each.id === id);
  // Stable, so the history sheet loads once per version rather than on every render.
  const history = useCallback(() => onHistory(id ?? ""), [onHistory, id]);

  return (
    <section className="group specialists">
      <div className="group-head">
        <h3 className="group-label">Specialists</h3>
        <button type="button" className="group-action pressable" aria-label="+ Specialist" onClick={() => setEditing("")}>
          <Icon name="plus" size={12} />
          Specialist
        </button>
      </div>
      <SpecialistRows specialists={specialists} onOpen={setPage} />
      {shown ? (
        <SpecialistPage
          specialist={shown}
          access={access[shown.id]}
          machines={machines}
          onBrief={() => {
            setPage(null);
            setBrief({ id: shown.id, mode: "read" });
          }}
          onSettings={() => {
            setPage(null);
            setEditing(shown.id);
          }}
          onAsk={actions.onAsk}
          onClose={() => setPage(null)}
        />
      ) : null}
      {open && brief ? (
        <SoulSheet
          label={`@${open.id}`}
          note={BRIEF_NOTE}
          soul={open.brief}
          now={now}
          mode={brief.mode}
          onMode={(next) => setBrief({ id: open.id, mode: next })}
          onClose={() => setBrief(null)}
          onChange={(change) => actions.onBrief(open.id, change)}
          onHistory={history}
          onDetails={() => {
            setBrief(null);
            setEditing(open.id);
          }}
          onAvatar={() => {
            setBrief(null);
            actions.onAvatar(open.id);
          }}
        />
      ) : null}
      {editing !== null ? (
        <SpecialistSheet
          specialist={specialists.find((each) => each.id === editing)}
          access={access[editing]}
          providers={providers}
          machines={machines}
          actions={actions}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

// Each specialist's bloub, id, description and brief version; or, with none, what they are.
function SpecialistRows({ specialists, onOpen }: { specialists: readonly SpecialistView[]; onOpen: (id: string) => void }) {
  if (specialists.length === 0) {
    return <p className="group-empty">Standing bots with their own brief, like @engineer or @researcher. Ask one in chat with @id.</p>;
  }

  return (
    <ul className="card">
      {specialists.map((each) => (
        <li key={each.id}>
          <button type="button" className="row specialist-row" onClick={() => onOpen(each.id)}>
            <span className="row-tile row-avatar">
              <BotAvatar name={`@${each.id}`} identity={each.id} owner={each.id} still size={28} />
            </span>
            <span className="row-text">
              <span className="row-label">@{each.id}</span>
              <span className="row-sub row-sub-text">{each.description}</span>
            </span>
            <span className="row-value tabular">v{each.brief.version}</span>
            <Icon name="chevronRight" size={14} className="row-chevron" />
          </button>
        </li>
      ))}
    </ul>
  );
}

// SOUL.md or a specialist's brief in a sheet over the page: rendered, as a plain text editor, or as its versions.
function SoulSheet({
  label,
  note,
  soul,
  now,
  mode,
  onMode,
  onClose,
  onChange,
  onHistory,
  onDetails,
  onAvatar,
}: {
  label: string;
  note: string;
  soul: SoulView;
  now: number;
  mode: Mode;
  onMode: (mode: Mode) => void;
  onClose: () => void;
  onChange: (change: SoulChange) => void;
  onHistory: () => Promise<readonly SoulVersion[]>;
  /** Opens a specialist's settings, from the menu. */
  onDetails?: () => void;
  /** Asks ky for a specialist's new avatar, from the menu. */
  onAvatar?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [versions, setVersions] = useState<readonly SoulVersion[] | null>(null);

  useEffect(() => {
    if (mode !== "history") return;
    // A late answer for a mode or version already left is dropped.
    let current = true;
    setVersions(null);
    void onHistory().then((versions) => {
      if (current) setVersions(versions);
    });

    return () => {
      current = false;
    };
  }, [mode, onHistory, soul.version]);

  return (
    <Sheet
      dialog={dialog}
      label={label}
      onClose={onClose}
      tools={<SoulTools label={label} mode={mode} onMode={onMode} onDetails={onDetails} onAvatar={onAvatar} />}
    >
      {mode === "edit" ? (
        <SoulForm
          label={label}
          body={soul.body}
          onCancel={() => onMode("read")}
          onSave={(body) => {
            onChange({ action: "edit", body });
            onMode("read");
          }}
        />
      ) : (
        <>
          <p className="soul-note">{note}</p>
          {mode === "history" ? (
            <SoulVersions
              label={label}
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
    </Sheet>
  );
}

// The sheet's pencil, and its menu: history, and a specialist's settings and avatar.
function SoulTools({
  label,
  mode,
  onMode,
  onDetails,
  onAvatar,
}: {
  label: string;
  mode: Mode;
  onMode: (mode: Mode) => void;
  onDetails?: () => void;
  onAvatar?: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const history = mode === "history";

  return (
    <div className="soul-tools">
      <button
        type="button"
        className="pressable"
        aria-label={`Edit ${label}`}
        aria-pressed={mode === "edit"}
        onClick={() => onMode(mode === "edit" ? "read" : "edit")}
      >
        <Icon name="pencil" size={16} />
      </button>
      <button type="button" className="pressable" aria-label="More" aria-expanded={menu} onClick={() => setMenu((open) => !open)}>
        <Icon name="more" size={18} className="icon-more" />
      </button>
      {menu ? (
        <div className="soul-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              onMode(history ? "read" : "history");
            }}
          >
            {history ? `Back to ${label}` : "History and revert"}
          </button>
          {onDetails ? (
            <button type="button" role="menuitem" onClick={onDetails}>
              Description, model and machine
            </button>
          ) : null}
          {onAvatar ? (
            <button type="button" role="menuitem" onClick={onAvatar}>
              New avatar
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// The file's versions, newest first; any but the current one can be restored.
function SoulVersions({
  label,
  versions,
  now,
  onRevert,
}: {
  label: string;
  versions: readonly SoulVersion[] | null;
  now: number;
  onRevert: (version: number) => void;
}) {
  return (
    <ul className="skill-versions soul-versions" aria-label={`${label} versions`}>
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

function SoulForm({
  label,
  body,
  onCancel,
  onSave,
}: {
  label: string;
  body: string;
  onCancel: () => void;
  onSave: (body: string) => void;
}) {
  const [draft, setDraft] = useState(body);

  return (
    <form
      className="soul-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <textarea aria-label={label} value={draft} spellCheck={false} onChange={(event) => setDraft(event.target.value)} />
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

const BLANK = { id: "", description: "", brief: "", machine: "", ...modelFields(null) };

type SpecialistForm = typeof BLANK;

const formOf = (specialist: SpecialistView | undefined) =>
  specialist === undefined
    ? BLANK
    : { ...BLANK, id: specialist.id, description: specialist.description, machine: specialist.machine ?? "", ...modelFields(specialist.model) };

/**
 * What to save: the brief only on create; after, it changes in its own sheet. A model the user left
 * as it was is left out, so the stored one stays even when its provider isn't connected to be picked.
 */
export function specialistDraft(form: SpecialistForm, providers: readonly ProviderInfo[], stored: SpecialistView | undefined): SpecialistDraft {
  const settings = { description: form.description.trim(), machine: form.machine || null };

  if (stored === undefined) return { ...settings, model: choiceOf(form, modelChoices(providers)), brief: form.brief };
  const was = modelFields(stored.model);

  return form.model === was.model && form.thinking === was.thinking ? settings : { ...settings, model: choiceOf(form, modelChoices(providers)) };
}

const ready = (form: SpecialistForm, create: boolean) =>
  form.description.trim() !== "" && (!create || (form.id.trim() !== "" && form.brief.trim() !== ""));

// A new specialist, or one's description, model and machine, then its own machines.
function SpecialistSheet({
  specialist,
  access,
  providers,
  machines,
  actions,
  onClose,
}: {
  specialist: SpecialistView | undefined;
  access: SpecialistAccess | undefined;
  providers: readonly ProviderInfo[];
  machines: readonly MachineInfo[];
  actions: SpecialistActions;
  onClose: () => void;
}) {
  const { onSave } = actions;
  const dialog = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState(() => formOf(specialist));
  const [refused, setRefused] = useState<string | undefined>();
  const set = (patch: Partial<SpecialistForm>) => setForm((current) => ({ ...current, ...patch }));
  const create = specialist === undefined;
  const label = specialist ? `@${specialist.id}` : "New specialist";

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const why = await onSave(specialist?.id ?? form.id.trim().replace(/^@/, ""), specialistDraft(form, providers, specialist), create);
    setRefused(why);

    if (why === undefined) dialog.current?.close();
  };

  return (
    <Sheet dialog={dialog} label={label} onClose={onClose}>
      <form className="automation-form" aria-label={label} onSubmit={save}>
        <SpecialistWords form={form} set={set} create={create} />
        <div className="card">
          <ModelPicks providers={providers} form={form} set={set} />
          <Pick label="Machine" value={form.machine} onChange={(machine) => set({ machine })}>
            <option value="">Any</option>
            {[...new Set([...machines.map((machine) => machine.name), ...(form.machine ? [form.machine] : [])])].map((machine) => (
              <option key={machine} value={machine}>
                {machine}
              </option>
            ))}
          </Pick>
        </div>
        {refused ? (
          <p className="automation-refused" role="alert">
            {refused}
          </p>
        ) : null}
        <div className="automation-foot">
          <button type="submit" className="pill primary pressable" disabled={!ready(form, create)}>
            Save
          </button>
        </div>
      </form>
      {specialist && access ? (
        <>
          <SpecialistMachines id={specialist.id} access={access} machines={machines} onAccess={actions.onAccess} />
          <SpecialistTools id={specialist.id} own={access.tools} onPolicy={(tool, policy) => actions.onAccess(specialist.id, { tool, policy })} />
          <SpecialistDelete id={specialist.id} onDelete={actions.onDelete} onDeleted={() => dialog.current?.close()} />
        </>
      ) : null}
    </Sheet>
  );
}

// Its own sandbox, and the Macs the user lets it use: only the user changes these, never ky or the specialist.
function SpecialistMachines({
  id,
  access,
  machines,
  onAccess,
}: {
  id: string;
  access: SpecialistAccess;
  machines: readonly MachineInfo[];
  onAccess: SpecialistActions["onAccess"];
}) {
  const [refused, setRefused] = useState<string | undefined>();
  const sandboxes = machines.flatMap((machine) => (machine.sandbox ? [{ id: machine.sandbox.id, name: machine.name }] : []));
  // A Mac it may use that isn't paired now still shows, to revoke.
  const macs = [...new Set([...machines.flatMap((machine) => (isMac(machine) ? [machine.name] : [])), ...access.macs])];
  const change = async (next: AccessChange) => setRefused(await onAccess(id, next));

  return (
    <div className="card" role="group" aria-label={`@${id}'s machines`}>
      <Pick label="Sandbox" value={access.home ?? ""} onChange={(home) => void change({ home })}>
        {access.home === null ? (
          <option value="" disabled>
            None
          </option>
        ) : null}
        {sandboxes.map((sandbox) => (
          <option key={sandbox.id} value={sandbox.id}>
            {sandbox.name}
          </option>
        ))}
      </Pick>
      {macs.map((mac) => (
        <div key={mac} className="row">
          <span className="row-label">{mac}</span>
          <Switch on={access.macs.includes(mac)} label={`@${id} can use ${mac}`} onFlip={() => void change({ mac, grant: !access.macs.includes(mac) })} />
        </div>
      ))}
      {refused ? (
        <p className="automation-refused" role="alert">
          {refused}
        </p>
      ) : null}
    </div>
  );
}

// Deleting a specialist, after the user confirms.
function SpecialistDelete({ id, onDelete, onDeleted }: { id: string; onDelete: SpecialistActions["onDelete"]; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [refused, setRefused] = useState<string | undefined>();

  const remove = async () => {
    const why = await onDelete(id);
    setRefused(why);

    if (why === undefined) onDeleted();
  };

  if (!confirming) {
    return (
      <button type="button" className="machine-unpair pressable" onClick={() => setConfirming(true)}>
        Delete @{id}
      </button>
    );
  }

  return (
    <div className="machine-confirm" role="alertdialog" aria-label={`Delete @${id}`}>
      <p>Delete @{id}? Its runs stop, its own logins and keys go, and its workflows become ky's, paused. Its brief's versions and its sandbox stay.</p>
      {refused ? (
        <p className="automation-refused" role="alert">
          {refused}
        </p>
      ) : null}
      <div className="machine-confirm-actions">
        <button type="button" className="automation-text pressable" onClick={() => setConfirming(false)}>
          Cancel
        </button>
        <button type="button" className="machine-unpair-confirm pressable" onClick={() => void remove()}>
          Delete
        </button>
      </div>
    </div>
  );
}

// The id and brief, only for a new specialist, and the description.
function SpecialistWords({
  form,
  set,
  create,
}: {
  form: SpecialistForm;
  set: (patch: Partial<SpecialistForm>) => void;
  create: boolean;
}) {
  return (
    <div className="card automation-words">
      {create ? (
        <input
          className="automation-name"
          aria-label="Id"
          placeholder="engineer"
          value={form.id}
          onChange={(event) => set({ id: event.target.value })}
        />
      ) : null}
      <input
        aria-label="Description"
        placeholder="One line: what it is for"
        value={form.description}
        onChange={(event) => set({ description: event.target.value })}
      />
      {create ? (
        <textarea
          className="automation-prompt"
          aria-label="Brief"
          placeholder="Its persona and standing instructions: what it knows, how it works, what good looks like."
          rows={8}
          value={form.brief}
          onChange={(event) => set({ brief: event.target.value })}
        />
      ) : null}
    </div>
  );
}
