import type { SkillChange, SkillRow, SkillVersion } from "../protocol";
import { Icon } from "./Icon";
import { SkillGroups, toAnswerCount } from "./Skills";
import type { SkillFilter } from "./use-session-route";

const TABS: ReadonlyArray<readonly [SkillFilter, string]> = [
  ["all", "All"],
  ["kits", "Kits"],
  ["skills", "Skills"],
  ["needs", "To answer"],
  ["archived", "Archived"],
];

// ky's skills over the chat, the panel's list with room to read: kits and their members, and what's left to answer.
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
  const toAnswer = toAnswerCount(skills);

  return (
    <section className="stage artifacts skills-page" aria-label="Skills">
      <header className="artifacts-head">
        <button type="button" className="icon-button pressable drawer-toggle" aria-label="Chats" onClick={onChats}>
          <Icon name="menu" size={18} />
        </button>
        <h1>Skills</h1>
      </header>
      <div className="artifacts-tabs" role="tablist" aria-label="Show">
        {TABS.map(([value, label]) => (
          <button key={value} type="button" role="tab" className="pressable" aria-selected={value === filter} onClick={() => onFilter(value)}>
            {value === "needs" && toAnswer > 0 ? `${label} · ${toAnswer}` : label}
          </button>
        ))}
      </div>
      <div className="artifacts-body skills-page-body" data-scroll>
        <SkillGroups skills={skills} filter={filter} now={now} onChange={onChange} onHistory={onHistory} />
      </div>
    </section>
  );
}
