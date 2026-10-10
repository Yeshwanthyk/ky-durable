import { type FormEvent, Fragment, type ReactNode, useContext, useId, useState } from "react";
import type { MachineChange, MachineLogin, MachineState } from "../machines";
import type { MachineFacts } from "../runner-protocol";
import { osName } from "../protocol";
import type {
  MachineInfo,
  ProviderInfo,
  SettingsView,
  SetupView,
  VendorOption,
  SkillChange,
  SkillRow,
  SkillVersion,
  MemoryView,
  ModelChoice,
  ModelOption,
  Purpose,
  SoulChange,
  SoulVersion,
  SoulView,
  SpecialistView,
  TaskRow,
  ToolInfo,
} from "../protocol";
import { Automations, Pick } from "./Automations";
import { Attachments, FilesContext, isMedia } from "./Attachments";
import { Changes } from "./Changes";
import type { BlobVariantId } from "./blob-catalog";
import { BotAvatar } from "./BotAvatar";
import { Icon, Spinner, type IconName } from "./Icon";
import { Markdown } from "./Markdown";
import { plain } from "./plain";
import type { MemoryActions } from "./Memory";
import { Skills } from "./Skills";
import { Soul, type SpecialistActions } from "./Soul";
import { Executor } from "./Executor";
import { Subscriptions, type SubscriptionsData } from "./Subscriptions";
import { currentStep, elapsed, isLive, quietNote, spendParts } from "./task-progress";
import { ago, clock, day } from "./time";
import { reveal } from "./use-panel";

export type Theme = "light" | "dark";

const statusIcon: Record<TaskRow["status"], IconName> = {
  queued: "circle",
  working: "circle",
  done: "checkCircle",
  failed: "alert",
  stopped: "stop",
};

export type PanelTab = "activity" | "skills" | "soul" | "settings";

// Who ky is and how it is doing, then everything it is doing and has done, its skills, its soul and memory, and its settings.
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
  setup,
  skills,
  soul,
  memory,
  memoryActions,
  specialists,
  specialistActions,
  subscriptions,
  theme,
  onTheme,
  onSetModel,
  onSkillChange,
  onSkillHistory,
  onSoulChange,
  onSoulHistory,
  onOpen,
  onStop,
  onStopAll,
  onSetMachine,
  onSetRepo,
  keyActions,
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
  setup: SetupView | null;
  skills: readonly SkillRow[];
  soul: SoulView | null;
  memory: MemoryView | null;
  memoryActions: MemoryActions;
  specialists: readonly SpecialistView[];
  specialistActions: SpecialistActions;
  subscriptions: SubscriptionsData;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onSetModel: (purpose: Purpose, choice: ModelChoice) => void;
  onSkillChange: (change: SkillChange) => void;
  onSkillHistory: (name: string) => Promise<readonly SkillVersion[]>;
  onSoulChange: (change: SoulChange) => void;
  onSoulHistory: () => Promise<readonly SoulVersion[]>;
  onOpen: (session: string) => void;
  onStop: (task: string) => void;
  onStopAll: () => void;
  onSetMachine: (machine: string, change: MachineChange) => void;
  onSetRepo: (repo: string) => Promise<string | undefined>;
  keyActions: KeyActions;
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
            ["soul", "Soul"],
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
            {id === "soul" ? <Icon name="fingerprint" size={14} /> : null}
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
      ) : tab === "soul" ? (
        <Soul
          soul={soul}
          now={now}
          onChange={onSoulChange}
          onHistory={onSoulHistory}
          memory={memory}
          memoryActions={memoryActions}
          specialists={specialists}
          specialistActions={specialistActions}
          providers={settings?.providers ?? []}
          machines={machines.map((machine) => machine.name)}
        />
      ) : (
        <Settings
          settings={settings}
          setup={setup}
          catalog={catalog}
          machines={machines}
          subscriptions={subscriptions}
          now={now}
          theme={theme}
          onTheme={onTheme}
          onSet={onSetModel}
          onSetMachine={onSetMachine}
          onSetRepo={onSetRepo}
          keyActions={keyActions}
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
      <Automations now={feed.now} session={feed.session} />
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

// The cloud machine first (the server lists it so), then your computers, and whether ky may use each.
function MachineList({
  machines,
  now,
  subscribed,
  onSet,
}: {
  machines: readonly MachineInfo[];
  now: number;
  /** Whether Settings › Subscriptions has a login saved. */
  subscribed: boolean;
  onSet: (machine: string, change: MachineChange) => void;
}) {
  return (
    <section className="group machines" id="settings-machines">
      <h3 className="group-label">Machines</h3>
      {machines.length === 0 ? (
        <p className="panel-note">None yet. Add one to run tasks on your own computer.</p>
      ) : (
        <ul className="card machine-list">
          {machines.map((machine) => (
            <MachineItem key={machine.name} machine={machine} now={now} subscribed={subscribed} onSet={onSet} />
          ))}
        </ul>
      )}
      <AddMachine now={now} />
    </section>
  );
}

type PairingCode = { code: string; expiresAt: number };

// A single-use code for one more machine, and the command that pairs it with the code.
function AddMachine({ now }: { now: number }) {
  const [code, setCode] = useState<PairingCode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setError(null);
    const response = await fetch("/api/runners/codes", { method: "POST" });

    if (!response.ok) {
      setError(`ky could not make a code (HTTP ${response.status}).`);

      return;
    }

    setCode(await response.json());
  };

  return (
    <div className="machine-add">
      <button type="button" className="pill pressable" onClick={() => void add()}>
        <Icon name="monitor" />
        {code === null ? "Add a machine" : "New code"}
      </button>
      {error ? <p className="panel-note">{error}</p> : null}
      {code === null ? null : <PairingCommand code={code} now={now} />}
    </div>
  );
}

