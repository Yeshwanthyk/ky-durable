import { type ReactNode, useState } from "react";
import type { SkillChange, SkillRow, SkillVersion } from "../protocol";
import { type Need, parse } from "../skills/contract";
import { Icon } from "./Icon";
import { ago } from "./time";

const since = (time: number, now: number) => {
  const text = ago(time, now);

  return text === "now" ? text : `${text} ago`;
};

const times = (count: number) => `${count} ${count === 1 ? "time" : "times"}`;

/** Whose a skill is: the user's (ky's starter skills count as theirs), or one ky wrote, which its dreams may tend. */
const origin = (skill: SkillRow) =>
  skill.created_by === "user"
    ? { mark: "yours", by: "Yours", title: "Yours: ky's dreams never archive it" }
    : { mark: "ky's", by: "Written by ky", title: "ky wrote it: its dreams may merge or archive it" };

/** The needs the user hasn't answered yet. */
const openNeeds = (skill: SkillRow) => parse(skill.body).needs.filter((need) => skill.answers[need.key] === undefined);

// The row's right edge: what it still needs, a pin when pinned, and whose the skill is.
function SkillMarks({ skill }: { skill: SkillRow }) {
  const { mark, title } = origin(skill);
  const open = skill.status === "active" ? openNeeds(skill).length : 0;

  return (
    <>
      {open > 0 ? (
        <span className="skill-needs-mark" title="Questions it asks before it runs">
          {open === 1 ? "1 question" : `${open} questions`}
        </span>
      ) : null}
      {skill.pinned ? <Icon name="pin" size={13} label="Pinned" className="skill-pin" /> : null}
      <span className="skill-origin" title={title}>
        {mark}
      </span>
    </>
  );
}

// Whose it is, how often it's used, when it changed, and what a pin means.
function SkillMeta({ skill, now }: { skill: SkillRow; now: number }) {
  return (
    <p className="row-sub">
      {origin(skill).by} · used {times(skill.uses)} · changed {since(skill.updated_at, now)}
      {skill.pinned ? " · pinned, so ky's dreams and reviews leave it as it is" : null}
    </p>
  );
}

// Pin or unpin an active skill; an archived one has nothing to keep.
function PinButton({ skill, onChange }: { skill: SkillRow; onChange: (change: SkillChange) => void }) {
  if (skill.status === "archived") return null;

  return (
    <button
      type="button"
      className="pill"
      aria-pressed={skill.pinned}
      title={skill.pinned ? "Let ky's dreams and reviews tend it again" : "Keep ky's dreams and reviews from changing it"}
      onClick={() => onChange({ action: skill.pinned ? "unpin" : "pin", name: skill.name })}
    >
      <Icon name="pin" size={13} />
      {skill.pinned ? "Unpin" : "Pin"}
    </button>
  );
}

