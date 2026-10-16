import { type FormEvent, Fragment, type HTMLAttributes, type KeyboardEvent, type ReactNode, type RefObject, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import Type, { type Static } from "typebox";
import { parseOr } from "../core/decode";
import type { MachineChange, MachineFacts, MachineLogin, MachineState } from "../machines/contract";
import type { SandboxChange, SandboxDraft } from "../sandboxes";
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
import { CopyButton, CopyLine } from "./CopyButton";
import type { BlobVariantId } from "./blob-catalog";
import { BotAvatar } from "./BotAvatar";
import { KY_AVATAR } from "../avatar-spec";
import { Icon, Spinner, type IconName } from "./Icon";
import { plain } from "./plain";
import type { MemoryActions } from "./Memory";
import { Skills } from "./Skills";
import { Soul, type SpecialistActions } from "./Soul";
import { Executor } from "./Executor";
import { Mail } from "./Mail";
import { Proactivity } from "./Proactivity";
import { Peers } from "./Peers";
import { Subscriptions, type SubscriptionsData } from "./Subscriptions";
import { currentStep, elapsed, isLive, quietNote, spendParts } from "./task-progress";
import { TaskTimeline } from "./Timeline";
import { ago, clock, day } from "./time";
import { SETTINGS_HOME, SettingsNavContext, type SettingsPage } from "./use-panel";

export type Theme = "light" | "dark";

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
        <BotAvatar name={name} variantId={variantId} owner={KY_AVATAR} active={active} size={72} />
        <h2 className="profile-name">{name}</h2>
        <p className="profile-status" role="status">
          <span className="status-dot" data-connected={status.connected} />
          {status.label}
          <span className="quiet"> · {model}</span>
        </p>
      </header>
      <Segmented role="tablist" chosen={tab}>
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
      </Segmented>
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

// A segmented control whose one pill slides under the chosen option, so you see where you went.
function Segmented({ chosen, small, children, ...rest }: HTMLAttributes<HTMLDivElement> & { chosen: unknown; small?: boolean }) {
  const track = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => placePill(track.current, true), [chosen]);
  // A new width (the panel resized, the font arrived) moves the pill without the slide.
  useEffect(() => {
    const element = track.current;

    if (element === null) return;
    const observer = new ResizeObserver(() => placePill(element, false));

    observer.observe(element);
    void document.fonts.ready.then(() => placePill(element, false));

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={track} className={small ? "segmented small" : "segmented"} {...rest}>
      <span className="segmented-pill" aria-hidden="true" />
      {children}
    </div>
  );
}

/** Puts the pill under the chosen option; it slides only once it has been placed. */
function placePill(track: HTMLElement | null, glide: boolean) {
  const pill = track?.querySelector<HTMLElement>(":scope > .segmented-pill");
  const chosen = track?.querySelector<HTMLElement>(':scope > [aria-selected="true"], :scope > [aria-checked="true"]');

  if (!pill) return;
  pill.dataset.shown = String(chosen !== null && chosen !== undefined);

  if (!chosen) return;
  pill.dataset.glide = String(glide && pill.dataset.placed === "true");
  pill.dataset.placed = "true";
  pill.style.width = `${chosen.offsetWidth}px`;
  pill.style.height = `${chosen.offsetHeight}px`;
  pill.style.borderRadius = getComputedStyle(chosen).borderRadius;
  pill.style.transform = `translate(${chosen.offsetLeft}px, ${chosen.offsetTop}px)`;
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** scotty.css's --ease-out, for the motion that runs in script. */
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
  const body = useRef<HTMLDivElement>(null);

  useArrivals(body);

  return (
    <div ref={body} className="panel-body" data-scroll>
      <NowSection live={tasks.filter(isLive)} running={running} onStopAll={onStopAll} {...feed} />
      <Automations now={feed.now} session={feed.session} />
      <History past={tasks.filter((task) => !isLive(task))} {...feed} />
      {tasks.length === 0 && running.length === 0 ? (
        <p className="panel-empty">Work ky hands to subagents and your machines shows up here.</p>
      ) : null}
    </div>
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
          <button type="button" className="feed-action pressable" onClick={onStopAll}>
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
            {rows.map((task) => (
              <TaskItem key={task.id} task={task} earlier={earlier.has(task.id)} arriveKey={`past:${task.id}`} {...feed} />
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
        <p className="group-empty">None yet. Add one to run tasks on your own computer.</p>
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

  return answer?.refused ?? `ky could not do that (HTTP ${response.status}).`;
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

  if (live >= view.cap) return <p className="group-note">ky runs at most {view.cap} sandboxes; delete one to add another.</p>;

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
      <p className="field-hint">ky's own Linux machine in Cloudflare. A task wakes it; it sleeps when idle.</p>
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
      setError(`ky could not make a code (HTTP ${response.status}).`);

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
      {error ? <p className="group-note">{error}</p> : null}
      {code === null ? null : <PairingCommand code={code} now={now} />}
    </>
  );
}

// The command that pairs a computer with `code`, until the code expires.
function PairingCommand({ code, now }: { code: PairingCode; now: number }) {
  if (code.expiresAt <= now) return <p className="group-note">That code has expired. Make a new one.</p>;

  return (
    <div className="machine-code">
      <p className="group-note">
        On the computer, with <code>ky</code> installed, run this before {clock(code.expiresAt)}; it works once. It sets up
        the runner, starts it at login, and waits for it to come online here.
      </p>
      <CopyLine text={`ky runner add ${location.origin} ${code.code}`} label="Pairing command" />
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
      <p className="group-empty">This machine is no longer paired.</p>
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

    setError(response.ok ? null : `ky could not unpair ${machine.name} (HTTP ${response.status}).`);
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

// How to bring an offline computer back: the service restarts it, or the user starts it by hand. The cloud machine wakes itself.
function MachineRestart({ machine }: { machine: MachineInfo }) {
  if (machine.online || isCloud(machine)) return null;

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
      <Segmented small role="radiogroup" aria-label={`Let ky use ${machine.name}`} chosen={machine.state}>
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

/** Who did it, then its figures: "webmac · 34s · 1 turn · $0.01". The line breaks only between parts. */
function TaskMeta({ task, now }: { task: TaskRow; now: number }) {
  const parts = [task.worker, ...figuresOf(task, now).filter((part) => part !== null)];

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

/** A row's first column: when a finished task ended, or a live one's spinner. */
function TaskLead({ task }: { task: TaskRow }) {
  return (
    <span className="ledger-lead tabular">{isLive(task) ? <StatusGlyph status={task.status} /> : clock(task.updated_at)}</span>
  );
}

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

  return <TaskTimeline task={task} now={now} onClose={onClose} onOpenChat={session === null ? undefined : () => onOpen(session)} />;
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
        <TaskLead task={task} />
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
      <h4 className="group-label">Thinking</h4>
      <div className="card">
        <div className="row thinking">
          <Segmented small role="radiogroup" aria-label={`${PURPOSE_TEXT[purpose].label} thinking`} chosen={current.thinkingLevel}>
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
  return <p className="group-empty">{loading ? "Loading models…" : "No model provider is enabled."}</p>;
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
          <span className="row-tile">
            <Icon name="repo" size={15} />
          </span>
          <span className="row-label">ky's repo</span>
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
          <span className="row-label">ky's address</span>
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
type PageProps = SettingsProps & { page: SettingsPage };

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

// A row that opens a page: its icon, its name and a line under it, what it is set to, and a chevron.
function PageLink({
  to,
  icon,
  label,
  sub,
  children,
}: {
  to: SettingsPage;
  icon: IconName;
  label: string;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  const { go } = useContext(SettingsNavContext);

  return (
    <li>
      <button type="button" className="row page-link" data-goes={keyOf(to)} onClick={() => go(to)}>
        <span className="row-tile">
          <Icon name={icon} size={15} />
        </span>
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

// The three things worth checking first: your computer, the main agent's model, and VibeProxy; each opens its page.
function Glance({ machines, settings, setup, now }: Pick<SettingsProps, "machines" | "settings" | "setup" | "now">) {
  const { go } = useContext(SettingsNavContext);
  const lines = [machineGlance(machines, now), mainGlance(settings), vibeGlance(settings, setup)];

  return (
    <ul className="glance" aria-label="Status">
      {lines.map((line) => (
        <li key={line.label}>
          <button type="button" className="glance-line pressable" data-goes={keyOf(line.to)} onClick={() => go(line.to)}>
            <span className="glance-label">{line.label}</span>
            <span className="glance-value state" data-tone={line.tone}>
              {line.text}
            </span>
            <Icon name="chevronRight" size={14} className="row-chevron" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** How many machines are online, in a few words. */
function machinesValue(machines: readonly MachineInfo[]): string {
  const online = machines.filter((machine) => machine.online).length;

  if (machines.length === 0) return "None";

  return online === machines.length ? `${online} online` : `${online} of ${machines.length} online`;
}

/** How many there are, or None. */
const countOrNone = (count: number, word: string) => (count === 0 ? "None" : `${count} ${word}`);

/** Settings' groups, in order: the page each opens, and what it is set to now. */
const GROUPS: ReadonlyArray<{ to: SettingsPage; icon: IconName; label: string; value: (props: SettingsProps) => string }> = [
  { to: { kind: "models" }, icon: "chat", label: "Models", value: ({ settings }) => plural(Object.keys(settings?.purposes ?? {}).length, "role") },
  {
    to: { kind: "providers" },
    icon: "plug",
    label: "Providers",
    value: ({ settings }) => countOrNone(settings?.providers.filter((provider) => provider.connected).length ?? 0, "connected"),
  },
  { to: { kind: "machines" }, icon: "monitor", label: "Machines", value: ({ machines }) => machinesValue(machines) },
  {
    to: { kind: "subscriptions" },
    icon: "globe",
    label: "Subscriptions",
    value: ({ subscriptions }) => countOrNone(subscriptions.views.filter((view) => view.connected).length, "connected"),
  },
  { to: { kind: "peers" }, icon: "nodes", label: "Peers", value: () => "Other people's kys" },
  { to: { kind: "mail" }, icon: "mail", label: "Mail", value: () => "ky's own address" },
  { to: { kind: "proactivity" }, icon: "sun", label: "Proactivity", value: () => "What ky says unasked" },
  { to: { kind: "tools" }, icon: "terminal", label: "Tools", value: ({ catalog }) => String(catalog.length) },
  { to: { kind: "appearance" }, icon: "sun", label: "Appearance", value: ({ theme }) => (theme === "dark" ? "Dark" : "Light") },
  { to: { kind: "self-edits" }, icon: "repo", label: "Self-edits", value: ({ setup }) => setup?.repo ?? "Not set" },
];

// Settings' first page: what matters at a glance, then every group and what it is set to.
function SettingsHome(props: PageProps) {
  return (
    <>
      <Glance machines={props.machines} settings={props.settings} setup={props.setup} now={props.now} />
      <ul className="card settings-groups" aria-label="Settings">
        {GROUPS.map((group) => (
          <PageLink key={group.label} to={group.to} icon={group.icon} label={group.label}>
            <span className="row-value">{group.value(props)}</span>
          </PageLink>
        ))}
      </ul>
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
      <PageHead title="Subscriptions">Machines use these where they aren't signed in.</PageHead>
      <Subscriptions {...subscriptions} now={now} paired={machines.length > 0} />
    </>
  );
}

function PeersPage() {
  return (
    <>
      <PageHead title="Peers">Pair with a friend's ky, and yours can ask theirs questions. A question from theirs can use your memory, skills and connected apps; yours won't act for them, and asks you when it isn't sure.</PageHead>
      <Peers />
    </>
  );
}

function MailPage() {
  return (
    <>
      <PageHead title="Mail">ky's own email address, to sign up for things and write to people for you. It asks before writing to anyone new.</PageHead>
      <Mail />
    </>
  );
}

function ProactivityPage() {
  return (
    <>
      <PageHead title="Proactivity">What ky brings up without being asked. Off means no brief, and the dream writes none.</PageHead>
      <Proactivity />
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
          <span className="row-tile">
            <Icon name={theme === "dark" ? "moon" : "sun"} size={15} />
          </span>
          <span className="row-label">Theme</span>
          <Segmented small role="radiogroup" aria-label="Theme" chosen={theme}>
            {(["light", "dark"] as const).map((each) => (
              <button key={each} type="button" role="radio" aria-checked={theme === each} className="pressable" onClick={() => onTheme(each)}>
                {each === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </Segmented>
        </div>
      </div>
    </>
  );
}

function SelfEditsPage({ setup, onSetRepo }: PageProps) {
  return (
    <>
      <PageHead title="Self-edits">ky changes itself through pull requests to this repo.</PageHead>
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
  proactivity: ProactivityPage,
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
        <button type="button" className="page-back pressable" onClick={back}>
          <Icon name="arrowLeft" size={14} />
          {BACK_LABELS[parent.kind] ?? "Settings"}
        </button>
      )}
      <View page={page} {...props} />
    </div>
  );
}