// The command that pairs a computer with `code`, until the code expires.
function PairingCommand({ code, now }: { code: PairingCode; now: number }) {
  if (code.expiresAt <= now) return <p className="panel-note">That code has expired. Make a new one.</p>;

  return (
    <div className="machine-code">
      <p className="panel-note">
        On the computer, with <code>ky</code> installed, run this before {clock(code.expiresAt)}; it works once. It sets up
        the runner, starts it at login, and waits for it to come online here.
      </p>
      <code className="machine-command" aria-label="Pairing command">
        ky runner add {location.origin} {code.code}
      </code>
    </div>
  );
}

/** Whether ky may give the machine work, and what each choice means. */
const MACHINE_STATES: ReadonlyArray<readonly [MachineState, string, string]> = [
  ["on", "On", "ky can send it new tasks"],
  ["paused", "Paused", "Finishes what it's doing, takes nothing new"],
  ["off", "Off", "Takes no tasks"],
];

/** Whose Claude Code and Codex logins its tasks use. */
const MACHINE_LOGINS: ReadonlyArray<readonly [MachineLogin, string]> = [
  ["own", "This computer's"],
  ["ky", "From Subscriptions"],
];

/** What each login choice means, once Subscriptions has a login saved. */
const LOGIN_HINTS: Record<MachineLogin, string> = {
  own: "Tasks use the logins on that computer; Subscriptions fill in where it isn't signed in",
  ky: "Tasks always use the logins saved in Settings › Subscriptions",
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** What the runner says the machine is: its OS, its Chrome, and how many repos. */
function factsLine(facts: MachineFacts | null): string | null {
  if (!facts) return null;
  const parts = [osName(facts.os)];

  if (facts.chrome) parts.push("your Chrome");

  if (facts.repos.length > 0) parts.push(plural(facts.repos.length, "repo"));

  return parts.join(" · ");
}

const AGO_UNITS = { m: "min", h: "hour", d: "day" } satisfies Record<string, string>;

/** How long ago, in words: "just now", "51 min ago", "3 hours ago". */
function agoInWords(time: number, now: number): string {
  const short = ago(time, now);

  if (short === "now") return "just now";
  const count = Number(short.slice(0, -1));
  // SAFETY: ago() ends every answer but "now" in m, h or d.
  const unit = AGO_UNITS[short.slice(-1) as keyof typeof AGO_UNITS];

  return unit === "min" ? `${count} min ago` : `${plural(count, unit)} ago`;
}

/** A machine's status: a tone for its dot, and a line of words. */
type MachineStatus = { tone: "online" | "paused" | "off" | "offline"; text: string };

/** What an online machine's dot and status say for each state. */
const STATE_STATUS = {
  on: ["online", "Online"],
  paused: ["paused", "Paused"],
  off: ["off", "Off"],
} as const satisfies Record<MachineState, readonly [MachineStatus["tone"], string]>;

/** When an offline machine was last seen, and what waits for it. */
function offlineStatus(machine: MachineInfo, now: number): MachineStatus {
  const waiting = machine.active > 0 ? ` · ${machine.active} waiting` : "";

  return { tone: "offline", text: `Offline · last seen ${agoInWords(machine.seenAt, now)}${waiting}` };
}

/** The machine's status as a tone for its dot and a line of words. */
function machineStatus(machine: MachineInfo, now: number): MachineStatus {
  if (!machine.online) return offlineStatus(machine, now);
  const [tone, word] = STATE_STATUS[machine.state];
  const busy = machine.active === 0 ? "idle" : `${plural(machine.active, "task")} running`;

  return { tone, text: `${word} · ${busy}` };
}

// A short text shown as a button; click to edit, Enter or leaving saves, Escape cancels.
function InlineEdit({
  value,
  className,
  title,
  empty,
  label,
  placeholder,
  maxLength,
  onSave,
}: {
  value: string;
  /** The button's class; the input's is the same with `-input`. */
  className: string;
  title: string;
  /** What the button says while the value is empty. */
  empty: string;
  label: string;
  placeholder: string;
  maxLength: number;
  onSave: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  const save = (next: string) => {
    setEditing(false);

    if (next.trim() !== value) onSave(next);
  };

  if (!editing) {
    return (
      <button type="button" className={`${className} pressable`} title={title} onClick={() => setEditing(true)}>
        {value === "" ? <span className="quiet">{empty}</span> : value}
      </button>
    );
  }

  return (
    <input
      className={`${className}-input`}
      aria-label={label}
      placeholder={placeholder}
      defaultValue={value}
      maxLength={maxLength}
      autoFocus
      onBlur={(event) => save(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") save(event.currentTarget.value);

        if (event.key === "Escape") setEditing(false);
      }}
    />
  );
}

// A machine: whether it is up and busy, what it is, whether ky may use it, whose logins it uses, and what it is for.
function MachineItem({
  machine,
  now,
  subscribed,
  onSet,
}: {
  machine: MachineInfo;
  now: number;
  /** Whether Settings › Subscriptions has a login saved. */
  subscribed: boolean;
  onSet: (machine: string, change: MachineChange) => void;
}) {
  const status = machineStatus(machine, now);
  const facts = factsLine(machine.facts);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setConfirming(false);
    const response = await fetch(`/api/runners/${encodeURIComponent(machine.name)}`, { method: "DELETE" });

    setError(response.ok ? null : `ky could not unpair ${machine.name} (HTTP ${response.status}).`);
  };

  return (
    <li className="machine" data-state={machine.state}>
      <div className="machine-head">
        <span className="machine-name" title={machine.name}>
          {machine.name}
        </span>
        <span className="machine-status" data-tone={status.tone}>
          <span className="machine-dot" aria-hidden="true" />
          {status.text}
        </span>
        {facts ? <span className="machine-facts">{facts}</span> : null}
      </div>
      {machine.online ? null : <MachineRestart />}
      <MachineSwitch machine={machine} onSet={onSet} />
      <MachineLoginSwitch machine={machine} subscribed={subscribed} onSet={onSet} />
      <MachineNote machine={machine} onSet={onSet} />
      {confirming ? (
        <div className="machine-confirm" role="alertdialog" aria-label={`Unpair ${machine.name}`}>
          <p>
            Unpair {machine.name}? Its runner stops, its tasks end, and it has to pair again to come back.
          </p>
          <div className="machine-confirm-actions">
            <button type="button" className="automation-text pressable" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="machine-unpair-confirm pressable" onClick={() => void remove()}>
              Unpair
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="machine-unpair pressable" onClick={() => setConfirming(true)}>
          Unpair this computer
        </button>
      )}
      {error ? (
        <p className="machine-error" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

// How to bring an offline machine back: the service restarts it, or the user starts it by hand.
function MachineRestart() {
  return (
    <div className="machine-restart">
      <p>Start it on that computer:</p>
      <code className="machine-command" aria-label="Start command">
        ky runner run
      </code>
      <p>If it was set up as a service, it should restart on its own once that computer is on.</p>
    </div>
  );
}

// A labelled choice in a machine's card, with a hint for what's chosen under it.
function MachineField({ label, hint, children }: { label: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="machine-field">
      <span className="machine-field-label">{label}</span>
      {children}
      <span className="machine-hint">{hint}</span>
    </div>
  );
}

// On, paused or off: whether ky may use the machine.
function MachineSwitch({ machine, onSet }: { machine: MachineInfo; onSet: (machine: string, change: MachineChange) => void }) {
  const hint = MACHINE_STATES.find(([each]) => each === machine.state)?.[2] ?? "";

  return (
    <MachineField label="Takes tasks" hint={hint}>
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
    </MachineField>
  );
}

// Whose Claude Code and Codex logins the machine's tasks use: its own, or the ones in Settings › Subscriptions.
function MachineLoginSwitch({
  machine,
  subscribed,
  onSet,
}: {
  machine: MachineInfo;
  subscribed: boolean;
  onSet: (machine: string, change: MachineChange) => void;
}) {
  return (
    <MachineField label="Claude & Codex login" hint={<LoginHint login={machine.login} subscribed={subscribed} />}>
      <div className="segmented small" role="radiogroup" aria-label={`Whose login ${machine.name} uses`}>
        {MACHINE_LOGINS.map(([each, label]) => (
          <button
            key={each}
            type="button"
            role="radio"
            aria-checked={machine.login === each}
            data-empty={each === "ky" && !subscribed}
            className="pressable"
            onClick={() => onSet(machine.name, { login: each })}
          >
            {label}
          </button>
        ))}
      </div>
    </MachineField>
  );
}

// What the chosen login means, or that Subscriptions has nothing to hand over yet.
function LoginHint({ login, subscribed }: { login: MachineLogin; subscribed: boolean }) {
  if (subscribed) return LOGIN_HINTS[login];

  const saved = (
    <>
      Nothing is saved in{" "}
      <button type="button" className="refused-link" onClick={() => reveal("settings-subscriptions")}>
        {SUBSCRIPTIONS}
      </button>{" "}
      yet
    </>
  );

  return login === "ky" ? <>{saved}, so there is no login to hand over.</> : <>Tasks use the logins on that computer. {saved}.</>;
}

// What the user says the machine is for; Enter or leaving the field saves, Escape puts it back.
function MachineNote({ machine, onSet }: { machine: MachineInfo; onSet: (machine: string, change: MachineChange) => void }) {
  const id = useId();

  const save = (next: string) => {
    if (next.trim() !== machine.note) onSet(machine.name, { note: next });
  };

  return (
    <div className="machine-field">
      <label className="machine-field-label" htmlFor={id}>
        What it's for <span className="quiet">(optional)</span>
      </label>
      <input
        id={id}
        key={machine.note}
        className="machine-note-input"
        placeholder="e.g. work laptop, has Chrome"
        defaultValue={machine.note}
        maxLength={200}
        onBlur={(event) => save(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();

          if (event.key === "Escape") {
            event.currentTarget.value = machine.note;
            event.currentTarget.blur();
          }
        }}
      />
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

const PURPOSES: ReadonlyArray<{ purpose: Purpose; label: string; hint: string }> = [
  { purpose: "main", label: "Main agent", hint: "Talks to you, in every chat" },
  { purpose: "worker", label: "Worker", hint: "Subagents, specialists and automations" },
  { purpose: "background", label: "Background", hint: "Titles, memory, dreams and skill reviews. Small and quick is best" },
  { purpose: "fallback", label: "Fallback", hint: "Answers when a provider is down" },
];

const LEVELS: Partial<Record<ModelChoice["thinkingLevel"], string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const PURPOSE_ICONS: Record<Purpose, IconName> = { main: "chat", worker: "nodes", background: "pencil", fallback: "cloud" };

// What a purpose runs, as its row shows it: the model, its provider and, when the model has a choice, how hard it thinks.
function summaryOf(current: ModelChoice, provider: ProviderInfo | undefined, model: ModelOption | undefined): string {
  const parts = [model?.name ?? current.modelId, provider?.name ?? current.provider];

  if ((model?.levels.length ?? 0) > 1) parts.push(LEVELS[current.thinkingLevel] ?? current.thinkingLevel);

  return parts.join(" · ");
}

// A purpose's row shows what it runs; open, it lists the models to pick from and how hard to think.
function ModelRow({
  purpose,
  current,
  label,
  hint,
  settings,
  open,
  onToggle,
  onSet,
}: {
  purpose: Purpose;
  current: ModelChoice;
  label: string;
  hint: string;
  settings: SettingsView;
  open: boolean;
  onToggle: () => void;
  onSet: (purpose: Purpose, choice: ModelChoice) => void;
}) {
  const connected = settings.providers.filter((provider) => provider.connected);
  const provider = settings.providers.find((each) => each.id === current.provider);
  const model = provider?.models.find((each) => each.modelId === current.modelId);
  const levels = model?.levels ?? [];

  return (
    <li className="model-row" data-open={open}>
      <button type="button" className="row disclosure" aria-expanded={open} onClick={onToggle}>
        <span className="row-tile">
          <Icon name={PURPOSE_ICONS[purpose]} size={15} />
        </span>
        <span className="row-text">
          <span className="row-label">{label}</span>
          <span className="row-sub row-current">{summaryOf(current, provider, model)}</span>
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
                        onSet(purpose, {
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
          {levels.length > 1 ? (
            <div className="thinking">
              <span className="row-sub">Thinking</span>
              <div className="segmented small" role="radiogroup" aria-label={`${label} thinking`}>
                {levels.map((each) => (
                  <button
                    key={each}
                    type="button"
                    role="radio"
                    aria-checked={current.thinkingLevel === each}
                    className="pressable"
                    onClick={() => onSet(purpose, { ...current, thinkingLevel: each })}
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

// A provider or tool: what it needs while it is off, or why it last failed, and how it stands.
function ServiceRow({
  name,
  sub,
  value,
  on,
  children,
}: {
  name: string;
  sub?: string | undefined;
  value: string;
  on: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="row">
      <span className="row-tile">
        <Icon name="plug" size={15} />
      </span>
      <span className="row-text">
        <span className="row-label">{name}</span>
        {sub ? <span className="row-sub">{sub}</span> : null}
      </span>
      <span className="row-value tabular">{value}</span>
      {children}
      <span className="status-dot" data-connected={on} />
    </li>
  );
}

export type KeyActions = {
  /** Test and save a vendor's key; resolves with why it was refused, if it was. */
  readonly onAdd: (vendor: string, key: string) => Promise<string | undefined>;
  readonly onRemove: (provider: string) => void;
};

// What a provider's row says under its name: what it needs while it is off, else why its breaker last opened.
function providerSub(provider: ProviderInfo): string | undefined {
  if (!provider.connected) return `Needs ${provider.needs ?? "a key"}`;

  return provider.failure && `Last error: ${provider.failure}`;
}

// A provider and how it stands; an api-key provider's key can be removed.
function ProviderRow({ provider, onRemove }: { provider: ProviderInfo; onRemove: (provider: string) => void }) {
  return (
    <ServiceRow
      name={provider.name}
      sub={providerSub(provider)}
      value={provider.connected ? plural(provider.models.length, "model") : "Off"}
      on={provider.connected}
    >
      {provider.kind === "api-key" ? (
        <button
          type="button"
          className="automation-text danger pressable"
          aria-label={`Remove the ${provider.name} key`}
          onClick={() => onRemove(provider.id)}
        >
          Remove
        </button>
      ) : null}
    </ServiceRow>
  );
}

const SUBSCRIPTIONS = "Settings › Subscriptions";

// Why a key was refused; where it names Settings › Subscriptions, that is a link to it.
function KeyRefusal({ text }: { text: string | undefined }) {
  if (!text) return null;
  const [before, ...after] = text.split(SUBSCRIPTIONS);

  return (
    <p className="automation-refused" role="alert">
      {before}
      {after.length > 0 ? (
        <button type="button" className="refused-link" onClick={() => reveal("settings-subscriptions")}>
          {SUBSCRIPTIONS}
        </button>
      ) : null}
      {after.join(SUBSCRIPTIONS)}
    </p>
  );
}

// The model providers this deploy has, then a key to add for a vendor that has none.
function Providers({
  providers,
  vendors,
  keyActions,
}: {
  providers: readonly ProviderInfo[];
  vendors: readonly VendorOption[];
  keyActions: KeyActions;
}) {
  return (
    <section className="group" id="settings-providers">
      <h3 className="group-label">Providers</h3>
      {providers.length > 0 ? (
        <ul className="card">
          {providers.map((provider) => (
            <ProviderRow key={provider.id} provider={provider} onRemove={keyActions.onRemove} />
          ))}
        </ul>
      ) : null}
      {vendors.length > 0 ? <AddKey vendors={vendors} onAdd={keyActions.onAdd} /> : null}
    </section>
  );
}

// The providers and tools this deploy has no config for, with what each needs.
function NotSetUpGroup({ missing }: { missing: SetupView["missing"] }) {
  return missing.length > 0 ? (
    <section className="group">
      <h3 className="group-label">Not set up</h3>
      <ul className="card">
        {missing.map((each) => (
          <ServiceRow key={each.id} name={each.name} sub={`Needs ${each.needs}`} value="Not set up" on={false} />
        ))}
      </ul>
    </section>
  ) : null;
}

// The model providers this deploy has and the keys it takes, then the providers and tools it has no config for.
function Services({
  settings,
  setup,
  keyActions,
}: {
  settings: SettingsView;
  setup: SetupView | null;
  keyActions: KeyActions;
}) {
  const missing = setup?.missing ?? [];
  const configured = settings.providers.filter((provider) => !missing.some((each) => each.id === provider.id));

  return (
    <>
      <Providers providers={configured} vendors={settings.vendors} keyActions={keyActions} />
      <NotSetUpGroup missing={missing} />
    </>
  );
}

// The vendor picked, or the first one left once a saved key takes the picked one off the list.
function vendorOf(vendors: readonly VendorOption[], chosen: string): string {
  return vendors.some((each) => each.id === chosen) ? chosen : (vendors[0]?.id ?? "");
}

// A vendor's API key, which the server tests with a call before saving; the field empties once it is tested.
function AddKey({
  vendors,
  onAdd,
}: {
  vendors: readonly VendorOption[];
  onAdd: (vendor: string, key: string) => Promise<string | undefined>;
}) {
  const [chosen, setChosen] = useState("");
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [refused, setRefused] = useState<string>();
  const vendor = vendorOf(vendors, chosen);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setTesting(true);

    setRefused(await onAdd(vendor, key));
    setTesting(false);
    setKey("");
  };

  return (
    <form className="automation-form key-form" aria-label="Add an API key" onSubmit={save}>
      <div className="card">
        <Pick label="Vendor" value={vendor} onChange={setChosen}>
          {vendors.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </Pick>
        <label className="row">
          <span className="row-label">API key</span>
          <input
            className="key-input"
            aria-label="API key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste it here"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
      </div>
      <KeyRefusal text={refused} />
      <div className="automation-foot">
        <button type="submit" className="pill primary pressable" disabled={testing || key.trim() === ""}>
          {testing ? "Testing…" : "Test and save"}
        </button>
      </div>
    </form>
  );
}

// ky's GitHub repo, where self-edits go, and the address of the page that set it, which ky checks after a deploy.
function SelfEdits({
  repo,
  url,
  onSet,
}: {
  repo: string | null;
  url: string | null;
  onSet: (repo: string) => Promise<string | undefined>;
}) {
  const [refused, setRefused] = useState<string>();

  return (
    <section className="group">
      <h3 className="group-label">Self-edits</h3>
      <div className="card">
        <div className="row">
          <span className="row-tile">
            <Icon name="repo" size={15} />
          </span>
          <span className="row-text">
            <span className="row-label">ky's repo</span>
            <span className="row-sub">ky changes itself through pull requests here</span>
          </span>
          <InlineEdit
            value={repo ?? ""}
            className="repo-edit"
            title="Edit ky's repo"
            empty="Not set"
            label="ky's GitHub repo"
            placeholder="owner/name"
            maxLength={200}
            onSave={(next) => void onSet(next).then(setRefused)}
          />
        </div>
        {refused ? (
          <p className="automation-refused" role="alert">
            {refused}
          </p>
        ) : null}
        <div className="row">
          <span className="row-tile">
            <Icon name="globe" size={15} />
          </span>
          <span className="row-text">
            <span className="row-label">ky's address</span>
            <span className="row-sub">Taken from the page that sets the repo</span>
          </span>
          <span className="row-value repo-edit">{url ?? <span className="quiet">Set with the repo</span>}</span>
        </div>
      </div>
    </section>
  );
}

// The tools ky can use, listed on request.
function ToolsGroup({ catalog }: { catalog: readonly ToolInfo[] }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="group">
      <h3 className="group-label">Tools</h3>
      <div className="card">
        <button type="button" className="row disclosure" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <span className="row-tile">
            <Icon name="terminal" size={15} />
          </span>
          <span className="row-label">What ky can use</span>
          <span className="row-value tabular">{catalog.length}</span>
          <Icon name="chevronRight" size={14} className="row-chevron chevron" />
        </button>
        {open ? (
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
  );
}

function Settings({
  settings,
  setup,
  catalog,
  machines,
  subscriptions,
  now,
  theme,
  onTheme,
  onSet,
  onSetMachine,
  onSetRepo,
  keyActions,
}: {
  settings: SettingsView | null;
  setup: SetupView | null;
  catalog: readonly ToolInfo[];
  machines: readonly MachineInfo[];
  subscriptions: SubscriptionsData;
  now: number;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onSet: (purpose: Purpose, choice: ModelChoice) => void;
  onSetMachine: (machine: string, change: MachineChange) => void;
  onSetRepo: (repo: string) => Promise<string | undefined>;
  keyActions: KeyActions;
}) {
  const [openPurpose, setOpenPurpose] = useState<Purpose | null>(null);

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
        ) : Object.keys(settings.purposes).length === 0 ? (
          <p className="panel-note">No model provider is enabled.</p>
        ) : (
          <ul className="card">
            {PURPOSES.flatMap(({ purpose, label, hint }) => {
              const current = settings.purposes[purpose];

              return current
                ? [
                    <ModelRow
                      key={purpose}
                      purpose={purpose}
                      current={current}
                      label={label}
                      hint={hint}
                      settings={settings}
                      open={openPurpose === purpose}
                      onToggle={() => setOpenPurpose((value) => (value === purpose ? null : purpose))}
                      onSet={onSet}
                    />,
                  ]
                : [];
            })}
          </ul>
        )}
      </section>
      {settings ? <Services settings={settings} setup={setup} keyActions={keyActions} /> : null}
      <Subscriptions {...subscriptions} now={now} paired={machines.length > 0} />
      <Executor />
      <MachineList
        machines={machines}
        now={now}
        subscribed={subscriptions.views.some((view) => view.connected)}
        onSet={onSetMachine}
      />
      <ToolsGroup catalog={catalog} />
      {setup ? <SelfEdits repo={setup.repo} url={setup.url} onSet={onSetRepo} /> : null}
    </div>
  );
}
