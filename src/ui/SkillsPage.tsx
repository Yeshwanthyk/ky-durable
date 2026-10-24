import { useState } from "react";
import type { SkillChange, SkillRow, SkillVersion } from "../protocol";
import { kitsOf } from "../skills/contract";
import { Icon } from "./Icon";
import { EMPTY, grouped, KitMembers, openNeeds, origin, SkillReader, since, times, toAnswerCount } from "./Skills";
import type { SkillFilter } from "./use-session-route";

const TABS: ReadonlyArray<readonly [SkillFilter, string]> = [
  ["all", "All"],
  ["kits", "Kits"],
  ["skills", "Skills"],
  ["needs", "To answer"],
  ["archived", "Archived"],
];

const matches = (query: string) => {
  const words = query.trim().toLowerCase();

  return (skill: SkillRow) => words === "" || `${skill.name} ${skill.description}`.toLowerCase().includes(words);
};

// ky's skills at full width: the list to pick from on the left, the picked skill read in full on the right.
export function SkillsPage({
  skills,
  filter,
  now,
  onFilter,
  onChats,
  onChange,
  onHistory,
}: {
  skills: readonly SkillRow[];
  filter: SkillFilter;
  now: number;
  onFilter: (filter: SkillFilter) => void;
  onChats: () => void;
  onChange: (change: SkillChange) => void;
  onHistory: (name: string) => Promise<readonly SkillVersion[]>;
}) {
  const [query, setQuery] = useState("");
  // The skill the user picked; on a narrow screen, picking one is what turns the list into the reader.
  const [picked, setPicked] = useState<string | null>(null);
  const toAnswer = toAnswerCount(skills);
  const kits = kitsOf(skills);
  const known = new Map(skills.map((skill) => [skill.name, skill]));

  const groups = grouped(skills, filter)
    .map(([label, rows]) => [label, rows.filter(matches(query))] as const)
    .filter(([, rows]) => rows.length > 0);

  // A picked member can sit outside the filter (a chip opens it from a kit), so it's found by name.
  const selected = (picked === null ? undefined : known.get(picked)) ?? groups[0]?.[1][0];

  return (
    <section className="stage artifacts skills-page" aria-label="Skills">
      <header className="artifacts-head">
        <button type="button" className="icon-button pressable drawer-toggle" aria-label="Chats" onClick={onChats}>
          <Icon name="menu" size={18} />
        </button>
        <h1>Skills</h1>
      </header>
      <div className="skills-toolbar">
        <div className="artifacts-tabs" role="tablist" aria-label="Show">
          {TABS.map(([value, label]) => (
            <button key={value} type="button" role="tab" className="pressable" aria-selected={value === filter} onClick={() => onFilter(value)}>
              {label}
              {value === "needs" && toAnswer > 0 ? <span className="skills-tab-count">{toAnswer}</span> : null}
            </button>
          ))}
        </div>
        <label className="skills-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            aria-label="Search skills"
            placeholder="Search"
            value={query}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div className="skills-split" data-reading={picked !== null && selected !== undefined}>
        <nav className="skills-index" aria-label="Skills list" data-scroll>
          {groups.length === 0 ? (
            <p className="artifacts-empty">{query.trim() === "" ? EMPTY[filter] : `Nothing matches “${query.trim()}”.`}</p>
          ) : (
            groups.map(([label, rows]) => (
              <section key={label} className="skills-index-group">
                <h3 className="skills-index-label">{label}</h3>
                <ul>
                  {rows.map((skill) => (
                    <li key={skill.name}>
                      <button
                        type="button"
                        className="skills-index-row pressable pressable-row"
                        aria-current={skill.name === selected?.name ? "true" : undefined}
                        onClick={() => setPicked(skill.name)}
                      >
                        <span className="skills-index-name">
                          {skill.kind === "kit" ? <Icon name="layers" size={13} /> : null}
                          {skill.name}
                          {skill.pinned ? <Icon name="pin" size={11} label="Pinned" className="skills-index-pin" /> : null}
                          {skill.status === "active" && openNeeds(skill).length > 0 ? (
                            <span className="skills-index-dot" title="Has questions to answer" />
                          ) : null}
                        </span>
                        <span className="skills-index-sub">{skill.description}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </nav>
        {selected === undefined ? (
          <div className="skills-reader" />
        ) : (
          <article key={selected.name} className="skills-reader" aria-label={selected.name} data-scroll>
            <button type="button" className="skills-back pressable" onClick={() => setPicked(null)}>
              <Icon name="arrowLeft" size={14} />
              Skills
            </button>
            <header className="skills-reader-head">
              <p className="skills-reader-kind" title={origin(selected).title}>
                {selected.status === "archived" ? "Archived " : ""}
                {selected.kind === "kit" ? "Kit" : "Skill"} · {origin(selected).by}
              </p>
              <h2>{selected.name}</h2>
              <p className="skills-reader-desc">{selected.description}</p>
              <p className="skills-reader-meta">
                Used {times(selected.uses)} · changed {since(selected.updated_at, now)}
                {(kits.get(selected.name) ?? []).length > 0 ? ` · in ${(kits.get(selected.name) ?? []).join(", ")}` : null}
                {selected.pinned ? " · pinned, so ky's dreams and reviews leave it as it is" : null}
              </p>
            </header>
            {selected.kind === "kit" ? (
              <section className="skills-reader-members">
                <h3 className="skill-section-title">Runs, in order</h3>
                <KitMembers kit={selected} known={known} onOpen={setPicked} />
              </section>
            ) : null}
            <div className="skills-reader-body">
              <SkillReader skill={selected} now={now} onChange={onChange} onHistory={onHistory} />
            </div>
          </article>
        )}
      </div>
    </section>
  );
}
