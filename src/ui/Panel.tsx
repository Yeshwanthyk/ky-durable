import { type FormEvent, Fragment, type KeyboardEvent, type ReactNode, type RefObject, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import Type, { type Static } from "typebox";
import { parseOr } from "../core/decode";
import { CONNECTION_TONE, type ConnectionKind } from "../connection";
import type { MachineChange, MachineFacts, MachineLogin, MachineState } from "../machines/contract";
import type { SandboxChange, SandboxDraft } from "../runners/contract";
import { osName } from "../protocol";
import type {
  CloudState,
  MachineInfo,
  ProviderInfo,
  SandboxesView,
  SandboxInfo,
  SavedDisk,
  SettingsView,
  SetupView,
  VendorOption,
  MemoryView,
  ModelChoice,
  ModelOption,
  Purpose,
  SoulChange,
  SoulVersion,
  SoulView,
  SpecialistAccess,
  SpecialistView,
  TaskRow,
  ToolInfo,
} from "../protocol";
import { Pick, type RoutinesView, RoutinesPage, Timeline, TODAY, TodayHead, useZone } from "./Automations";
import { BROWSER_ZONE, clockIn, sameDay } from "./schedule";
import { Attachments, FilesContext, isMedia } from "./Attachments";
import { OFFLINE_TITLE, OnlineContext } from "./online";
import { Changes } from "./Changes";
import { CopyButton, CopyLine } from "./CopyButton";
import type { BlobVariantId } from "./blob-catalog";
import { BotAvatar } from "./BotAvatar";
import { KY_AVATAR } from "../avatars/contract";
import { Icon, Spinner, type IconName } from "../chat-kit/Icon";
import { EmptyState, RowValue, Segmented, SegmentedOption, VaultBadge } from "./Controls";
import { ACCENTS, type Accent, setAccent, useAccent } from "./use-accent";
import { plain } from "./plain";
import type { MemoryActions } from "./Memory";
import { Soul, type SpecialistActions } from "./Soul";
import { Executor } from "./Executor";
import { BrowserLogins } from "./BrowserLogins";
import { Inbound } from "./Inbound";
import { Mail } from "./Mail";
import { Proactivity, ProactivityValue } from "./Proactivity";
import { Spend, SpendValue } from "./Spend";
import { LastNight } from "./LastNight";
import { Peers } from "./Peers";
import { Problem, Subscriptions, type SubscriptionsData } from "./Subscriptions";
import { currentStep, elapsed, isLive, quietNote, spendParts } from "./task-progress";
import { TaskTimeline } from "./Timeline";
import { ago, clock, day } from "./time";
import { SETTINGS_HOME, SettingsNavContext, type SettingsPage } from "./use-panel";
import { NAME } from "./open-chat";

export type Theme = "light" | "dark";

export type PanelTab = "activity" | "soul" | "settings";

// Who ky is and how it is doing, then everything it is doing and has done, its soul and memory, and its settings.
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
  soul,
  memory,
  memoryActions,
  specialists,
  specialistAccess,
  specialistActions,
  subscriptions,
  theme,
  onTheme,
  onSetModel,
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
  status: { label: string; connected: boolean; kind: ConnectionKind };
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
  soul: SoulView | null;
  memory: MemoryView | null;
  memoryActions: MemoryActions;
  specialists: readonly SpecialistView[];
  specialistAccess: Readonly<Record<string, SpecialistAccess>>;
  specialistActions: SpecialistActions;
  subscriptions: SubscriptionsData;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onSetModel: (purpose: Purpose, choice: ModelChoice) => void;
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
        <BotAvatar name={name} variantId={variantId} owner={KY_AVATAR} active={active} size={24} />
        {/* The chat's own pill shows who and how connected; here it stays for screen readers. */}
        <div className="profile-text">
          <h2 className="profile-name">{name}</h2>
          <p className="profile-status" role="status">
            <span className="status-dot" data-connected={status.connected} data-tone={CONNECTION_TONE[status.kind]} />
            {status.label}
            <span className="quiet"> · {model}</span>
          </p>
        </div>
        <PanelTabs tab={tab} onTab={onTab} />
      </header>
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
      ) : null}
      {tab === "soul" ? (
        <Soul
          soul={soul}
          now={now}
          onChange={onSoulChange}
          onHistory={onSoulHistory}
          memory={memory}
          memoryActions={memoryActions}
          specialists={specialists}
          specialistAccess={specialistAccess}
          specialistActions={specialistActions}
          providers={settings?.providers ?? []}
          machines={machines}
        />
      ) : null}
      {tab === "settings" ? (
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
      ) : null}
    </aside>
  );
}

const PANEL_TABS = [
  ["activity", "Activity"],
  ["soul", "Soul"],
  ["settings", "Settings"],
] as const satisfies readonly (readonly [PanelTab, string])[];

const TAB_ICON: Partial<Record<PanelTab, ReactNode>> = {
  settings: <Icon name="gear" size={14} className="gear" />,
  soul: <Icon name="fingerprint" size={14} />,
};

// The panel's three tabs, beside who ky is.
function PanelTabs({ tab, onTab }: { tab: PanelTab; onTab: (tab: PanelTab) => void }) {
  return (
    <Segmented role="tablist" chosen={tab}>
      {PANEL_TABS.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={tab === id} className="pressable" onClick={() => onTab(id)}>
          {TAB_ICON[id] ?? null}
          {label}
        </button>
      ))}
    </Segmented>
  );
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** chat.css's --ease-out, for the motion that runs in script. */
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

/** How long a row or section takes to open its space, and the faster close. */
const ARRIVE_MS = 220;

const LEAVE_MS = 180;

/**
 * The space an element takes besides its height. A first child's room includes the margin the next
 * one has because of it, so that one is taken back with a negative margin instead.
 */
function spaceOf(element: HTMLElement): Keyframe {
  return element.previousElementSibling ? { marginTop: getComputedStyle(element).marginTop } : { marginBottom: "0px" };
}

/** The same with the element taking no room at all. */
function noSpaceOf(element: HTMLElement): Keyframe {
  if (element.previousElementSibling) return { marginTop: "0px" };
  const next = element.nextElementSibling;
  const below = next ? getComputedStyle(next).marginTop : "0px";

  return { marginBottom: `-${below}` };
}

/** Opens an element's space from nothing as it slides and fades in; with reduced motion, only the fade. */
function arrive(element: HTMLElement) {
  if (reducedMotion()) {
    element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ARRIVE_MS, easing: EASE_OUT });

    return;
  }

  const height = `${element.offsetHeight}px`;

  const animation = element.animate(
    [
      { height: "0px", opacity: 0, transform: "translateY(-6px)", ...noSpaceOf(element) },
      { height, opacity: 1, transform: "none", ...spaceOf(element) },
    ],
    { duration: ARRIVE_MS, easing: EASE_OUT },
  );

  element.style.overflowY = "clip";
  animation.onfinish = animation.oncancel = () => element.style.removeProperty("overflow-y");
}

/** Closes an element's space as it fades, and holds it closed until React removes it. */
function leave(element: HTMLElement) {
  const keyframes: Keyframe[] = reducedMotion()
    ? [{ opacity: 1 }, { opacity: 0 }]
    : [
        { height: `${element.offsetHeight}px`, opacity: 1, ...spaceOf(element) },
        { height: "0px", opacity: 0, ...noSpaceOf(element) },
      ];

  element.style.overflowY = "clip";
  element.animate(keyframes, { duration: LEAVE_MS, easing: EASE_OUT, fill: "forwards" });
}

/** Undoes `leave`, leaving any other animation alone. */
function unleave(element: HTMLElement | null) {
  for (const animation of element?.getAnimations() ?? []) {
    if (animation.effect?.getTiming().fill === "forwards") animation.cancel();
  }

  element?.style.removeProperty("overflow-y");
}

/** A row that has just finished glows once in its tone, and its state's dot pops in. */
function settle(row: HTMLElement) {
  const status = row.dataset.status;

  if (status !== "done" && status !== "failed") return;
  // Held a beat first, or the ease-out would spend the glow before the eye finds the row.
  row.animate([{ opacity: 1 }, { opacity: 1, offset: 0.15, easing: EASE_OUT }, { opacity: 0 }], {
    duration: 1200,
    pseudoElement: "::after",
  });
  row.querySelector(".state")?.animate(
    reducedMotion()
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, transform: "scale(0.6)" },
          { opacity: 1, transform: "none" },
        ],
    { duration: 250, easing: EASE_OUT, pseudoElement: "::before" },
  );
}

/**
 * What arrives in Activity while it is open opens its own space instead of pushing the rest down at
 * once; a task that finishes glows in its new place. Everything marked `data-arrive` is compared
 * with the last commit, so what was there when Activity opened just shows.
 */
function useArrivals(body: RefObject<HTMLElement | null>) {
  const seen = useRef<ReadonlySet<string>>(null);

  useLayoutEffect(() => {
    const elements = [...(body.current?.querySelectorAll<HTMLElement>("[data-arrive]") ?? [])];
    const before = seen.current;

    seen.current = new Set(elements.map((element) => element.dataset.arrive ?? ""));

    if (before === null) return;
    // Show earlier's rows have their own entry.
    const fresh = elements.filter((element) => !before.has(element.dataset.arrive ?? "") && !element.closest('[data-earlier="true"]'));

    for (const element of fresh) {
      // A row inside a section that arrives too comes with it.
      if (!fresh.some((other) => other !== element && other.contains(element))) arrive(element);

      if (before.has(`now:${element.dataset.task}`)) settle(element);
    }
  });
}

/** How many times a value has changed since mount, counted during render so the change shows in the same frame. */
function useChanges<T>(value: T): number {
  const [last, setLast] = useState(value);
  const [count, setCount] = useState(0);

  if (last !== value) {
    setLast(value);
    setCount((changes) => changes + 1);
  }

  return count;
}

/**
 * Live tasks that just left the list, each with where it stood, kept a moment so their rows can
 * close their space while the finished row opens in its day.
 */