// ky's skills: what each is for and how it reads, with editing, archiving, and going back a version.
export function Skills({
  skills,
  now,
  onChange,
  onHistory,
}: {
  skills: readonly SkillRow[];
  now: number;
  onChange: (change: SkillChange) => void;
  onHistory: (name: string) => Promise<readonly SkillVersion[]>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const active = skills.filter((skill) => skill.status === "active");
  const archived = skills.filter((skill) => skill.status === "archived");

  const group = (label: string, rows: readonly SkillRow[]) =>
    rows.length === 0 ? null : (
      <section className="group">
        <h3 className="group-label">{label}</h3>
        <ul className="card">
          {rows.map((skill) => (
            <SkillItem
              key={skill.name}
              skill={skill}
              now={now}
              open={open === skill.name}
              onToggle={() => setOpen((value) => (value === skill.name ? null : skill.name))}
              onChange={onChange}
              onHistory={onHistory}
            />
          ))}
        </ul>
      </section>
    );

  return (
    <div className="panel-body" data-scroll>
      {skills.length === 0 ? (
        <p className="panel-empty">
          No skills yet. ky writes one after a busy turn, or when you ask it to remember how to do something.
        </p>
      ) : null}
      {group("Active", active)}
      {group("Archived", archived)}
    </div>
  );
}

type Mode = "read" | "edit" | "history";

function SkillItem({
  skill,
  now,
  open,
  onToggle,
  onChange,
  onHistory,
}: {
  skill: SkillRow;
  now: number;
  open: boolean;
  onToggle: () => void;
  onChange: (change: SkillChange) => void;
  onHistory: (name: string) => Promise<readonly SkillVersion[]>;
}) {
  const [mode, setMode] = useState<Mode>("read");
  const [versions, setVersions] = useState<readonly SkillVersion[] | null>(null);
  const archived = skill.status === "archived";

  const showHistory = () => {
    setMode("history");
    setVersions(null);
    void onHistory(skill.name).then(setVersions);
  };

  return (
    <li className="skill" data-open={open}>
      <button type="button" className="row disclosure" aria-expanded={open} onClick={onToggle}>
        <span className="row-tile">
          <Icon name={archived ? "archive" : "list"} size={15} />
        </span>
        <span className="row-text">
          <span className="row-label">{skill.name}</span>
          <span className="row-sub row-sub-text">{skill.description}</span>
        </span>
        <SkillMarks skill={skill} />
        <Icon name="chevronRight" size={14} className="row-chevron chevron" />
      </button>
      <div className="expand" inert={!open}>
        <div className="expand-inner">
          <div className="item-body skill-detail">
            <SkillMeta skill={skill} now={now} />
            {mode === "edit" ? (
              <SkillForm
                skill={skill}
                onCancel={() => setMode("read")}
                onSave={(description, body) => {
                  onChange({ action: "edit", name: skill.name, description, body });
                  setMode("read");
                }}
              />
            ) : mode === "history" ? (
              <SkillVersions
                name={skill.name}
                versions={versions}
                now={now}
                onRevert={(version) => {
                  onChange({ action: "revert", name: skill.name, version });
                  setMode("read");
                }}
              />
            ) : (
              <>
                <SkillNeeds key={JSON.stringify(skill.answers)} skill={skill} onChange={onChange} />
                <pre className="skill-body">{skill.body}</pre>
              </>
            )}
            <SkillActions
              mode={mode}
              archived={archived}
              pin={<PinButton skill={skill} onChange={onChange} />}
              onMode={setMode}
              onHistory={showHistory}
              onArchive={() => onChange({ action: archived ? "restore" : "archive", name: skill.name })}
            />
          </div>
        </div>
      </div>
    </li>
  );
}

function SkillActions({
  mode,
  archived,
  pin,
  onMode,
  onHistory,
  onArchive,
}: {
  mode: Mode;
  archived: boolean;
  pin: ReactNode;
  onMode: (mode: Mode) => void;
  onHistory: () => void;
  onArchive: () => void;
}) {
  // The form has its own buttons.
  if (mode === "edit") return null;

  return (
    <div className="skill-actions">
      {mode === "history" ? (
        <button type="button" className="pill" onClick={() => onMode("read")}>
          Back
        </button>
      ) : (
        <>
          <button type="button" className="pill" onClick={() => onMode("edit")}>
            Edit
          </button>
          <button type="button" className="pill" onClick={onHistory}>
            History
          </button>
        </>
      )}
      {pin}
      <button type="button" className="pill" onClick={onArchive}>
        {archived ? "Restore" : "Archive"}
      </button>
    </div>
  );
}

// A skill's versions, newest first; any but the current one can be restored.
function SkillVersions({
  name,
  versions,
  now,
  onRevert,
}: {
  name: string;
  versions: readonly SkillVersion[] | null;
  now: number;
  onRevert: (version: number) => void;
}) {
  return (
    <ul className="skill-versions" aria-label={`${name} versions`}>
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

function SkillForm({
  skill,
  onCancel,
  onSave,
}: {
  skill: SkillRow;
  onCancel: () => void;
  onSave: (description: string, body: string) => void;
}) {
  const [description, setDescription] = useState(skill.description);
  const [body, setBody] = useState(skill.body);

  return (
    <form
      className="skill-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(description.trim(), body);
      }}
    >
      <input
        aria-label="Description"
        value={description}
        maxLength={200}
        onChange={(event) => setDescription(event.target.value)}
      />
      <textarea aria-label="Steps" value={body} rows={10} onChange={(event) => setBody(event.target.value)} />
      <div className="skill-actions">
        <button type="button" className="pill" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="pill" disabled={description.trim() === ""}>
          Save
        </button>
      </div>
    </form>
  );
}

// What the skill asks before it runs, answered in place: a choice where it lists them, a line otherwise.
function SkillNeeds({ skill, onChange }: { skill: SkillRow; onChange: (change: SkillChange) => void }) {
  const needs = parse(skill.body).needs;
  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...skill.answers }));

  if (needs.length === 0 || skill.status === "archived") return null;
  const changed = needs.filter((need) => (draft[need.key] ?? "") !== (skill.answers[need.key] ?? ""));

  return (
    <form
      className="skill-needs"
      aria-label={`${skill.name} needs`}
      onSubmit={(event) => {
        event.preventDefault();
        onChange({ action: "answer", name: skill.name, answers: Object.fromEntries(changed.map((need) => [need.key, draft[need.key] ?? ""])) });
      }}
    >
      <h4 className="skill-needs-title">Needs</h4>
      {needs.map((need) => (
        <NeedField key={need.key} need={need} value={draft[need.key] ?? ""} onValue={(value) => setDraft((was) => ({ ...was, [need.key]: value }))} />
      ))}
      <div className="skill-actions">
        <button type="submit" className="pill" disabled={changed.length === 0}>
          Save answers
        </button>
      </div>
    </form>
  );
}

function NeedField({ need, value, onValue }: { need: Need; value: string; onValue: (value: string) => void }) {
  return (
    <label className="skill-need">
      <span className="row-sub">{need.question}</span>
      {need.choices.length > 0 ? (
        <select value={value} onChange={(event) => onValue(event.target.value)}>
          <option value="">Not answered</option>
          {need.choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
          {value !== "" && !need.choices.includes(value) ? <option value={value}>{value}</option> : null}
        </select>
      ) : (
        <input value={value} placeholder="Not answered" onChange={(event) => onValue(event.target.value)} />
      )}
    </label>
  );
}
