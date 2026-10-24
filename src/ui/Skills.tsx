import { type ReactNode, useState } from "react";
import type { SkillChange, SkillRow, SkillVersion } from "../protocol";
import { kitsOf, type Need, parse } from "../skills/contract";
import { Icon } from "./Icon";
import { ago } from "./time";
import type { SkillFilter } from "./use-session-route";

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

const toAnswer = (skill: SkillRow) => skill.status === "active" && openNeeds(skill).length > 0;

// The row's right edge: the kits that run it, what it still needs, a pin when pinned, and whose the skill is.
function SkillMarks({ skill, kits }: { skill: SkillRow; kits: readonly string[] }) {
  const { mark, title } = origin(skill);
  const open = skill.status === "active" ? openNeeds(skill).length : 0;

  return (
    <>
      {kits.length > 0 ? (
        <span className="skill-in-kit" title={`Run by ${kits.join(", ")}`}>
          in {kits[0]}
          {kits.length > 1 ? ` +${kits.length - 1}` : null}
        </span>
      ) : null}
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

type Groups = {
  skills: readonly SkillRow[];
  filter: SkillFilter;
  now: number;
  onChange: (change: SkillChange) => void;
  onHistory: (name: string) => Promise<readonly SkillVersion[]>;
};

const EMPTY: Record<SkillFilter, string> = {
  all: "No skills yet. ky writes one after a busy turn, or when you ask it to remember how to do something.",
  kits: "No kits yet. A kit runs several skills together; ask ky to make one when the same skills keep running in a row.",
  skills: "No skills yet.",
  needs: "Nothing to answer. A skill that asks something before it runs shows here until you answer it.",
  archived: "Nothing archived."
};

/** The groups a filter shows, each a label and its rows. */
function grouped(skills: readonly SkillRow[], filter: SkillFilter): ReadonlyArray<readonly [string, readonly SkillRow[]]> {
  const active = skills.filter((skill) => skill.status === "active");
  const kits: readonly [string, readonly SkillRow[]] = ["Kits", active.filter((skill) => skill.kind === "kit")];
  const plain: readonly [string, readonly SkillRow[]] = ["Skills", active.filter((skill) => skill.kind === "skill")];
  const archived: readonly [string, readonly SkillRow[]] = ["Archived", skills.filter((skill) => skill.status === "archived")];

  switch (filter) {
    case "all":
      return [kits, plain, archived];
    case "kits":
      return [kits];
    case "skills":
      return [plain];
    case "needs":
      return [["To answer", active.filter(toAnswer)]];
    case "archived":
      return [archived];
  }
}

/** How many skills have questions to answer, for the Skills page's filter. */
export const toAnswerCount = (skills: readonly SkillRow[]) => skills.filter(toAnswer).length;

// ky's skills, kits first: what each is for and how it reads, with editing, archiving, and going back a version.
export function SkillGroups({ skills, filter, now, onChange, onHistory }: Groups) {
  const [open, setOpen] = useState<string | null>(null);
  const kits = kitsOf(skills);
  const known = new Map(skills.map((skill) => [skill.name, skill]));
  const groups = grouped(skills, filter).filter(([, rows]) => rows.length > 0);

  if (groups.length === 0) return <p className="panel-empty">{EMPTY[filter]}</p>;

  return groups.map(([label, rows]) => (
    <section key={label} className="group">
      <h3 className="group-label">{label}</h3>
      <ul className="card">
        {rows.map((skill) => (
          <SkillItem
            key={skill.name}
            skill={skill}
            kits={kits.get(skill.name) ?? []}
            known={known}
            now={now}
            open={open === skill.name}
            onToggle={() => setOpen((value) => (value === skill.name ? null : skill.name))}
            onOpen={setOpen}
            onChange={onChange}
            onHistory={onHistory}
          />
        ))}
      </ul>
    </section>
  ));
}

// The panel's Skills tab: every group, and the way to the full page.
export function Skills({ onPage, ...groups }: Omit<Groups, "filter"> & { onPage: () => void }) {
  return (
    <div className="panel-body" data-scroll>
      <button type="button" className="skills-page-link pressable" onClick={onPage}>
        Open the Skills page
        <Icon name="chevronRight" size={13} />
      </button>
      <SkillGroups {...groups} filter="all" />
    </div>
  );
}

type Mode = "read" | "edit" | "history";

function SkillItem({
  skill,
  kits,
  known,
  now,
  open,
  onToggle,
  onOpen,
  onChange,
  onHistory,
}: {
  skill: SkillRow;
  /** The active kits that run it. */
  kits: readonly string[];
  /** Every skill by name, to mark a kit's members. */
  known: ReadonlyMap<string, SkillRow>;
  now: number;
  open: boolean;
  onToggle: () => void;
  /** Opens another skill, a kit's member, in its place. */
  onOpen: (name: string) => void;
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
    <li className="skill" data-open={open} data-kind={skill.kind}>
      <button type="button" className="row disclosure" aria-expanded={open} onClick={onToggle}>
        <span className="row-tile">
          <Icon name={archived ? "archive" : skill.kind === "kit" ? "layers" : "list"} size={15} />
        </span>
        <span className="row-text">
          <span className="row-label">{skill.name}</span>
          <span className="row-sub row-sub-text">{skill.description}</span>
        </span>
        <SkillMarks skill={skill} kits={kits} />
        <Icon name="chevronRight" size={14} className="row-chevron chevron" />
      </button>
      {skill.kind === "kit" ? <KitMembers kit={skill} known={known} onOpen={onOpen} /> : null}
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
                <SkillBody body={skill.body} />
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

// A kit's members in order, each a chip that opens it: a kit inside the kit marked as one, a name that
// can't be opened (gone, or archived) struck through.
function KitMembers({ kit, known, onOpen }: { kit: SkillRow; known: ReadonlyMap<string, SkillRow>; onOpen: (name: string) => void }) {
  const members = parse(kit.body).members.filter((name) => name !== kit.name);

  if (members.length === 0) return <p className="kit-members row-sub">No members yet</p>;

  return (
    <ol className="kit-members" aria-label={`${kit.name} members`}>
      {members.map((name) => {
        const member = known.get(name);
        const state = member === undefined ? "missing" : member.status === "archived" ? "archived" : member.kind;

        return (
          <li key={name}>
            <button
              type="button"
              className="kit-member pressable"
              data-state={state}
              disabled={member === undefined}
              title={state === "missing" ? "No skill has this name" : state === "archived" ? "Archived: the kit skips it" : `Open ${name}`}
              onClick={() => onOpen(name)}
            >
              {state === "kit" ? <Icon name="layers" size={11} /> : null}
              {name}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** A body's parts: the text before the first `## heading`, then each heading's. */
function bodySections(body: string): ReadonlyArray<{ readonly title: string | null; readonly text: string }> {
  const parts: Array<{ title: string | null; text: string[] }> = [{ title: null, text: [] }];

  for (const line of body.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*#*$/.exec(line.trim());

    if (heading) parts.push({ title: heading[1] ?? "", text: [] });
    else parts.at(-1)?.text.push(line);
  }

  return parts.flatMap((part) => {
    const text = part.text.join("\n").trim();

    return text === "" ? [] : [{ title: part.title, text }];
  });
}

// The body as its parts, each under its heading. Needs and Members show as the form and the chips instead.
function SkillBody({ body }: { body: string }) {
  const parts = bodySections(body).filter((part) => !/^(needs|members)$/i.test(part.title ?? ""));

  return (
    <div className="skill-sections">
      {parts.map((part, index) => (
        <section key={`${index}-${part.title ?? ""}`} className="skill-section">
          {part.title === null ? null : <h4 className="skill-section-title">{part.title}</h4>}
          <pre className="skill-body">{part.text}</pre>
        </section>
      ))}
    </div>
  );
}