function useLeaving(live: readonly TaskRow[]): readonly { task: TaskRow; at: number }[] {
  const version = live.map((task) => `${task.id}:${task.status}:${task.updated_at}`).join(" ");
  const [last, setLast] = useState({ version, live });
  const [leaving, setLeaving] = useState<readonly { task: TaskRow; at: number }[]>([]);

  if (last.version !== version) {
    const stays = (task: TaskRow) => live.some((each) => each.id === task.id);
    const gone = last.live.flatMap((task, at) => (stays(task) ? [] : [{ task, at }]));

    setLast({ version, live });

    if (gone.length > 0 || leaving.some(({ task }) => stays(task)))
      setLeaving((rows) => [...rows.filter(({ task }) => !stays(task)), ...gone]);
  }

  useEffect(() => {
    if (leaving.length === 0) return;
    const timer = setTimeout(() => setLeaving([]), LEAVE_MS);

    return () => clearTimeout(timer);
  }, [leaving]);

  return leaving;
}

type FeedProps = {
  session: string;
  now: number;
  machines: readonly MachineInfo[];
  onOpen: (session: string) => void;
  onStop: (task: string) => void;
};

// What is running now, then today on a timeline with its finished tasks folded in, then earlier days. The header
// opens every routine, and a row opens its routine's form, each in place of the timeline.
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
  const body = useRef<HTMLDivElement>(null);
  const zone = useZone();
  const [view, setView] = useState<RoutinesView>(TODAY);
  const [run, setRun] = useState<TaskRow | null>(null);
  const live = tasks.filter(isLive);
  const past = tasks.filter((task) => !isLive(task));
  // A routine's fire is its row on the timeline, so today's fold holds only the work chats handed out.
  const today = past.filter((task) => sameDay(task.updated_at, feed.now, zone) && routineOf(task) === null);
  const earlier = past.filter((task) => !sameDay(task.updated_at, feed.now, zone));
  const latest = today[0];
  const finished = latest ? { at: latest.updated_at, row: <FinishedFold key="finished" latest={latest} tasks={today} {...feed} /> } : null;

  // A fire's row opens its run, as the task's own row would; false when there is no run to open.
  const openRun = (automation: string) => {
    const fired = tasks.find((task) => routineOf(task) === automation);

    if (fired) setRun(fired);

    return fired !== undefined;
  };

  useArrivals(body);

  // Each page starts at its top.
  const show = (next: RoutinesView) => {
    setView(next);
    body.current?.scrollTo({ top: 0 });
  };

  if (view.page !== "today")
    return (
      <div ref={body} className="panel-body" data-scroll>
        <RoutinesPage view={view} now={feed.now} zone={zone} session={feed.session} onView={show} />
      </div>
    );

  return (
    <div ref={body} className="panel-body" data-scroll>
      <NowSection live={live} running={running} onStopAll={onStopAll} {...feed} />
      <section className="feed-group today" aria-label="Today">
        <TodayHead now={feed.now} zone={zone} onView={show} />
        <Timeline now={feed.now} zone={zone} busy={live.length + running.length > 0} finished={finished} onView={show} onRun={openRun} />
      </section>
      {run ? <TaskSheet task={run} now={feed.now} onClose={() => setRun(null)} onOpen={feed.onOpen} /> : null}
      <LastNight now={feed.now} />
      <History past={earlier} {...feed} />
    </div>
  );
}

/** The routine a task is a fire of (its source is `automation:<id>`), or null for work a chat handed out. */
function routineOf(task: TaskRow): string | null {
  return task.source.startsWith("automation:") ? task.source.slice("automation:".length) : null;
}

/** A task's time as every row writes it: "11:48 AM". */
const clockAt = (time: number) => clockIn(time, BROWSER_ZONE);

/** How long after a task finishes the fold opens on its own, to show it. */
const FRESH_MS = 5 * 60_000;

// Today's finished tasks on the timeline. Failed ones stay out as their own rows, since they need the user; the rest
// fold to one quieter row of how many. It opens on its own once one has just finished, and stays as the user leaves
// it after that.
function FinishedFold({ latest, tasks, ...feed }: FeedProps & { latest: TaskRow; tasks: readonly TaskRow[] }) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const [fresh, setFresh] = useState(false);
  const [shown, setShown] = useState(RECENT);
  const open = choice ?? fresh;
  const failed = tasks.filter((task) => task.status === "failed");
  const rest = tasks.filter((task) => task.status !== "failed");

  if (!fresh && rest.some((task) => Date.now() - task.updated_at < FRESH_MS)) setFresh(true);


  return (
    <li className="today-item today-fold" data-open={open || undefined}>
      {failed.length > 0 ? <FailedTasks failed={failed} feed={feed} /> : null}
      {rest.length > 0 ? (
        <button type="button" className="today-row disclosure" aria-expanded={open} onClick={() => setChoice(!open)}>
          <span className="today-time tabular">{failed.length > 0 ? null : clockAt(latest.updated_at)}</span>
          <span className="today-title">{foldLabel(rest, failed.length)}</span>
          <span className="today-note" />
          <Icon name="chevronRight" size={12} className="chevron" />
        </button>
      ) : null}
      {open && rest.length > 0 ? <FoldedTasks rest={rest} shown={shown} onMore={() => setShown((count) => count + EARLIER)} feed={feed} /> : null}
    </li>
  );
}

/** The fold's row: "3 tasks", or "3 more finished" under failed rows. */
function foldLabel(rest: readonly TaskRow[], failed: number): string {
  if (failed > 0) return `${rest.length} more finished`;
  const noun = rest.every((task) => task.kind === "cloud") ? "subagent task" : "task";

  return `${rest.length} ${noun}${rest.length === 1 ? "" : "s"}`;
}

// Failed tasks, each its own row above the fold, since they need the user.
function FailedTasks({ failed, feed }: { failed: readonly TaskRow[]; feed: FeedProps }) {
  return (
    <ul className="feed today-tasks today-failed">
      {failed.map((task, index) => (
        <TaskItem key={task.id} task={task} arriveKey={`past:${task.id}`} sameTime={sameTimeAs(failed, index)} {...feed} />
      ))}
    </ul>
  );
}

// The fold opened: the latest finished tasks, and a way to show earlier ones.
function FoldedTasks({ rest, shown, onMore, feed }: { rest: readonly TaskRow[]; shown: number; onMore: () => void; feed: FeedProps }) {
  const earlier = new Set(rest.slice(RECENT, shown).map((task) => task.id));
  const hidden = rest.length - shown;

  return (
    <>
      <ul className="feed today-tasks">
        {rest.slice(0, shown).map((task, index) => (
          <TaskItem
            key={task.id}
            task={task}
            earlier={earlier.has(task.id)}
            arriveKey={`past:${task.id}`}
            sameTime={sameTimeAs(rest, index)}
            {...feed}
          />
        ))}
      </ul>
      {hidden > 0 ? (
        <button type="button" className="feed-more pressable" onClick={onMore}>
          Show earlier
          <span className="feed-more-count tabular">{hidden} more</span>
        </button>
      ) : null}
    </>
  );
}

