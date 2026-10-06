import { Fragment, useContext, useState } from "react";
import type { MachineChange, MachineState } from "../machines";
import type { MachineFacts } from "../runner-protocol";
import { osName } from "../protocol";
import type {
  MachineInfo,
  SettingsView,
  SkillChange,
  SkillRow,
  SkillVersion,
  Slot,
  SlotSetting,
  TaskRow,
  ToolInfo,
} from "../protocol";
import { Automations } from "./Automations";
import { Attachments, FilesContext, isMedia } from "./Attachments";
import { Changes } from "./Changes";
import type { BlobVariantId } from "./blob-catalog";
import { BotAvatar } from "./BotAvatar";
import { Icon, Spinner, type IconName } from "./Icon";
import { Markdown } from "./Markdown";
import { plain } from "./plain";
import { Skills } from "./Skills";
import { currentStep, elapsed, isLive, quietNote, spendParts } from "./task-progress";
import { ago, clock, day } from "./time";

export type Theme = "light" | "dark";

const statusIcon: Record<TaskRow["status"], IconName> = {
  queued: "circle",
  working: "circle",
  done: "checkCircle",
  failed: "alert",
  stopped: "stop",
};

export type PanelTab = "activity" | "skills" | "settings";

// Who ky is and how it is doing, then everything it is doing and has done, its skills, and its settings.
export function Panel({
  name,
  variantId,
  active,
  status,
  model,
  tasks,
  machines,
  running,
  catalog,
  session,
  now,
  settings,
  skills,
  theme,
  onTheme,
  onSetModel,
  onSkillChange,
  onSkillHistory,
  onOpen,
  onStop,
  onStopAll,
  onSetMachine,
  onClose,
  tab,
  onTab,
}: {
  name: string;
  variantId: BlobVariantId;
  active: boolean;
  status: { label: string; connected: boolean };
  model: string;
  tasks: readonly TaskRow[];
  machines: readonly MachineInfo[];
  /** What the open chat's running tools are doing right now, labelled. */
  running: readonly string[];
  catalog: readonly ToolInfo[];
  session: string;
  now: number;
  settings: SettingsView | null;
  skills: readonly SkillRow[];
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onSetModel: (slot: Slot, setting: SlotSetting) => void;
  onSkillChange: (change: SkillChange) => void;
  onSkillHistory: (name: string) => Promise<readonly SkillVersion[]>;
  onOpen: (session: string) => void;
  onStop: (task: string) => void;
  onStopAll: () => void;
  onSetMachine: (machine: string, change: MachineChange) => void;
  onClose: () => void;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
}) {
  return (
    <aside className="panel" aria-label="Activity and settings">
      <button type="button" className="icon-button pressable panel-close" aria-label="Close panel" onClick={onClose}>
        <Icon name="x" size={16} />
      </button>
      <header className="profile">
        <BotAvatar name={name} variantId={variantId} active={active} size={72} />
        <h2 className="profile-name">{name}</h2>
        <p className="profile-status" role="status">
          <span className="status-dot" data-connected={status.connected} />
          {status.label}
          <span className="quiet"> · {model}</span>
        </p>
      </header>
      <div className="segmented" role="tablist">
        {(
          [
            ["activity", "Activity"],
            ["skills", "Skills"],
            ["settings", "Settings"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className="pressable"
            onClick={() => onTab(id)}
          >
            {id === "settings" ? <Icon name="gear" size={14} className="gear" /> : null}
            {label}
          </button>
        ))}
      </div>
      {tab === "activity" ? (
        <Activity
          tasks={tasks}
          machines={machines}
          running={running}
          session={session}
          now={now}
          onOpen={onOpen}
          onStop={onStop}
          onStopAll={onStopAll}
        />
      ) : tab === "skills" ? (
        <Skills skills={skills} now={now} onChange={onSkillChange} onHistory={onSkillHistory} />
      ) : (
        <Settings
          settings={settings}
          catalog={catalog}
          machines={machines}
          now={now}
          theme={theme}
          onTheme={onTheme}
          onSet={onSetModel}
          onSetMachine={onSetMachine}
        />
      )}
    </aside>
  );
}

type FeedProps = {
  session: string;
  now: number;
  machines: readonly MachineInfo[];
  onOpen: (session: string) => void;
  onStop: (task: string) => void;
};

// What is running now, then scheduled work, then the most recent finished tasks; older ones on request.
function Activity({
  tasks,
  running,
  onStopAll,
  ...feed
}: FeedProps & {
  tasks: readonly TaskRow[];
  running: readonly string[];
  onStopAll: () => void;
}) {
  return (
    <div className="panel-body" data-scroll>
      <NowSection live={tasks.filter(isLive)} running={running} onStopAll={onStopAll} {...feed} />
      <Automations now={feed.now} />
      <History past={tasks.filter((task) => !isLive(task))} {...feed} />
      {tasks.length === 0 && running.length === 0 ? (
        <p className="panel-empty">Work ky hands to subagents and your machines shows up here.</p>
      ) : null}
    </div>
  );
}

// The open chat's running tools, and every queued or working task.
function NowSection({
  live,
  running,
  onStopAll,
  ...feed
}: FeedProps & { live: readonly TaskRow[]; running: readonly string[]; onStopAll: () => void }) {
  if (live.length === 0 && running.length === 0) return null;

  return (
    <section className="feed-group">
      <h3 className="feed-head">
        Now
        {live.length > 1 ? (
          <button type="button" className="feed-action pressable" onClick={onStopAll}>
            Stop all
          </button>
        ) : null}
      </h3>
      <ul className="feed">
        {running.map((tool, index) => (
          <li key={`${tool}-${index}`} className="feed-item feed-row">
            <StatusGlyph status="working" />
            <span className="feed-text">
              <span className="feed-title">{tool}</span>
              <span className="feed-meta">This chat</span>
            </span>
          </li>
        ))}
        {live.map((task) => (
          <TaskItem key={task.id} task={task} {...feed} />
        ))}
      </ul>
    </section>
  );
}

/** How many finished tasks show at first. */
const RECENT = 10;

/** How many more each Show earlier adds. */
const EARLIER = 20;

/** Finished tasks under their day: Today, Yesterday, Monday, Sep 28. */
function byDay(tasks: readonly TaskRow[], now: number): Map<string, TaskRow[]> {
  const groups = new Map<string, TaskRow[]>();

  for (const task of tasks) {
    const label = day(task.updated_at, now);
    groups.set(label, [...(groups.get(label) ?? []), task]);
  }

  return groups;
}

// The most recent finished tasks by day; Show earlier adds older ones until none are left.
function History({ past, ...feed }: FeedProps & { past: readonly TaskRow[] }) {
  const [shown, setShown] = useState(RECENT);
  // Only rows Show earlier revealed play an entry; the first screen and new tasks just appear.
  const earlier = new Set(past.slice(RECENT, shown).map((task) => task.id));
  const hidden = past.length - shown;

  return (
    <>
      {[...byDay(past.slice(0, shown), feed.now)].map(([label, rows]) => (
        <section key={label} className="feed-group" data-earlier={earlier.has(rows[0]!.id)}>
          <h3 className="feed-head">{label}</h3>
          <ul className="feed">
            {rows.map((task) => (
              <TaskItem key={task.id} task={task} earlier={earlier.has(task.id)} {...feed} />
            ))}
          </ul>
        </section>
      ))}
      {hidden > 0 ? (
        <button type="button" className="feed-more pressable" onClick={() => setShown((count) => count + EARLIER)}>
          Show earlier
          <span className="feed-more-count tabular">{hidden} more</span>
        </button>
      ) : null}
    </>
  );
}

// Your computers, and whether ky may use each.
function MachineList({
  machines,
  now,
  onSet,
}: {
  machines: readonly MachineInfo[];
  now: number;
  onSet: (machine: string, change: MachineChange) => void;
}) {
  return (
    <section className="group machines">
      <h3 className="group-label">Machines</h3>
      {machines.length === 0 ? (
        <p className="panel-note">
          None yet. Run <code>runner/ky-runner.ts</code> on a computer.
        </p>
      ) : (
        <ul className="card machine-list">
          {machines.map((machine) => (
            <MachineItem key={machine.name} machine={machine} now={now} onSet={onSet} />
          ))}
        </ul>
      )}
    </section>
  );
}

const MACHINE_STATES: ReadonlyArray<readonly [MachineState, string]> = [
  ["on", "On"],
  ["paused", "Paused"],
  ["off", "Off"],
];

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What the runner says the machine is: its OS, its Chrome, and how many repos. */
function factsLine(facts: MachineFacts | null): string | null {
  if (!facts) return null;
  const parts = [osName(facts.os)];

  if (facts.chrome) parts.push("your Chrome");

  if (facts.repos.length > 0) parts.push(plural(facts.repos.length, "repo"));

  return parts.join(" · ");
}

/** When an offline machine was last seen, and what waits for it. */
function offlineStatus(machine: MachineInfo, now: number): string {
  const seen = ago(machine.seenAt, now);
  const waiting = machine.active > 0 ? ` · ${machine.active} waiting` : "";

  return `offline, seen ${seen}${seen === "now" ? "" : " ago"}${waiting}`;
}

/** Whether a machine is busy, or when it was last seen. */
function machineStatus(machine: MachineInfo, now: number): string {
  if (!machine.online) return offlineStatus(machine, now);

  return machine.active === 0 ? "idle" : plural(machine.active, "task");
}

// What you say a machine is for; click to edit, Enter or leaving saves, Escape cancels.
function MachineNote({ machine, onSave }: { machine: MachineInfo; onSave: (note: string) => void }) {
  const [editing, setEditing] = useState(false);

  const save = (note: string) => {
    setEditing(false);

    if (note.trim() !== machine.note) onSave(note);
  };

  if (!editing) {
    return (
      <button type="button" className="machine-note pressable" title="Edit what it's for" onClick={() => setEditing(true)}>
        {machine.note === "" ? <span className="quiet">Say what it's for</span> : machine.note}
      </button>
    );
  }

  return (
    <input
      className="machine-note-input"
      aria-label={`What ${machine.name} is for`}
      placeholder="What it's for, e.g. builds and long jobs"
      defaultValue={machine.note}
      maxLength={200}
      autoFocus
      onBlur={(event) => save(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") save(event.currentTarget.value);

        if (event.key === "Escape") setEditing(false);
      }}
    />
  );
}

// A machine: whether it is up and busy, whether ky may use it, what it is, and what you say it is for.
function MachineItem({
  machine,
  now,
  onSet,
}: {
  machine: MachineInfo;
  now: number;
  onSet: (machine: string, change: MachineChange) => void;
}) {
  const about = [machineStatus(machine, now), factsLine(machine.facts)].filter(Boolean).join(" · ");

  return (
    <li className="machine" data-state={machine.state}>
      <div className="machine-head">
        <span className="status-dot" data-connected={machine.online} />
        <span className="machine-name" title={machine.name}>
          {machine.name}
        </span>
        <MachineSwitch machine={machine} onSet={onSet} />
      </div>
      <span className="machine-facts quiet">{about}</span>
      <MachineNote machine={machine} onSave={(note) => onSet(machine.name, { note })} />
    </li>
  );
}

// On, paused or off: whether ky may use the machine.
function MachineSwitch({ machine, onSet }: { machine: MachineInfo; onSet: (machine: string, change: MachineChange) => void }) {
  return (
    <div className="segmented small" role="radiogroup" aria-label={`Let ky use ${machine.name}`}>
      {MACHINE_STATES.map(([each, label]) => (
        <button
          key={each}
          type="button"
          role="radio"
          aria-checked={machine.state === each}
          className="pressable"
          onClick={() => onSet(machine.name, { state: each })}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** What a live task is doing now, or that it has gone quiet. */
function TaskNow({ task, machines, now }: { task: TaskRow; machines: readonly MachineInfo[]; now: number }) {
  const note = quietNote(task, machines, now);
  const step = currentStep(task);

  if (note !== null) return <span className="feed-step" data-quiet="true">{step ? `${note} · last: ${step}` : note}</span>;

  return step ? <span className="feed-step">{step}</span> : null;
}

/** The status as one bare glyph: a spinner while working, coloured only when it matters. */
function StatusGlyph({ status }: { status: TaskRow["status"] }) {
  return (
    <span className="feed-glyph" data-tone={status}>
      {status === "working" ? <Spinner size={14} /> : <Icon name={statusIcon[status]} size={16} />}
    </span>
  );
}

const WORKER_ICON: Record<TaskRow["kind"], IconName> = { cloud: "nodes", machine: "monitor" };

/** How long a live task has run; when a finished one ended, and what it cost. */
const figuresOf = (task: TaskRow, now: number) =>
  isLive(task) ? [elapsed(task, now)] : [clock(task.updated_at), ...spendParts(task, now)];

/** Who did it, as a quiet token, then its figures; the line wraps only between whole tokens. */
function TaskMeta({ task, now }: { task: TaskRow; now: number }) {
  const figures = figuresOf(task, now).filter((part) => part !== null);

  return (
    <span className="feed-meta">
      <span className="token" title={task.worker}>
        <Icon name={WORKER_ICON[task.kind]} size={12} />
        <span className="token-text">{task.worker}</span>
      </span>
      {figures.map((part, index) => (
        <Fragment key={`${index}-${part}`}>
          {index === 0 ? " " : " · "}
          <span className="figure tabular">{part}</span>
        </Fragment>
      ))}
    </span>
  );
}

/** The summary's first lines as plain text while the card is closed; opened, it renders below. */
function SummaryPreview({ summary, open }: { summary: string | null; open: boolean }) {
  return summary && !open ? <span className="feed-summary">{plain(summary)}</span> : null;
}

/** An opened task: its summary rendered, then its last few steps, oldest first. */
function TaskDetail({ task, open }: { task: TaskRow; open: boolean }) {
  if (!open) return null;

  return (
    <div className="feed-detail">
      {task.summary ? <Markdown source={task.summary} /> : null}
      <StepList task={task} />
    </div>
  );
}

function StepList({ task }: { task: TaskRow }) {
  if (task.steps.length === 0) return null;

  return (
    <ol className="feed-steps" aria-label="Recent steps">
      {task.steps.map((step) => (
        <li key={`${step.at}-${step.text}`}>
          <span className="tabular">{clock(step.at)}</span> {plain(step.text)}
        </li>
      ))}
    </ol>
  );
}

/** Stop a working task, or cancel a queued one. */
function StopButton({ task, onStop }: { task: TaskRow; onStop: (task: string) => void }) {
  if (!isLive(task)) return null;

  return (
    <button
      type="button"
      className="icon-button pressable feed-stop"
      aria-label={`Stop ${plain(task.title)}`}
      title={task.status === "queued" ? "Cancel" : "Stop"}
      onClick={() => onStop(task.id)}
    >
      <Icon name="stop" size={12} />
    </button>
  );
}

function TaskItem({
  task,
  earlier,
  session,
  now,
  machines,
  onOpen,
  onStop,
}: FeedProps & {
  task: TaskRow;
  /** Revealed by Show earlier: it fades in. */
  earlier?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const opens = task.kind === "cloud" && task.session !== null;
  const shared = useContext(FilesContext).some((file) => file.task === task.id && isMedia(file));

  return (
    <li
      className="feed-item"
      data-status={task.status}
      data-earlier={earlier}
      aria-current={opens && task.session === session ? "page" : undefined}
    >
      <button
        type="button"
        className="feed-button pressable"
        aria-expanded={opens ? undefined : open}
        onClick={() => (opens ? onOpen(task.session!) : setOpen((value) => !value))}
      >
        <StatusGlyph status={task.status} />
        <span className="feed-text">
          <span className="feed-title">{plain(task.title)}</span>
          <TaskNow task={task} machines={machines} now={now} />
          <SummaryPreview summary={task.summary} open={open} />
          <TaskMeta task={task} now={now} />
        </span>
      </button>
      <TaskDetail task={task} open={open} />
      {shared ? (
        <div className="feed-files">
          <Attachments task={task.id} compact />
        </div>
      ) : null}
      {task.kind === "machine" ? (
        <div className="feed-changes">
          <Changes task={task.id} />
        </div>
      ) : null}
      <StopButton task={task} onStop={onStop} />
    </li>
  );
}

const SLOTS: ReadonlyArray<{ slot: Slot; label: string; hint: string }> = [
  { slot: "main", label: "Main agent", hint: "Talks to you, in every chat" },
  { slot: "subagents", label: "Subagents", hint: "Research and parallel work" },
  { slot: "fallback", label: "Fallback", hint: "When the Mac is away" },
  { slot: "titles", label: "Titles", hint: "Names chats and tasks. Small and quick is best" },
];

const LEVELS: Partial<Record<SlotSetting["thinkingLevel"], string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const SLOT_ICONS: Record<Slot, IconName> = { main: "chat", subagents: "nodes", fallback: "cloud", titles: "pencil" };

// A role's row shows what it runs; open, it lists the models to pick from and how hard to think.
function ModelRow({
  slot,
  label,
  hint,
  settings,
  open,
  onToggle,
  onSet,
}: {
  slot: Slot;
  label: string;
  hint: string;
  settings: SettingsView;
  open: boolean;
  onToggle: () => void;
  onSet: (slot: Slot, setting: SlotSetting) => void;
}) {
  const current = settings.slots[slot];
  const connected = settings.providers.filter((provider) => provider.connected);

  const model = settings.providers
    .find((provider) => provider.id === current.provider)
    ?.models.find((each) => each.modelId === current.modelId);

  const level = model && model.levels.length > 1 ? (LEVELS[current.thinkingLevel] ?? current.thinkingLevel) : null;

  return (
    <li className="model-row" data-open={open}>
      <button type="button" className="row disclosure" aria-expanded={open} onClick={onToggle}>
        <span className="row-tile">
          <Icon name={SLOT_ICONS[slot]} size={15} />
        </span>
        <span className="row-text">
          <span className="row-label">{label}</span>
          <span className="row-sub row-current">
            {model?.name ?? current.modelId}
            {level ? ` · ${level}` : null}
          </span>
        </span>
        <Icon name="chevronRight" size={14} className="row-chevron chevron" />
      </button>
      <div className="expand" inert={!open}>
        <div className="expand-inner">
          <p className="choices-note">{hint}</p>
          <ul className="choices" role="radiogroup" aria-label={`${label} model`}>
            {connected.flatMap((provider) =>
              provider.models.map((each) => {
                const chosen = provider.id === current.provider && each.modelId === current.modelId;

                return (
                  <li key={`${provider.id}/${each.modelId}`}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={chosen}
                      className="choice"
                      onClick={() =>
                        onSet(slot, {
                          provider: provider.id,
                          modelId: each.modelId,
                          thinkingLevel: each.levels.includes(current.thinkingLevel)
                            ? current.thinkingLevel
                            : (each.levels[0] ?? current.thinkingLevel),
                        })
                      }
                    >
                      <span className="choice-text">
                        <span>{each.name}</span>
                        <span className="row-sub">
                          {provider.name}
                          {each.cost ? ` · $${each.cost.input} / $${each.cost.output} per M` : ""}
                        </span>
                      </span>
                      <Icon name="check" size={14} className="choice-check" />
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          {model && model.levels.length > 1 ? (
            <div className="thinking">
              <span className="row-sub">Thinking</span>
              <div className="segmented small" role="radiogroup" aria-label={`${label} thinking`}>
                {model.levels.map((each) => (
                  <button
                    key={each}
                    type="button"
                    role="radio"
                    aria-checked={current.thinkingLevel === each}
                    className="pressable"
                    onClick={() => onSet(slot, { ...current, thinkingLevel: each })}
                  >
                    {LEVELS[each] ?? each}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function Settings({
  settings,
  catalog,
  machines,
  now,
  theme,
  onTheme,
  onSet,
  onSetMachine,
}: {
  settings: SettingsView | null;
  catalog: readonly ToolInfo[];
  machines: readonly MachineInfo[];
  now: number;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onSet: (slot: Slot, setting: SlotSetting) => void;
  onSetMachine: (machine: string, change: MachineChange) => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [openSlot, setOpenSlot] = useState<Slot | null>(null);

  return (
    <div className="panel-body settings" data-scroll>
      <section className="group">
        <h3 className="group-label">Appearance</h3>
        <div className="card">
          <div className="row">
            <span className="row-tile">
              <Icon name={theme === "dark" ? "moon" : "sun"} size={15} />
            </span>
            <span className="row-label">Theme</span>
            <div className="segmented small" role="radiogroup" aria-label="Theme">
              {(["light", "dark"] as const).map((each) => (
                <button
                  key={each}
                  type="button"
                  role="radio"
                  aria-checked={theme === each}
                  className="pressable"
                  onClick={() => onTheme(each)}
                >
                  {each === "light" ? "Light" : "Dark"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
      <section className="group">
        <h3 className="group-label">Models</h3>
        {settings === null ? (
          <p className="panel-note">Loading models…</p>
        ) : (
          <ul className="card">
            {SLOTS.map(({ slot, label, hint }) => (
              <ModelRow
                key={slot}
                slot={slot}
                label={label}
                hint={hint}
                settings={settings}
                open={openSlot === slot}
                onToggle={() => setOpenSlot((value) => (value === slot ? null : slot))}
                onSet={onSet}
              />
            ))}
          </ul>
        )}
      </section>
      {settings ? (
        <section className="group">
          <h3 className="group-label">Providers</h3>
          <ul className="card">
            {settings.providers.map((provider) => (
              <li key={provider.id} className="row">
                <span className="row-tile">
                  <Icon name="plug" size={15} />
                </span>
                <span className="row-text">
                  <span className="row-label">{provider.name}</span>
                  {provider.connected ? null : <span className="row-sub">Needs {provider.needs ?? "a key"}</span>}
                </span>
                <span className="row-value tabular">
                  {provider.connected
                    ? `${provider.models.length} ${provider.models.length === 1 ? "model" : "models"}`
                    : "Off"}
                </span>
                <span className="status-dot" data-connected={provider.connected} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <MachineList machines={machines} now={now} onSet={onSetMachine} />
      <section className="group">
        <h3 className="group-label">Tools</h3>
        <div className="card">
          <button
            type="button"
            className="row disclosure"
            aria-expanded={toolsOpen}
            onClick={() => setToolsOpen((value) => !value)}
          >
            <span className="row-tile">
              <Icon name="terminal" size={15} />
            </span>
            <span className="row-label">What ky can use</span>
            <span className="row-value tabular">{catalog.length}</span>
            <Icon name="chevronRight" size={14} className="row-chevron chevron" />
          </button>
          {toolsOpen ? (
            <ul className="tool-list">
              {catalog.map((tool) => (
                <li key={tool.name}>
                  <code>{tool.name}</code>
                  <p>{tool.description}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>
    </div>
  );
}
