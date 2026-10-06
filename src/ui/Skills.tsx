import { useState } from "react";
import type { SkillChange, SkillRow, SkillVersion } from "../protocol";
import { Icon } from "./Icon";
import { ago } from "./time";

const since = (time: number, now: number) => {
  const text = ago(time, now);

  return text === "now" ? text : `${text} ago`;
};

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
    <div className="panel-body settings" data-scroll>
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
    <li className="model-row skill" data-open={open}>
      <button type="button" className="row disclosure" aria-expanded={open} onClick={onToggle}>
        <span className="row-tile">
          <Icon name="list" size={15} />
        </span>
        <span className="row-text">
          <span className="row-label">{skill.name}</span>
          <span className="row-sub row-current">{skill.description}</span>
        </span>
        <Icon name="chevronRight" size={14} className="row-chevron chevron" />
      </button>
      <div className="expand" inert={!open}>
        <div className="expand-inner skill-detail">
          <p className="row-sub">
            Used {skill.uses} {skill.uses === 1 ? "time" : "times"} · changed {since(skill.updated_at, now)}
          </p>
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
            <ul className="skill-versions" aria-label={`${skill.name} versions`}>
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
                    <button
                      type="button"
                      className="pill"
                      onClick={() => {
                        onChange({ action: "revert", name: skill.name, version: version.id });
                        setMode("read");
                      }}
                    >
                      Revert
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <pre className="skill-body">{skill.body}</pre>
          )}
          {mode === "edit" ? null : (
            <div className="skill-actions">
              {mode === "history" ? (
                <button type="button" className="pill" onClick={() => setMode("read")}>
                  Back
                </button>
              ) : (
                <>
                  <button type="button" className="pill" onClick={() => setMode("edit")}>
                    Edit
                  </button>
                  <button type="button" className="pill" onClick={showHistory}>
                    History
                  </button>
                </>
              )}
              <button
                type="button"
                className="pill"
                onClick={() => onChange({ action: archived ? "restore" : "archive", name: skill.name })}
              >
                {archived ? "Restore" : "Archive"}
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
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