// The open chat's running tools, and every queued or working task. A task that ends closes its row;
// the last one closes the whole section.
function NowSection({
  live,
  running,
  onStopAll,
  ...feed
}: FeedProps & { live: readonly TaskRow[]; running: readonly string[]; onStopAll: () => void }) {
  const leaving = useLeaving(live);
  const section = useRef<HTMLElement>(null);
  const online = useContext(OnlineContext);
  const empty = live.length === 0 && running.length === 0;
  const closing = empty && leaving.length > 0;

  useLayoutEffect(() => {
    if (closing) leave(section.current!);
    // A task that starts as the section closes opens it again.
    else unleave(section.current);
  }, [closing]);

  if (empty && !closing) return null;
  const rows = live.map((task) => ({ task, gone: false }));

  for (const { task, at } of leaving) rows.splice(Math.min(at, rows.length), 0, { task, gone: true });

  return (
    <section
      ref={section}
      className="feed-group"
      data-arrive={closing ? undefined : "now"}
      aria-hidden={closing || undefined}
      inert={closing}
    >
      <h3 className="feed-head">
        Now
        {live.length > 1 ? (
          <button type="button" className="feed-action pressable" disabled={!online} title={online ? undefined : OFFLINE_TITLE} onClick={onStopAll}>
            Stop all
          </button>
        ) : null}
      </h3>
      <ul className="feed">
        {running.map((tool, index) => (
          <li key={`${tool}-${index}`} className="feed-item ledger-item" data-live>
            <span className="ledger-button">
              <span className="ledger-lead">
                <StatusGlyph status="working" />
              </span>
              <span className="row-text">
                <span className="ledger-title">{tool}</span>
                <span className="row-sub">This chat</span>
              </span>
            </span>
          </li>
        ))}
        {rows.map(({ task, gone }) => (
          <TaskItem key={task.id} task={task} arriveKey={gone ? undefined : `now:${task.id}`} gone={gone && !closing} {...feed} />
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
        <section key={label} className="feed-group" data-earlier={earlier.has(rows[0]!.id)} data-arrive={`day:${label}`}>
          <h3 className="feed-head">{label}</h3>
          <ul className="feed">
            {rows.map((task, index) => (
              <TaskItem
                key={task.id}
                task={task}
                earlier={earlier.has(task.id)}
                arriveKey={`past:${task.id}`}
                sameTime={sameTimeAs(rows, index)}
                {...feed}
              />
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

// The sandboxes first (the server lists them so), then your computers, each opening its own page; then adding either, and the disks of deleted sandboxes.
function MachineList({
  machines,
  repos,
  now,
}: {
  machines: readonly MachineInfo[];
  /** The repos picked in Settings › Subscriptions › GitHub, which sandboxes may take. */
  repos: readonly string[];
  now: number;
}) {
  const [sandboxes, reload] = useSandboxes(machines);

  return (
    <section className="group machines" id="settings-machines">
      <h3 className="group-label">Machines</h3>
      {machines.length === 0 ? (
        <EmptyState icon="monitor">No machines yet</EmptyState>
      ) : (
        <ul className="card">
          {machines.map((machine) => (
            <MachineLink key={machine.name} machine={machine} now={now} />
          ))}
        </ul>
      )}
      <MachineActions machines={machines} sandboxes={sandboxes} repos={repos} owned={ownedRepos(machines)} now={now} onChanged={reload} />
    </section>
  );
}

/** Every repo a sandbox has taken. */
const ownedRepos = (machines: readonly MachineInfo[]) => machines.flatMap((machine) => machine.sandbox?.repos ?? []);

// Under the machine list: adding a computer or a sandbox, then the disks deleted sandboxes kept.
function MachineActions({
  machines,
  sandboxes,
  repos,
  owned,
  now,
  onChanged,
}: {
  machines: readonly MachineInfo[];
  sandboxes: SandboxesView | null;
  repos: readonly string[];
  owned: readonly string[];
  now: number;
  onChanged: () => void;
}) {
  const live = machines.filter((machine) => machine.sandbox !== null).length;

  if (!sandboxes?.enabled) {
    return (
      <div className="group-actions">
        <AddMachine now={now} />
      </div>
    );
  }

  return (
    <>
      <div className="group-actions">
        <AddMachine now={now} />
        <AddSandbox view={sandboxes} live={live} repos={repos} owned={owned} onAdded={onChanged} />
      </div>
      <KeptDisks view={sandboxes} now={now} onChanged={onChanged} />
    </>
  );
}

/** Settings' sandboxes, asked for again when the live ones change or `reload` is called; null until they come. */
function useSandboxes(machines: readonly MachineInfo[]): readonly [SandboxesView | null, () => void] {
  const [view, setView] = useState<SandboxesView | null>(null);
  const [asked, setAsked] = useState(0);
  const live = machines.flatMap((machine) => (machine.sandbox ? [machine.sandbox.id] : [])).join(" ");

  useEffect(() => {
    let current = true;

    void fetch("/api/sandboxes").then(async (response) => {
      const sandboxes = response.ok ? parseOr(SandboxesSchema, await response.text(), null) : null;

      if (current && sandboxes) setView(sandboxes);
    });

    return () => {
      current = false;
    };
  }, [live, asked]);

  return [view, () => setAsked((count) => count + 1)];
}

const SavedDiskSchema = Type.Union([Type.Object({ size: Type.Number(), savedAt: Type.Number() }), Type.Null()]);

/** GET /api/sandboxes' answer. */
const SandboxesSchema = Type.Object({
  enabled: Type.Boolean(),
  cap: Type.Number(),
  saves: Type.Record(Type.String(), SavedDiskSchema),
  kept: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), repos: Type.Array(Type.String()), deletedAt: Type.Number(), save: SavedDiskSchema }))
});

/** The sandbox routes' answer: `{ problem }` or a sandbox when they did it, `{ refused }` when they didn't. */
const SandboxAnswerSchema = Type.Object({ problem: Type.Optional(Type.Union([Type.String(), Type.Null()])), refused: Type.Optional(Type.String()) });

/** What Settings sends the sandbox routes: a new sandbox, or a change to one. */
type SandboxBody = SandboxDraft | SandboxChange;

/** Send a sandbox change; resolves with what went wrong, or null. */
async function sandboxCall(path: string, method: string, body?: SandboxBody): Promise<string | null> {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const answer = parseOr(SandboxAnswerSchema, await response.text().catch(() => ""), null);

  if (response.ok) return answer?.problem ?? null;

  return answer?.refused ?? `${NAME} could not do that (HTTP ${response.status}).`;
}

/** A disk's size in words: "640 MB", "1.2 GB". */
function diskSize(bytes: number): string {
  return bytes < 1e9 ? `${Math.max(1, Math.round(bytes / 1e6))} MB` : `${(bytes / 1e9).toFixed(1)} GB`;
}

// Checkboxes for the picked repos, and any the sandbox already has; `taken` ones are another sandbox's.
function RepoPicks({
  label,
  repos,
  chosen,
  taken,
  onChange,
}: {
  label: string;
  repos: readonly string[];
  chosen: readonly string[];
  taken: readonly string[];
  onChange: (repos: string[]) => void;
}) {
  const all = [...new Set([...repos.map((repo) => repo.toLowerCase()), ...chosen])].sort();

  if (all.length === 0) return <span className="field-value">Pick repos in Subscriptions › GitHub first</span>;

  return (
    <fieldset className="github-repos sandbox-repos" aria-label={label}>
      {all.map((repo) => {
        const on = chosen.includes(repo);

        return (
          <label key={repo} className="github-repo">
            <input
              type="checkbox"
              checked={on}
              disabled={!on && taken.includes(repo)}
              onChange={() => onChange(on ? chosen.filter((each) => each !== repo) : [...chosen, repo])}
            />
            {repo}
            {!on && taken.includes(repo) ? <span className="quiet">another sandbox's</span> : null}
          </label>
        );
      })}
    </fieldset>
  );
}

// A sandbox's own choices: its repos, whether it is the default, how long it stays up idle, and its saved disk.
function SandboxFields({
  machine,
  sandbox,
  repos,
  taken,
  saved,
  now,
}: {
  machine: MachineInfo;
  sandbox: SandboxInfo;
  repos: readonly string[];
  taken: readonly string[];
  saved: SavedDisk | null | undefined;
  now: number;
}) {
  const [error, setError] = useState<string | null>(null);
  const path = `/api/sandboxes/${encodeURIComponent(sandbox.id)}`;
  const change = async (body: SandboxChange) => setError(await sandboxCall(path, "PATCH", body));

  return (
    <>
      <MachineField
        label="Repos"
        hint={sandbox.repos.length === 0 ? "None: it reaches every picked repo, and gets tasks by name or as the default" : "Tasks for these come here; it pushes only to these"}
      >
        <RepoPicks
          label={`Repos ${machine.name} works on`}
          repos={repos}
          chosen={sandbox.repos}
          taken={taken}
          onChange={(next) => void change({ repos: next })}
        />
      </MachineField>
      <MachineField label="Default" hint={sandbox.isDefault ? "Tasks that name no machine come here" : "Another sandbox takes tasks that name no machine"}>
        {sandbox.isDefault ? (
          <span className="field-value">This one</span>
        ) : (
          <button type="button" className="automation-text pressable" onClick={() => void change({ isDefault: true })}>
            Make it the default
          </button>
        )}
      </MachineField>
      <MachineField label="Stays up idle" hint="Minutes, then it saves its disk and sleeps">
        <InlineEdit
          value={sandbox.idleMinutes === null ? "" : String(sandbox.idleMinutes)}
          className="sandbox-idle"
          title="Change how long it stays up idle"
          empty="The deploy's setting"
          label={`Idle minutes for ${machine.name}`}
          placeholder="Minutes, 1 to 1440; empty for the deploy's"
          maxLength={4}
          onSave={(next) => void change({ idleMinutes: next.trim() === "" ? null : Number(next) })}
        />
      </MachineField>
      <MachineField label="Saved disk" hint={saved ? undefined : "It saves one when it sleeps"}>
        <span className="field-value">{saved ? `${diskSize(saved.size)} · ${agoInWords(saved.savedAt, now)}` : "None yet"}</span>
      </MachineField>
      {error ? (
        <p className="machine-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

// Deleting a sandbox, once the user confirms it; its disk is kept.
function SandboxDelete({ machine, sandbox, onDeleted }: { machine: MachineInfo; sandbox: SandboxInfo; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(await sandboxCall(`/api/sandboxes/${encodeURIComponent(sandbox.id)}`, "DELETE"));
    setBusy(false);
    setConfirming(false);
    onDeleted();
  };

  return (
    <>
      {confirming ? (
        <div className="machine-confirm" role="alertdialog" aria-label={`Delete ${machine.name}`}>
          <p>
            Delete {machine.name}? Its tasks end, and its container saves its disk and stops. The disk is kept under Kept
            disks, to start a new sandbox from.
          </p>
          <div className="machine-confirm-actions">
            <button type="button" className="automation-text pressable" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button type="button" className="machine-unpair-confirm pressable" disabled={busy} onClick={() => void remove()}>
              {busy ? "Saving its disk…" : "Delete"}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="machine-unpair pressable" onClick={() => setConfirming(true)}>
          Delete this sandbox
        </button>
      )}
      {error ? (
        <p className="machine-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

// A new sandbox: its name, its repos, and a fresh disk or a kept one; up to the cap.
function AddSandbox({
  view,
  live,
  repos,
  owned,
  onAdded,
}: {
  view: SandboxesView;
  live: number;
  repos: readonly string[];
  owned: readonly string[];
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (live >= view.cap) return <span className="actions-note">{`${view.cap} of ${view.cap} sandboxes`}</span>;

  if (!open) {
    return (
      <button type="button" className="pill pressable" onClick={() => setOpen(true)}>
        <Icon name="cloud" />
        Add a sandbox
      </button>
    );
  }

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const draft: SandboxDraft = from === "" ? { name, repos: chosen } : { name, repos: chosen, from };
    const problem = await sandboxCall("/api/sandboxes", "POST", draft);

    setError(problem);

    if (problem !== null) return;
    setOpen(false);
    setName("");
    setChosen([]);
    setFrom("");
    onAdded();
  };

  return (
    <form className="card form-card sandbox-add" aria-label="Add a sandbox" onSubmit={(event) => void add(event)}>
      <p className="field-hint">{NAME}'s own Linux machine in Cloudflare. A task wakes it; it sleeps when idle.</p>
      <label className="field" data-stack>
        <span className="field-label">Name</span>
        <input className="field-input" value={name} placeholder="e.g. web" maxLength={32} required onChange={(event) => setName(event.currentTarget.value)} />
      </label>
      <MachineField label="Repos" hint="Tasks for these go to it; none lets it reach every picked repo">
        <RepoPicks label="The new sandbox's repos" repos={repos} chosen={chosen} taken={owned} onChange={setChosen} />
      </MachineField>
      {view.kept.length === 0 ? null : (
        <label className="field">
          <span className="field-label">Disk</span>
          <select className="field-select" value={from} onChange={(event) => setFrom(event.currentTarget.value)}>
            <option value="">A fresh disk</option>
            {view.kept.map((disk) => (
              <option key={disk.id} value={disk.id}>
                {disk.name}'s kept disk
              </option>
            ))}
          </select>
        </label>
      )}
      {error ? (
        <p className="machine-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="card-foot">
        <button type="button" className="automation-text pressable" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="pill primary pressable">
          Add
        </button>
      </div>
    </form>
  );
}

type KeptDiskInfo = SandboxesView["kept"][number];

/** A kept disk in a few words: its size, when its sandbox went, and the repos it had. */
function keptLine(disk: KeptDiskInfo, now: number): string {
  const repos = disk.repos.length > 0 ? ` · ${disk.repos.join(", ")}` : "";

  return `${disk.save ? diskSize(disk.save.size) : "no save"} · deleted ${agoInWords(disk.deletedAt, now)}${repos}`;
}

// A kept disk's row, and deleting it once the user confirms.
function KeptDisk({
  disk,
  now,
  confirming,
  onConfirm,
  onDelete,
}: {
  disk: KeptDiskInfo;
  now: number;
  confirming: boolean;
  onConfirm: (yes: boolean) => void;
  onDelete: () => void;
}) {
  return (
    <li className="item">
      <div className="row">
        <span className="row-tile">
          <Icon name="archive" size={15} />
        </span>
        <span className="row-text">
          <span className="row-label">{disk.name}</span>
          <span className="row-sub">{keptLine(disk, now)}</span>
        </span>
        {confirming ? null : (
          <button type="button" className="automation-text danger pressable" onClick={() => onConfirm(true)}>
            Delete this disk
          </button>
        )}
      </div>
      {confirming ? (
        <div className="item-body">
          <div className="machine-confirm" role="alertdialog" aria-label={`Delete ${disk.name}'s disk`}>
            <p>Delete {disk.name}'s disk for good? Its files are gone after this.</p>
            <div className="machine-confirm-actions">
              <button type="button" className="automation-text pressable" onClick={() => onConfirm(false)}>
                Cancel
              </button>
              <button type="button" className="machine-unpair-confirm pressable" onClick={onDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}

// The disks of deleted sandboxes, until the user deletes them for good.
function KeptDisks({ view, now, onChanged }: { view: SandboxesView; now: number; onChanged: () => void }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (view.kept.length === 0) return null;

  const remove = async (id: string) => {
    setConfirming(null);
    setError(await sandboxCall(`/api/sandboxes/kept/${encodeURIComponent(id)}`, "DELETE"));
    onChanged();
  };

  return (
    <div className="sandbox-kept">
      <h4 className="group-sublabel">Kept disks</h4>
      <ul className="card">
        {view.kept.map((disk) => (
          <KeptDisk
            key={disk.id}
            disk={disk}
            now={now}
            confirming={confirming === disk.id}
            onConfirm={(yes) => setConfirming(yes ? disk.id : null)}
            onDelete={() => void remove(disk.id)}
          />
        ))}
      </ul>
      {error ? (
        <p className="machine-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** POST /api/runners/codes' answer. */
const PairingCodeSchema = Type.Object({ code: Type.String(), expiresAt: Type.Number() });

type PairingCode = Static<typeof PairingCodeSchema>;

// A single-use code for one more machine, and the command that pairs it with the code.
function AddMachine({ now }: { now: number }) {
  const [code, setCode] = useState<PairingCode | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setError(null);
    const response = await fetch("/api/runners/codes", { method: "POST" });

    const made = response.ok ? parseOr(PairingCodeSchema, await response.text(), null) : null;

    if (!made) {
      setError(`${NAME} could not make a code (HTTP ${response.status}).`);

      return;
    }

    setCode(made);
  };

  return (
    <>
      <button type="button" className="pill pressable" onClick={() => void add()}>
        <Icon name="monitor" />
        {code === null ? "Add a machine" : "New code"}
      </button>
      <Problem text={error ?? undefined} />
      {code === null ? null : <PairingCommand code={code} now={now} />}
    </>
  );
}

// The command that pairs a computer with `code`, until the code expires.
function PairingCommand({ code, now }: { code: PairingCode; now: number }) {
  if (code.expiresAt <= now) return <EmptyState icon="clock">That code expired. Make a new one.</EmptyState>;

  return (
    <div className="card code-card machine-code">
      <CopyLine text={`ky runner add ${location.origin} ${code.code}`} label="Pairing command" />
      <p className="card-note">{`Run this on the computer before ${clock(code.expiresAt)}. It works once.`}</p>
    </div>
  );
}

/** Whether ky may give the machine work. */
const MACHINE_STATES: ReadonlyArray<readonly [MachineState, string]> = [
  ["on", "On"],
  ["paused", "Paused"],
  ["off", "Off"],
];

/** Whose Claude Code and Codex logins its tasks use. */
const MACHINE_LOGINS: ReadonlyArray<readonly [MachineLogin, string]> = [
  ["own", "This computer's"],
  ["ky", "From Subscriptions"],
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
type MachineStatus = { tone: "online" | "paused" | "waking" | "off" | "offline"; text: string };

/** What an online computer's dot and status say for each state. */
const STATE_STATUS = {
  on: ["online", "Online"],
  paused: ["paused", "Paused"],
  off: ["off", "Off"],
} as const satisfies Record<MachineState, readonly [MachineStatus["tone"], string]>;

/** What the cloud machine's dot and status say in each state, and with no task. */
const CLOUD_STATUS = {
  asleep: ["offline", "Asleep", "wakes when it's sent a task"],
  waking: ["waking", "Waking", "starting up"],
  running: ["online", "Running", "idle"],
} as const satisfies Record<CloudState, readonly [MachineStatus["tone"], string, string]>;

/** When an offline computer was last seen, and what waits for it. */
function offlineStatus(machine: MachineInfo, now: number): MachineStatus {
  const waiting = machine.active > 0 ? ` · ${machine.active} waiting` : "";

  return { tone: "offline", text: `Offline · last seen ${agoInWords(machine.seenAt, now)}${waiting}` };
}

/** The cloud machine's status: asleep, waking or running, and its tasks. */
function cloudStatus(cloud: CloudState, active: number): MachineStatus {
  const [tone, word, none] = CLOUD_STATUS[cloud];

  return { tone, text: `${word} · ${active === 0 ? none : plural(active, "task")}` };
}

/** The machine's status as a tone for its dot and a line of words. */
function machineStatus(machine: MachineInfo, now: number): MachineStatus {
  if (machine.cloud !== null) return cloudStatus(machine.cloud, machine.active);

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

/** Whether the machine is a sandbox, which sleeps instead of going offline and is deleted instead of unpaired. */
const isCloud = (machine: MachineInfo) => machine.cloud !== null;

/** What a machine is, in a few words: its OS and Chrome and repos, or a sandbox's default and repos. */
function machineSummary(machine: MachineInfo): string | null {
  const facts = factsLine(machine.facts);

  if (!machine.sandbox) return facts;
  const parts = [facts ?? "Linux", reachOf(machine.sandbox)];

  if (machine.sandbox.isDefault) parts.splice(1, 0, "default");

  return parts.join(" · ");
}

/** Which repos a sandbox takes: its own, or every picked one when it has none. */
const reachOf = (sandbox: SandboxInfo) => (sandbox.repos.length === 0 ? "every picked repo" : plural(sandbox.repos.length, "repo"));

/** A machine's state in one word, and the tone that colours it. */
type MachineWord = { tone: MachineStatus["tone"]; word: string };

/** A machine's state in one word, coloured by its tone; a sleeping sandbox is quiet, not offline. */
function stateOf(machine: MachineInfo, now: number): MachineWord {
  const status = machineStatus(machine, now);
  const word = status.text.split(" · ")[0] ?? status.text;

  return { tone: isCloud(machine) && status.tone === "offline" ? "off" : status.tone, word };
}

// A machine's row: its name and what it is, and its state in a word; it opens the machine's page.
function MachineLink({ machine, now }: { machine: MachineInfo; now: number }) {
  const state = stateOf(machine, now);
  const summary = machineSummary(machine);

  return (
    <PageLink
      to={{ kind: "machine", name: machine.name }}
      icon={isCloud(machine) ? "cloud" : "monitor"}
      label={machine.name}
      sub={summary ? <span className="row-sub-text">{summary}</span> : null}
    >
      <span className="state" data-tone={state.tone}>
        {state.word}
      </span>
    </PageLink>
  );
}

// A machine's page: how it is doing, whether ky may use it, whose logins it uses, what it is for, then a sandbox's own choices or unpairing.
function MachinePage({ page, machines, subscriptions, now, onSetMachine }: PageProps) {
  const machine = page.kind === "machine" ? machines.find((each) => each.name === page.name) : undefined;

  if (machine === undefined) return <MachineGone name={page.kind === "machine" ? page.name : ""} />;

  return <MachineDetail machine={machine} machines={machines} subscriptions={subscriptions} now={now} onSet={onSetMachine} />;
}

// A machine that was unpaired or deleted while its page was open.
function MachineGone({ name }: { name: string }) {
  return (
    <>
      <PageHead title={name} />
      <EmptyState icon="monitor">This machine is no longer paired.</EmptyState>
    </>
  );
}

function MachineDetail({
  machine,
  machines,
  subscriptions,
  now,
  onSet,
}: {
  machine: MachineInfo;
  machines: readonly MachineInfo[];
  subscriptions: SubscriptionsData;
  now: number;
  onSet: (machine: string, change: MachineChange) => void;
}) {
  const [sandboxes, reload] = useSandboxes(machines);
  const status = machineStatus(machine, now);
  const summary = machineSummary(machine);

  return (
    <>
      <PageHead title={machine.name}>
        <span className="state" data-tone={stateOf(machine, now).tone}>
          {status.text}
        </span>
        {summary ? <span className="page-sub-line">{summary}</span> : null}
      </PageHead>
      <div className="card item-body machine-fields">
        <MachineRestart machine={machine} />
        <MachineSwitch machine={machine} onSet={onSet} />
        <MachineLoginSwitch machine={machine} subscribed={subscribedOf(subscriptions)} onSet={onSet} />
        <MachineNote machine={machine} onSet={onSet} />
        <MachineEnd
          machine={machine}
          repos={reposOf(subscriptions)}
          taken={ownedRepos(machines).filter((repo) => !machine.sandbox?.repos.includes(repo))}
          saved={machine.sandbox ? sandboxes?.saves[machine.sandbox.id] : undefined}
          now={now}
          onChanged={reload}
        />
      </div>
    </>
  );
}

/** Whether Settings › Subscriptions has a Claude or ChatGPT login saved. */
const subscribedOf = (subscriptions: SubscriptionsData) => subscriptions.views.some((view) => view.connected && view.kind !== "github");

/** The repos picked in Settings › Subscriptions › GitHub, which sandboxes may take. */
const reposOf = (subscriptions: SubscriptionsData) => subscriptions.views.find((view) => view.kind === "github")?.repos ?? [];

// The end of an open machine: a sandbox's own choices and deleting it, or unpairing a computer.
function MachineEnd({
  machine,
  repos,
  taken,
  saved,
  now,
  onChanged,
}: {
  machine: MachineInfo;
  repos: readonly string[];
  taken: readonly string[];
  saved: SavedDisk | null | undefined;
  now: number;
  onChanged: () => void;
}) {
  if (machine.sandbox) {
    return (
      <>
        <SandboxFields machine={machine} sandbox={machine.sandbox} repos={repos} taken={taken} saved={saved} now={now} />
        <SandboxDelete machine={machine} sandbox={machine.sandbox} onDeleted={onChanged} />
      </>
    );
  }

  return isCloud(machine) ? null : <MachineUnpair machine={machine} />;
}

// Unpairing a computer, once the user confirms it.
function MachineUnpair({ machine }: { machine: MachineInfo }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setConfirming(false);
    const response = await fetch(`/api/runners/${encodeURIComponent(machine.name)}`, { method: "DELETE" });

    setError(response.ok ? null : `${NAME} could not unpair ${machine.name} (HTTP ${response.status}).`);
  };

  return (
    <>
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
    </>
  );
}

// How to bring an offline computer back: the service restarts it, or the user starts it by hand. The cloud machine wakes itself,
// and shows only why it couldn't start or save, if it couldn't.
function MachineRestart({ machine }: { machine: MachineInfo }) {
  if (isCloud(machine) ? !machine.reason : machine.online) return null;

  // A reason names its own fix, which is never to start it again.
  if (machine.reason) {
    return (
      <div className="machine-restart">
        <p className="machine-reason">{machine.reason}</p>
      </div>
    );
  }

  return (
    <div className="machine-restart">
      <p>
        Start it there with{" "}
        <code className="machine-command" aria-label="Start command">
          ky runner run
        </code>
        <CopyButton text="ky runner run" label="Copy start command" />
      </p>
    </div>
  );
}

// A labelled choice in an open row: the label on the left, the control on the right or under it when it doesn't fit, and a line on what's chosen.
function MachineField({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

// On, paused or off: whether ky may use the machine.
function MachineSwitch({ machine, onSet }: { machine: MachineInfo; onSet: (machine: string, change: MachineChange) => void }) {
  return (
    <MachineField label="Takes tasks">
      <Segmented small role="radiogroup" aria-label={`Let ${NAME} use ${machine.name}`} chosen={machine.state}>
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
      </Segmented>
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
    <MachineField label="Claude & Codex login" hint={subscribed ? undefined : <LoginHint login={machine.login} />}>
      <Segmented small role="radiogroup" aria-label={`Whose login ${machine.name} uses`} chosen={machine.login}>
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
      </Segmented>
    </MachineField>
  );
}

// That Subscriptions has nothing to hand over yet.
function LoginHint({ login }: { login: MachineLogin }) {
  const { openSection } = useContext(SettingsNavContext);

  const saved = (
    <>
      Nothing is saved in{" "}
      <button type="button" className="refused-link" onClick={() => openSection("settings-subscriptions")}>
        Subscriptions
      </button>{" "}
      yet
    </>
  );

  return login === "ky" ? <>{saved}, so there is no login to hand over.</> : <>Its own logins. {saved}.</>;
}

// What the user says the machine is for; Enter or leaving the field saves, Escape puts it back.
function MachineNote({ machine, onSet }: { machine: MachineInfo; onSet: (machine: string, change: MachineChange) => void }) {
  const id = useId();

  const save = (next: string) => {
    if (next.trim() !== machine.note) onSet(machine.name, { note: next });
  };

  return (
    <div className="field" data-stack>
      <label className="field-label" htmlFor={id}>
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

/** A live task's status as one bare glyph: a spinner while it works, a quiet circle while it waits. */
function StatusGlyph({ status }: { status: TaskRow["status"] }) {
  // A glyph that changes on screen pops in; one that is simply shown does not.
  const changed = useChanges(status) > 0;

  return (
    <span className="feed-glyph" data-tone={status} data-pop={changed || undefined}>
      {status === "working" ? <Spinner key="spin" size={14} /> : <Icon key="wait" name="circle" size={16} />}
    </span>
  );
}

/** How a finished task ended, in one word. */
const STATUS_WORD: Record<TaskRow["status"], string> = {
  queued: "Queued",
  working: "Working",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/** How long a live task has run; how long a finished one took, and what it cost. */
const figuresOf = (task: TaskRow, now: number) => (isLive(task) ? [elapsed(task, now)] : spendParts(task, now));

/** A figure that says nothing: no time, no money. */
const NOTHING = /^(0s|\$0(\.0+)?)$/;

/** Who did it, then its figures: "webmac · 34s · 1 turn · $0.01". The line breaks only between parts. */
function TaskMeta({ task, now }: { task: TaskRow; now: number }) {
  // A routine's id names no one, and nothing spent says nothing.
  const who = task.worker.startsWith("automation-") ? [] : [task.worker];
  const parts = [...who, ...figuresOf(task, now).filter((part) => part !== null && !NOTHING.test(part))];

  if (parts.length === 0) return null;

  return (
    <span className="row-sub" title={task.worker}>
      {parts.map((part, index) => (
        <Fragment key={`${index}-${part}`}>
          {index === 0 ? null : " · "}
          <span className="part">{part}</span>
        </Fragment>
      ))}
    </span>
  );
}

/** A row's first column: when a finished task ended (blank under a row that says the same time), or a live one's spinner. */
function TaskLead({ task, sameTime }: { task: TaskRow; sameTime: boolean }) {
  return (
    <span className="ledger-lead tabular">
      {isLive(task) ? <StatusGlyph status={task.status} /> : sameTime ? null : clockAt(task.updated_at)}
    </span>
  );
}

/** Whether a finished row ends the same minute as the row above it, so its time is said once. */
const sameTimeAs = (tasks: readonly TaskRow[], index: number) => {
  const [task, before] = [tasks[index], tasks[index - 1]];

  return task !== undefined && before !== undefined && !isLive(task) && clockAt(task.updated_at) === clockAt(before.updated_at);
};

/** A finished task's last column: Done, Failed or Stopped in its colour. Live ones have Stop there instead. */
function TaskState({ task }: { task: TaskRow }) {
  if (isLive(task)) return null;

  return (
    <span className="state" data-tone={task.status}>
      {STATUS_WORD[task.status]}
    </span>
  );
}

/** An opened task's timeline; a cloud task with a chat can open it from there. */
function TaskSheet({ task, now, onClose, onOpen }: { task: TaskRow; now: number; onClose: () => void; onOpen: (session: string) => void }) {
  const session = task.kind === "cloud" ? task.session : null;

  // Opening the chat closes the sheet: left open, the modal covers the chat it opened.
  const openChat =
    session === null
      ? undefined
      : () => {
          onClose();
          onOpen(session);
        };

  return <TaskTimeline task={task} now={now} onClose={onClose} onOpenChat={openChat} />;
}

/** Stop a working task, or cancel a queued one. */
function StopButton({ task, onStop }: { task: TaskRow; onStop: (task: string) => void }) {
  const online = useContext(OnlineContext);

  if (!isLive(task)) return null;

  return (
    <button
      type="button"
      className="icon-button pressable feed-stop"
      aria-label={`Stop ${plain(task.title)}`}
      // A stop that landed later would stop whatever runs by then, so it waits for no connection.
      disabled={!online}
      title={!online ? OFFLINE_TITLE : task.status === "queued" ? "Cancel" : "Stop"}
      onClick={() => onStop(task.id)}
    >
      <Icon name="stop" size={14} />
    </button>
  );
}

// One line of the ledger: when, what, who and what it cost, how it went. Live, the spinner, the step and Stop instead.
function TaskItem({
  task,
  earlier,
  arriveKey,
  gone = false,
  sameTime = false,
  session,
  now,
  machines,
  onOpen,
  onStop,
}: FeedProps & {
  task: TaskRow;
  /** Revealed by Show earlier: it fades in. */
  earlier?: boolean;
  /** Who it is to Activity's arrivals: a row new since the last render opens its space. */
  arriveKey?: string;
  /** Finished a moment ago: closing its space here while it opens in its day. */
  gone?: boolean;
  /** Ends the same minute as the row above: its time is left blank. */
  sameTime?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const opens = task.kind === "cloud" && task.session !== null;
  const shared = useContext(FilesContext).some((file) => file.task === task.id && isMedia(file));

  useLayoutEffect(() => {
    if (gone) leave(row.current!);
    // Live again before it closed: back to full height.
    else unleave(row.current);
  }, [gone]);

  return (
    <li
      ref={row}
      className="feed-item ledger-item"
      data-status={task.status}
      data-live={isLive(task) || undefined}
      data-earlier={earlier}
      data-arrive={arriveKey}
      data-task={task.id}
      aria-current={opens && task.session === session ? "page" : undefined}
      aria-hidden={gone || undefined}
      inert={gone}
    >
      <button
        type="button"
        className="ledger-button pressable"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <TaskLead task={task} sameTime={sameTime} />
        <span className="row-text">
          <span className="ledger-title">{plain(task.title)}</span>
          <TaskNow task={task} machines={machines} now={now} />
          <TaskMeta task={task} now={now} />
        </span>
        <TaskState task={task} />
      </button>
      {open ? <TaskSheet task={task} now={now} onClose={() => setOpen(false)} onOpen={onOpen} /> : null}
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

/** What each purpose is called, and what it does. */
const PURPOSE_TEXT = {
  main: { label: "Main agent", hint: "Talks to you, in every chat" },
  worker: { label: "Worker", hint: "Subagents, specialists and automations" },
  background: { label: "Background", hint: "Titles, memory, dreams and skill reviews. Small and quick is best" },
  fallback: { label: "Fallback", hint: "Answers when a provider is down" },
} as const satisfies Record<Purpose, { label: string; hint: string }>;

const PURPOSES: readonly Purpose[] = ["main", "worker", "background", "fallback"];

const LEVELS: Partial<Record<ModelChoice["thinkingLevel"], string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** Each level's label in the thinking switch, short enough that all of them fit the panel's width; its full name stays its name. */
const SHORT_LEVELS: Partial<Record<ModelChoice["thinkingLevel"], string>> = { minimal: "Min", medium: "Med", xhigh: "XHigh" };

const PURPOSE_ICONS: Record<Purpose, IconName> = { main: "chat", worker: "nodes", background: "pencil", fallback: "cloud" };

// What a purpose runs, as its row shows it: the model, its provider and, when the model has a choice, how hard it thinks.
function summaryOf(current: ModelChoice, provider: ProviderInfo | undefined, model: ModelOption | undefined): string[] {
  const parts = [model?.name ?? current.modelId, provider?.name ?? current.provider];

  if ((model?.levels.length ?? 0) > 1) parts.push(LEVELS[current.thinkingLevel] ?? current.thinkingLevel);

  return parts;
}

// Words joined with dots that break only between the parts, so a long provider name moves to the next line whole.
function Parts({ parts }: { parts: readonly string[] }) {
  // The dot stays with the part before it; the line breaks only at the space after.
  return parts.map((part, index) =>
    index < parts.length - 1 ? (
      <Fragment key={part}>
        <span className="part">{part}&nbsp;·</span>{" "}
      </Fragment>
    ) : (
      <span key={part} className="part">
        {part}
      </span>
    ),
  );
}

/** The provider and model a choice names, when Settings has them. */
type ModelPick = { provider: ProviderInfo | undefined; model: ModelOption | undefined };

function modelOf(settings: SettingsView, choice: ModelChoice): ModelPick {
  const provider = settings.providers.find((each) => each.id === choice.provider);

  return { provider, model: provider?.models.find((each) => each.modelId === choice.modelId) };
}

// A purpose's row: what it runs; it opens the purpose's page.
function ModelLink({ purpose, current, settings }: { purpose: Purpose; current: ModelChoice; settings: SettingsView }) {
  const { provider, model } = modelOf(settings, current);

  return (
    <PageLink
      to={{ kind: "model", purpose }}
      icon={PURPOSE_ICONS[purpose]}
      label={PURPOSE_TEXT[purpose].label}
      sub={<Parts parts={summaryOf(current, provider, model)} />}
    />
  );
}

// How hard the chosen model thinks, when it has a choice.
function ThinkingPicker({
  purpose,
  current,
  settings,
  onSet,
}: {
  purpose: Purpose;
  current: ModelChoice;
  settings: SettingsView;
  onSet: (purpose: Purpose, choice: ModelChoice) => void;
}) {
  const levels = modelOf(settings, current).model?.levels ?? [];

  if (levels.length < 2) return null;

  return (
    <section className="group">
      <h4 className="group-label">
        Thinking <span className="thinking-chosen">· {LEVELS[current.thinkingLevel] ?? current.thinkingLevel}</span>
      </h4>
      <div className="card">
        <div className="row thinking">
          <Segmented small role="radiogroup" aria-label={`${PURPOSE_TEXT[purpose].label} thinking`} chosen={current.thinkingLevel}>
            {levels.map((each) => (
              <button
                key={each}
                type="button"
                role="radio"
                aria-checked={current.thinkingLevel === each}
                aria-label={LEVELS[each] ?? each}
                className="pressable"
                onClick={() => onSet(purpose, { ...current, thinkingLevel: each })}
              >
                {SHORT_LEVELS[each] ?? LEVELS[each] ?? each}
              </button>
            ))}
          </Segmented>
        </div>
      </div>
    </section>
  );
}

/** The choice that picks `model`, keeping the thinking level when the model has it. */
function choiceOf(provider: ProviderInfo, model: ModelOption, current: ModelChoice): ModelChoice {
  const thinkingLevel = model.levels.includes(current.thinkingLevel) ? current.thinkingLevel : (model.levels[0] ?? current.thinkingLevel);

  return { provider: provider.id, modelId: model.modelId, thinkingLevel };
}

// The featured models of every connected provider, with their prices, and the rest behind "Show all"; the chosen one is checked and always shown.
function ModelChoices({
  purpose,
  current,
  settings,
  onSet,
}: {
  purpose: Purpose;
  current: ModelChoice;
  settings: SettingsView;
  onSet: (purpose: Purpose, choice: ModelChoice) => void;
}) {
  const [all, setAll] = useState(false);
  const connected = settings.providers.filter((provider) => provider.connected);
  const chosen = (provider: ProviderInfo, model: ModelOption) => provider.id === current.provider && model.modelId === current.modelId;
  const hidden = connected.reduce((sum, provider) => sum + provider.models.filter((each) => !each.featured && !chosen(provider, each)).length, 0);

  return (
    <section className="group">
      <h4 className="group-label">Model</h4>
      <ul className="card choices" role="radiogroup" aria-label={`${PURPOSE_TEXT[purpose].label} model`}>
        {connected.flatMap((provider) =>
          provider.models.filter((each) => all || each.featured || chosen(provider, each)).map((each) => (
            <li key={`${provider.id}/${each.modelId}`}>
              <button
                type="button"
                role="radio"
                aria-checked={chosen(provider, each)}
                className="choice"
                onClick={() => onSet(purpose, choiceOf(provider, each, current))}
              >
                <span className="choice-text">
                  <span>{each.name}</span>
                  <span className="row-sub">
                    <Parts parts={each.cost ? [provider.name, `$${each.cost.input} / $${each.cost.output} per M`] : [provider.name]} />
                  </span>
                </span>
                <Icon name="check" size={14} className="choice-check" />
              </button>
            </li>
          )),
        )}
        {hidden > 0 && (
          <li>
            <button type="button" className="choice" aria-expanded={all} onClick={() => setAll(!all)}>
              <span className="choice-text row-sub">{all ? "Show fewer models" : `Show all models (${hidden} more)`}</span>
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

// A purpose's page: what it does, how hard it thinks, and the models to pick from.
function ModelPage({ page, settings, onSet }: PageProps) {
  const purpose = page.kind === "model" ? page.purpose : "main";

  return (
    <>
      <PageHead title={PURPOSE_TEXT[purpose].label}>{PURPOSE_TEXT[purpose].hint}</PageHead>
      <ModelPickers purpose={purpose} current={settings?.purposes[purpose]} settings={settings} onSet={onSet} />
    </>
  );
}

// How hard to think and which model, once Settings has them.
function ModelPickers({
  purpose,
  current,
  settings,
  onSet,
}: {
  purpose: Purpose;
  current: ModelChoice | undefined;
  settings: SettingsView | null;
  onSet: (purpose: Purpose, choice: ModelChoice) => void;
}) {
  if (!settings || !current) return <NoModels loading={!settings} />;

  return (
    <>
      <ThinkingPicker purpose={purpose} current={current} settings={settings} onSet={onSet} />
      <ModelChoices purpose={purpose} current={current} settings={settings} onSet={onSet} />
    </>
  );
}

/** Why there is no model to show: Settings is still loading, or no provider is on. */
function NoModels({ loading }: { loading: boolean }) {
  return loading ? <p className="group-empty">Loading models…</p> : <EmptyState icon="plug">No model provider is on</EmptyState>;
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
        <span className="row-sub">{sub ? `${value} · ${sub}` : value}</span>
      </span>
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
  const { openSection } = useContext(SettingsNavContext);

  if (!text) return null;
  const [before, ...after] = text.split(SUBSCRIPTIONS);

  return (
    <p className="automation-refused" role="alert">
      {before}
      {after.length > 0 ? (
        <button type="button" className="refused-link" onClick={() => openSection("settings-subscriptions")}>
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
      <h4 className="group-sublabel">Add an API key</h4>
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
        <KeyRefusal text={refused} />
        <div className="card-foot">
          <VaultBadge />
          <button type="submit" className="pill primary pressable" disabled={testing || key.trim() === ""}>
            {testing ? "Testing…" : "Test and save"}
          </button>
        </div>
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
          <span className="row-label">Repo</span>
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
          <span className="row-label">Address</span>
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
          <span className="row-label">What {NAME} can use</span>
          <RowValue>{catalog.length}</RowValue>
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

type SettingsProps = {
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
};

/** What every Settings page is drawn from: Settings' data and the page it is on. */
type PageProps = SettingsProps & { page: SettingsPage; more: boolean; onMore: (open: boolean) => void };

/** A page's identity, for keys and for finding the row that opens it. */
const keyOf = (page: SettingsPage) => JSON.stringify(page);

/** Where each page's back button goes; every page not listed here goes back to Settings. */
const PARENTS: Partial<Record<SettingsPage["kind"], SettingsPage>> = { model: { kind: "models" }, machine: { kind: "machines" } };

const parentOf = (page: SettingsPage) => PARENTS[page.kind] ?? SETTINGS_HOME;

/** What the back button says, by the page it goes to. */
const BACK_LABELS: Partial<Record<SettingsPage["kind"], string>> = { models: "Models", machines: "Machines" };

// A page's large title, which takes focus when the page opens, and a line under it.
function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <h3 className="page-title" tabIndex={-1}>
        {title}
      </h3>
      {children ? <p className="page-sub">{children}</p> : null}
    </header>
  );
}

// A row that opens a page: its icon if it has one, its name and a line under it, what it is set to, and a chevron.
function PageLink({
  to,
  icon,
  label,
  sub,
  children,
}: {
  to: SettingsPage;
  icon?: IconName | undefined;
  label: string;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  const { go } = useContext(SettingsNavContext);

  return (
    <li>
      <button type="button" className="row page-link" data-goes={keyOf(to)} onClick={() => go(to)}>
        {icon ? (
          <span className="row-tile">
            <Icon name={icon} size={15} />
          </span>
        ) : null}
        <span className="row-text">
          <span className="row-label">{label}</span>
          {sub ? <span className="row-sub">{sub}</span> : null}
        </span>
        {children}
        <Icon name="chevronRight" size={14} className="row-chevron" />
      </button>
    </li>
  );
}

/** A line at the top of Settings: what it is about, what it says, and the page it opens. */
type GlanceLine = { to: SettingsPage; label: string; text: string; tone?: MachineStatus["tone"] | undefined };

/** The one machine worth naming: the only one, or the only one online. */
function machineToName(pool: readonly MachineInfo[]): MachineInfo | undefined {
  if (pool.length === 1) return pool[0];
  const online = pool.filter((machine) => machine.online);

  return online.length === 1 ? online[0] : undefined;
}

/** How many machines are online, when no one machine is worth naming. */
function machineCount(pool: readonly MachineInfo[]): GlanceLine {
  const online = pool.filter((machine) => machine.online).length;

  if (pool.length === 0) return { to: { kind: "machines" }, label: "Machines", text: "None paired", tone: "off" };

  return { to: { kind: "machines" }, label: "Machines", text: `${online} of ${pool.length} online`, tone: online > 0 ? "online" : "offline" };
}

/** Your computer and whether it is up; sandboxes only when there is no computer. */
function machineGlance(machines: readonly MachineInfo[], now: number): GlanceLine {
  const computers = machines.filter((machine) => !isCloud(machine));
  const pool = computers.length > 0 ? computers : machines;
  const named = machineToName(pool);

  if (named === undefined) return machineCount(pool);
  const state = stateOf(named, now);

  return { to: { kind: "machine", name: named.name }, label: named.name, text: state.word, tone: state.tone };
}

/** The main agent's model. */
function mainGlance(settings: SettingsView | null): GlanceLine {
  if (!settings) return { to: { kind: "models" }, label: "Main agent", text: "Loading…" };
  const main = settings.purposes.main;

  return main
    ? { to: { kind: "model", purpose: "main" }, label: "Main agent", text: modelName(settings, main) }
    : { to: { kind: "models" }, label: "Main agent", text: "Not set" };
}

const modelName = (settings: SettingsView, choice: ModelChoice): string => modelOf(settings, choice).model?.name ?? choice.modelId;

/** What the VibeProxy line can say. */
type VibeWord = "loading" | "absent" | "online" | "offline";

const VIBE_WORDS = {
  loading: ["Loading…", "off"],
  absent: ["Not set up", "off"],
  online: ["Connected", "online"],
  offline: ["Not connected", "offline"],
} as const satisfies Record<VibeWord, readonly [string, MachineStatus["tone"]]>;

/** Whether setup lists a service as missing. */
const isMissing = (setup: SetupView | null, id: string): boolean => setup?.missing.some((each) => each.id === id) ?? false;

function vibeWord(vibe: ProviderInfo | undefined, missing: boolean): VibeWord {
  if (vibe === undefined || missing) return "absent";

  return vibe.connected ? "online" : "offline";
}

/** Whether VibeProxy, on your Mac, is reachable; a deploy without it says so. */
function vibeGlance(settings: SettingsView | null, setup: SetupView | null): GlanceLine {
  const word = settings ? vibeWord(settings.providers.find((provider) => provider.id === VIBEPROXY), isMissing(setup, VIBEPROXY)) : "loading";
  const [text, tone] = VIBE_WORDS[word];

  return { to: { kind: "providers" }, label: "VibeProxy", text, tone };
}

const VIBEPROXY = "vibeproxy";

/** What a line says inside the health line, where its label is often the thing itself. */
function healthText(line: GlanceLine): string {
  if (line.label === "VibeProxy") return "VibeProxy";

  if (line.label === "Main agent") return line.text === "Not set" ? "No main model" : line.text;

  if (line.to.kind === "machines") return line.text === "None paired" ? "No machines" : `${line.text.replace(" online", "")} machines online`;

  return `${line.label} ${line.text.toLowerCase()}`;
}

/** What a broken line says on its card: what is wrong, and what that stops. */
type GlanceAlert = { title: string; sub: string };

function alertText(line: GlanceLine): GlanceAlert {
  if (line.label === "VibeProxy") return { title: "VibeProxy isn’t connected", sub: "Claude models are off until it is" };

  if (line.to.kind === "machines") return { title: "No machine is online", sub: "Work waits until one is back" };

  return { title: `${line.label} is offline`, sub: "Work on it waits until it’s back" };
}

/** Whether a line belongs on the health line: VibeProxy only once it is connected, so one not set up says nothing. */
const shownHealthy = (line: GlanceLine): boolean => line.label !== "VibeProxy" || line.tone === "online";

// What matters first, as one line of what is fine and a card for each thing that is down; each opens its page.
function Glance({ machines, settings, setup, now }: Pick<SettingsProps, "machines" | "settings" | "setup" | "now">) {
  const { go } = useContext(SettingsNavContext);
  const lines = [machineGlance(machines, now), mainGlance(settings), vibeGlance(settings, setup)];
  const down = lines.filter((line) => line.tone === "offline");
  const fine = lines.filter((line) => line.tone !== "offline" && shownHealthy(line));

  return (
    <ul className="glance" aria-label="Status">
      {fine.length > 0 ? (
        <li className="glance-health">
          <span className="row-dot" data-tone={fine.find((line) => line.tone !== undefined)?.tone ?? "off"} aria-hidden="true" />
          {fine.map((line, index) => (
            <Fragment key={line.label}>
              {index > 0 ? <span aria-hidden="true">·</span> : null}
              <button type="button" className="glance-part" data-goes={keyOf(line.to)} aria-label={`${line.label} ${line.text}`} onClick={() => go(line.to)}>
                {healthText(line)}
              </button>
            </Fragment>
          ))}
        </li>
      ) : null}
      {down.map((line) => {
        const { title, sub } = alertText(line);

        return (
          <li key={line.label}>
            <button type="button" className="glance-alert" data-goes={keyOf(line.to)} onClick={() => go(line.to)}>
              <span className="glance-alert-text">
                <span className="glance-alert-title">{title}</span>
                <span className="glance-alert-sub">{sub}</span>
              </span>
              <span className="glance-fix" aria-hidden="true">
                Fix
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** How many machines are online out of how many, after a dot that is green while any is. */
function machinesValue(machines: readonly MachineInfo[]): ReactNode {
  const online = machines.filter((machine) => machine.online).length;

  if (machines.length === 0) return <RowValue>None</RowValue>;

  return <RowValue tone={online > 0 ? "online" : "off"}>{`${online}/${machines.length}`}</RowValue>;
}

/** How many are connected, after a dot that is green while any is; None when none is. */
function connectedValue(connected: number): ReactNode {
  return connected === 0 ? <RowValue tone="off">None</RowValue> : <RowValue tone="online">{connected}</RowValue>;
}

/** A row on Settings' first page: the page it opens, its icon and name, and what it is set to, if that says anything. */
type GroupRow = { to: SettingsPage; icon: IconName; label: string; value?: (props: SettingsProps) => ReactNode };

/** Settings' rows, in cards of what belongs together: what ky thinks with, where it works, how it treats you. */
const GROUPS: ReadonlyArray<readonly GroupRow[]> = [
  [
    { to: { kind: "models" }, icon: "chat", label: "Models", value: ({ settings }) => <RowValue>{Object.keys(settings?.purposes ?? {}).length}</RowValue> },
    {
      to: { kind: "providers" },
      icon: "plug",
      label: "Providers",
      value: ({ settings }) => connectedValue(settings?.providers.filter((provider) => provider.connected).length ?? 0),
    },
    { to: { kind: "tools" }, icon: "terminal", label: "Tools", value: ({ catalog }) => <RowValue>{catalog.length}</RowValue> },
    { to: { kind: "spend" }, icon: "layers", label: "Spend", value: () => <SpendValue /> },
  ],
  [
    { to: { kind: "machines" }, icon: "monitor", label: "Machines", value: ({ machines }) => machinesValue(machines) },
    {
      to: { kind: "subscriptions" },
      icon: "globe",
      label: "Subscriptions",
      value: ({ subscriptions }) => connectedValue(subscriptions.views.filter((view) => view.connected).length),
    },
  ],
  [
    { to: { kind: "proactivity" }, icon: "sparkle", label: "Proactivity", value: () => <ProactivityValue /> },
    { to: { kind: "appearance" }, icon: "sun", label: "Appearance", value: ({ theme }) => <AppearanceValue theme={theme} /> },
  ],
];

/** What most people set once or never: behind More, so the first page stays short. */
const MORE: readonly GroupRow[] = [
  { to: { kind: "peers" }, icon: "nodes", label: "Peers" },
  { to: { kind: "mail" }, icon: "mail", label: "Mail" },
  { to: { kind: "inbound" }, icon: "plug", label: "Webhooks" },
  { to: { kind: "self-edits" }, icon: "repo", label: "Self-edits", value: ({ setup }) => <RowValue>{setup?.repo ?? "Not set"}</RowValue> },
];

/** The pages behind More, so coming back from one finds More open. */
const MORE_PAGES: ReadonlySet<SettingsPage["kind"]> = new Set(MORE.map((row) => row.to.kind));

/** The theme, with the accent's swatch before it. */
function AppearanceValue({ theme }: { theme: Theme }) {
  const accent = useAccent();

  return (
    <span className="row-value">
      <span className="row-swatch" data-swatch={accent} aria-hidden="true" />
      <span className="row-value-text">{theme === "dark" ? "Dark" : "Light"}</span>
    </span>
  );
}

function GroupLinks({ rows, props }: { rows: readonly GroupRow[]; props: SettingsProps }) {
  return rows.map((row) => (
    <PageLink key={row.label} to={row.to} label={row.label}>
      {row.value?.(props)}
    </PageLink>
  ));
}

// Settings' first page: what matters at a glance, a few short cards of pages, and the rarely-set rest behind More.
function SettingsHome(props: PageProps) {
  const { more, onMore } = props;

  return (
    <>
      <Glance machines={props.machines} settings={props.settings} setup={props.setup} now={props.now} />
      <div className="settings-groups">
        {GROUPS.map((rows) => (
          <ul key={rows.map((row) => row.label).join()} className="card">
            <GroupLinks rows={rows} props={props} />
          </ul>
        ))}
        <ul className="card settings-more">
          <li>
            <button type="button" className="row page-link more-row" aria-expanded={more} onClick={() => onMore(!more)}>
              <span className="row-label">More</span>
              {more ? null : <span className="row-value-text more-sub">{MORE.map((row) => row.label).join(", ")}</span>}
              <Icon name="chevronRight" size={14} className="row-chevron" />
            </button>
          </li>
          {more ? <GroupLinks rows={MORE} props={props} /> : null}
        </ul>
      </div>
    </>
  );
}

function ModelsPage({ settings }: PageProps) {
  return (
    <>
      <PageHead title="Models" />
      <ModelLinks settings={settings} />
    </>
  );
}

// Each purpose and what it runs, once Settings has them.
function ModelLinks({ settings }: { settings: SettingsView | null }) {
  if (settings === null) return <NoModels loading />;

  const set = PURPOSES.flatMap((purpose) => {
    const current = settings.purposes[purpose];

    return current ? [{ purpose, current }] : [];
  });

  if (set.length === 0) return <NoModels loading={false} />;

  return (
    <ul className="card">
      {set.map(({ purpose, current }) => (
        <ModelLink key={purpose} purpose={purpose} current={current} settings={settings} />
      ))}
    </ul>
  );
}

function ProvidersPage({ settings, setup, keyActions }: PageProps) {
  return (
    <>
      <PageHead title="Providers" />
      {settings ? <Services settings={settings} setup={setup} keyActions={keyActions} /> : <p className="group-empty">Loading providers…</p>}
    </>
  );
}

function MachinesPage({ machines, subscriptions, now }: PageProps) {
  return (
    <>
      <PageHead title="Machines" />
      <MachineList machines={machines} repos={reposOf(subscriptions)} now={now} />
    </>
  );
}

function SubscriptionsPage({ subscriptions, machines, now }: PageProps) {
  return (
    <>
      <PageHead title="Subscriptions">For machines that aren't signed in themselves.</PageHead>
      <Subscriptions {...subscriptions} now={now} paired={machines.length > 0} />
    </>
  );
}

function PeersPage() {
  return (
    <>
      <PageHead title="Peers">{NAME} and a friend's agent can ask each other questions.</PageHead>
      <Peers />
    </>
  );
}

function MailPage() {
  return (
    <>
      <PageHead title="Mail">{NAME}'s own address. It asks before writing to anyone new.</PageHead>
      <Mail />
    </>
  );
}

function InboundPage() {
  return (
    <>
      <PageHead title="Webhooks">URLs a service posts to, into a chat, the API credentials {NAME} calls with, and the sites its browser stays signed in to.</PageHead>
      <Inbound />
      <BrowserLogins />
    </>
  );
}

function ProactivityPage() {
  return (
    <>
      <PageHead title="Proactivity" />
      <Proactivity />
    </>
  );
}

function SpendPage() {
  return (
    <>
      <PageHead title="Spend">What the models cost, by day in your time zone.</PageHead>
      <Spend />
    </>
  );
}

function ToolsPage({ catalog }: PageProps) {
  return (
    <>
      <PageHead title="Tools" />
      <ToolsGroup catalog={catalog} />
      <Executor />
    </>
  );
}

function AppearancePage({ theme, onTheme }: PageProps) {
  return (
    <>
      <PageHead title="Appearance" />
      <div className="card">
        <div className="row">
          <span className="row-label">Theme</span>
          <Segmented small role="radiogroup" aria-label="Theme" chosen={theme}>
            {(["light", "dark"] as const).map((each) => (
              <SegmentedOption key={each} checked={theme === each} onChoose={() => onTheme(each)}>
                <Icon name={each === "light" ? "sun" : "moon"} size={13} />
                {each === "light" ? "Light" : "Dark"}
              </SegmentedOption>
            ))}
          </Segmented>
        </div>
        <AccentRow />
      </div>
    </>
  );
}

const ACCENT_NAMES: Record<Accent, string> = { ink: "Ink", violet: "Violet", blue: "Blue", green: "Green", ember: "Ember", pink: "Pink" };

/** The accent: a swatch each, the chosen one ringed; the arrows move the choice, as in any radio group. */
function AccentRow() {
  const accent = useAccent();
  const group = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];

    if (step === undefined) return;
    event.preventDefault();
    const next = ACCENTS[(ACCENTS.indexOf(accent) + step + ACCENTS.length) % ACCENTS.length];

    if (next === undefined) return;
    setAccent(next);
    group.current?.querySelector<HTMLElement>(`[data-swatch="${next}"]`)?.focus();
  };

  return (
    <div className="row">
      <span className="row-label">Accent</span>
      <div ref={group} className="accent-swatches" role="radiogroup" aria-label="Accent" onKeyDown={onKeyDown}>
        {ACCENTS.map((each) => (
          <button
            key={each}
            type="button"
            role="radio"
            aria-checked={accent === each}
            aria-label={ACCENT_NAMES[each]}
            title={ACCENT_NAMES[each]}
            tabIndex={accent === each ? 0 : -1}
            className="accent-swatch pressable"
            data-swatch={each}
            onClick={() => setAccent(each)}
          />
        ))}
      </div>
    </div>
  );
}

function SelfEditsPage({ setup, onSetRepo }: PageProps) {
  return (
    <>
      <PageHead title="Self-edits">{NAME} opens pull requests here to change itself.</PageHead>
      {setup ? <SelfEdits repo={setup.repo} url={setup.url} onSet={onSetRepo} /> : <p className="group-empty">Loading…</p>}
    </>
  );
}

/** What each page shows. */
const PAGE_VIEWS: Record<SettingsPage["kind"], (props: PageProps) => ReactNode> = {
  home: SettingsHome,
  models: ModelsPage,
  model: ModelPage,
  providers: ProvidersPage,
  machines: MachinesPage,
  machine: MachinePage,
  subscriptions: SubscriptionsPage,
  peers: PeersPage,
  mail: MailPage,
  inbound: InboundPage,
  proactivity: ProactivityPage,
  spend: SpendPage,
  tools: ToolsPage,
  appearance: AppearancePage,
  "self-edits": SelfEditsPage,
};

/** The fields that use Escape themselves, to put their text back. */
const FIELDS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Whether a key press asks to go back a page: Escape, which no field has used. */
const asksBack = (event: KeyboardEvent<HTMLElement>) =>
  event.key === "Escape" && !event.defaultPrevented && !(event.target instanceof HTMLElement && FIELDS.has(event.target.tagName));

/** Put focus on the row that opens the page just left, else on the page's title, else on the page itself. */
function focusPage(body: HTMLElement | null, left: string | null) {
  const opener = left === null ? null : body?.querySelector<HTMLElement>(`[data-goes="${CSS.escape(left)}"]`);

  (opener ?? body?.querySelector<HTMLElement>(".page-title") ?? body)?.focus({ preventScroll: true });
}

// Moving between pages moves focus: forward to the new page's title, back to the row the user came from.
function usePageFocus(page: SettingsPage, body: RefObject<HTMLDivElement | null>, left: RefObject<string | null>) {
  const shown = useRef(keyOf(page));

  useEffect(() => {
    if (keyOf(page) === shown.current) return;
    shown.current = keyOf(page);
    focusPage(body.current, left.current);
    left.current = null;
  }, [page, body, left]);
}

// Settings: what matters at a glance and its groups; each group, model choice and machine on a page of its own, with a way back.
function Settings(props: SettingsProps) {
  const { page, go } = useContext(SettingsNavContext);
  const body = useRef<HTMLDivElement>(null);
  const left = useRef<string | null>(null);
  const View = PAGE_VIEWS[page.kind];
  const parent = parentOf(page);
  // More stays open while Settings is; it opens on its own when a page behind it is shown, so the way back finds its row.
  const [more, setMore] = useState(MORE_PAGES.has(page.kind));

  if (MORE_PAGES.has(page.kind) && !more) setMore(true);

  const back = () => {
    left.current = keyOf(page);
    go(parent);
  };

  usePageFocus(page, body, left);

  return (
    <div
      key={keyOf(page)}
      ref={body}
      className="panel-body settings"
      data-scroll
      tabIndex={-1}
      onKeyDown={(event) => {
        if (page.kind === "home" || !asksBack(event)) return;
        event.stopPropagation();
        back();
      }}
    >
      {page.kind === "home" ? null : (
        <button type="button" className="page-back pressable" aria-label={BACK_LABELS[parent.kind] ?? "Settings"} title={`Back to ${BACK_LABELS[parent.kind] ?? "Settings"}`} onClick={back}>
          <Icon name="arrowLeft" size={16} />
        </button>
      )}
      <View page={page} more={more} onMore={setMore} {...props} />
    </div>
  );
}
