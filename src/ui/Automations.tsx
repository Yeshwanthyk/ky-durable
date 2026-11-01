import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createContext,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import type {
  AutomationAction,
  AutomationDraft,
  AutomationInfo,
  ChatRow,
  MachineInfo,
  ModelChoice,
  ProviderInfo,
  TaskRow,
} from "../protocol";
import { nextLocals } from "../automations/contract";
import { KY } from "../skills/contract";
import { byNextRun } from "./automation-order";
import { Icon } from "../chat-kit/Icon";
import { MAIN_SESSION, NAME } from "./open-chat";
import { plain } from "./plain";
import { ProactivityContext } from "./Proactivity";
import {
  BROWSER_ZONE,
  clockIn,
  cronInWords,
  cronOf,
  HOUR_STEPS,
  inputTime,
  oftenOf,
  rhythmOf,
  runIn,
  sameDay,
  scheduleSentence,
  wallInput,
  weekdayIn,
  zoneName,
} from "./schedule";
import { ago } from "./time";

/** When it runs: a cron in words, or a one-off's local time. */
export function scheduleOf(automation: AutomationInfo): string {
  if (automation.cron !== null) return cronInWords(automation.cron);

  const at = new Date(automation.at ?? 0).toLocaleString(undefined, {
    timeZone: automation.zone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return `Once · ${at}`;
}

/** Paused, or how long until it runs next. */
function nextOf(automation: AutomationInfo, now: number): string {
  if (automation.status === "paused") return "Paused";

  if (automation.next_run === null) return "Not booked";
  const wait = ago(now, automation.next_run);

  return wait === "now" ? "due now" : `in ${wait}`;
}

/** A card's one muted line: when it runs, when next, and a quiet "by ky" or "check-in" when ky made it. */
function metaOf(automation: AutomationInfo, now: number): string {
  const by = automation.created_by === "ky" ? [`by ${NAME}`] : automation.created_by === "dream" ? ["check-in"] : [];

  return [scheduleOf(automation), nextOf(automation, now), ...by].join(" · ");
}

/** The automations, what the user can do to one, and what a form offers; provided around the panel. */
export const AutomationsContext = createContext<{
  automations: readonly AutomationInfo[];
  providers: readonly ProviderInfo[];
  machines: readonly MachineInfo[];
  /** Who an automation may run as besides ky. */
  specialists: readonly { readonly id: string }[];
  chats: readonly ChatRow[];
  onAction: (automation: string, action: AutomationAction) => void;
  /** Create (no id) or change an automation; resolves with why it was refused, if it was. */
  onSave: (
    automation: string | undefined,
    draft: AutomationDraft,
  ) => Promise<string | undefined>;
  /** Whether the nightly dream books check-ins, and the switch. */
  checkIns: boolean;
  onCheckIns: (on: boolean) => void;
}>({
  automations: [],
  providers: [],
  machines: [],
  specialists: [],
  chats: [],
  onAction: () => {},
  onSave: async () => undefined,
  checkIns: true,
  onCheckIns: () => {},
});

/** The user's time zone from Settings, read once the socket opens; the browser's until then, or when it has none. */
export function useZone(): string {
  const { open, onZone } = useContext(ProactivityContext);
  const [zone, setZone] = useState<string | null>(null);

  // biome-ignore-start lint/correctness/useExhaustiveDependencies: read again only when the socket opens
  useEffect(() => {
    if (open) onZone().then((view) => setZone(view.zone), () => undefined);
  }, [open]);
  // biome-ignore-end lint/correctness/useExhaustiveDependencies: read again only when the socket opens

  return zone ?? BROWSER_ZONE;
}

/**
 * What Activity shows of routines: today's timeline, the sheet of them all, or one routine's form. `back` is
 * where the form returns to; `glide` is false when the keyboard opened the page, so it appears at once.
 */
export type RoutinesView =
  | { readonly page: "today" }
  | { readonly page: "all"; readonly glide: boolean }
  | { readonly page: "edit"; readonly id: string; readonly back: "today" | "all"; readonly glide: boolean };

export const TODAY: RoutinesView = { page: "today" };

/** The form for a new routine. */
const NEW = "new";

/** A click from a pointer glides the next page in; one from the keyboard (detail 0) does not. */
const glideOf = (event: MouseEvent) => event.detail !== 0;

const notArchived = (automation: AutomationInfo) => automation.status !== "archived";

/** How the header names the sheet: "All 16 routines", "1 routine", or "Routines". */
function allLabel(count: number): string {
  if (count === 0) return "Routines";

  return count === 1 ? "1 routine" : `All ${count} routines`;
}

// Activity's header: today's date, quiet, and the way to every routine.
export function TodayHead({ now, zone, onView }: { now: number; zone: string; onView: (view: RoutinesView) => void }) {
  const { automations } = useContext(AutomationsContext);
  const date = new Date(now).toLocaleDateString(undefined, { timeZone: zone, weekday: "short", month: "short", day: "numeric" });

  return (
    <header className="today-head">
      <h3 className="today-date">{date}</h3>
      <button type="button" className="today-all pressable" onClick={(event) => onView({ page: "all", glide: glideOf(event) })}>
        {allLabel(automations.filter(notArchived).length)}
        <Icon name="chevronRight" size={12} />
      </button>
    </header>
  );
}

/** A timeline row's dot: how a run went, that one runs now, or that one is coming. */
type Tone = TaskRow["status"] | "next";

/** One run on the timeline: when, which routine, and what it came to or how often it runs. */
type Slot = { readonly key: string; readonly at: number; readonly tone: Tone; readonly automation: AutomationInfo; readonly note: string };

/** What a run came to in a few words: its summary's first line, else how it ended. */
function resultOf(run: NonNullable<AutomationInfo["last_run"]>): string {
  const first = plain(run.summary ?? "").split("\n")[0]?.trim();

  if (first) return first;

  return run.status === "done" ? "done" : run.status;
}

/** Today's runs so far, those still to come today, and those later this week, each soonest first. */
function slotsOf(automations: readonly AutomationInfo[], now: number, zone: string) {
  const past: Slot[] = [];
  const next: Slot[] = [];
  const later: Slot[] = [];

  for (const automation of automations) {
    const run = automation.last_run;

    if (run && (run.status === "queued" || run.status === "working"))
      past.push({ key: `run:${automation.id}`, at: now - 1, tone: run.status, automation, note: "running" });
    else if (run?.finished_at != null && sameDay(run.finished_at, now, zone))
      past.push({ key: `ran:${automation.id}`, at: run.finished_at, tone: run.status, automation, note: resultOf(run) });

    const when = automation.next_run;

    if (automation.status !== "active" || when === null) continue;
    const often = oftenOf(automation.cron);

    if (sameDay(when, now, zone)) next.push({ key: `next:${automation.id}`, at: when, tone: "next", automation, note: often || (automation.post ? "posts" : "") });
    else if (when - now < WEEK_MS) later.push({ key: `later:${automation.id}`, at: when, tone: "next", automation, note: often || scheduleOf(automation) });
  }

  const soonest = (a: Slot, b: Slot) => a.at - b.at;

  return { past: past.sort(soonest), next: next.sort(soonest), later: later.sort(soonest) };
}

const WEEK_MS = 7 * 86_400_000;

/** Each slot with its time, written only on the first of a run of rows that share it. */
function once(slots: readonly Slot[], timeOf: (slot: Slot) => string): [Slot, string][] {
  return slots.map((slot, index) => {
    const time = timeOf(slot);
    const before = slots[index - 1];

    return [slot, before !== undefined && timeOf(before) === time ? "" : time];
  });
}

/** A row of the timeline: its time, a dot on the rail, the routine and under it a quiet note; it opens the routine. */
function SlotRow({ slot, time, onOpen }: { slot: Slot; time: string; onOpen: (event: MouseEvent) => void }) {
  return (
    <li className="today-item">
      <button type="button" className="today-row today-slot" onClick={onOpen}>
        <span className="today-time tabular">{time}</span>
        <span className="today-dot" data-tone={slot.tone} />
        <span className="today-text">
          <span className="today-title">{plain(slot.automation.title)}</span>
          {slot.note ? <span className="today-note">{slot.note}</span> : null}
        </span>
      </button>
    </li>
  );
}

/**
 * Today on one axis: what ran, with what it came to, above a line at now; what comes later today below it,
 * each routine once, at its next run; then the rest of the week, folded. `finished` is the row of today's
 * finished tasks and when the last ended, set among the runs by its time.
 */
export function Timeline({
  now,
  zone,
  busy,
  finished,
  onView,
  onRun,
}: {
  now: number;
  zone: string;
  /** Something runs now, above the timeline: an empty day says nothing. */
  busy: boolean;
  finished: { readonly at: number; readonly row: ReactNode } | null;
  onView: (view: RoutinesView) => void;
  /** Opens a routine's latest run; false when it has none to open. */
  onRun: (automation: string) => boolean;
}) {
  const { automations } = useContext(AutomationsContext);
  const [weekOpen, setWeekOpen] = useState(false);
  const { past, next, later } = slotsOf(automations.filter(notArchived), now, zone);

  // A fire opens its run; a run to come opens the routine.
  const open = (slot: Slot) => (event: MouseEvent) => {
    if (slot.tone !== "next" && onRun(slot.automation.id)) return;

    onView({ page: "edit", id: slot.automation.id, back: "today", glide: glideOf(event) });
  };

  if (past.length + next.length + later.length === 0 && finished === null)
    return busy ? null : <p className="today-empty">Nothing today.</p>;

  const before = past.filter((slot) => finished === null || slot.at <= finished.at);
  const after = past.filter((slot) => finished !== null && slot.at > finished.at);
  const row = ([slot, time]: [Slot, string]) => <SlotRow key={slot.key} slot={slot} time={time} onOpen={open(slot)} />;
  const timeOf = (slot: Slot) => (slot.tone === "working" || slot.tone === "queued" ? "now" : clockIn(slot.at, zone));

  return (
    <ol className="today-list" aria-label="Today">
      {once(before, timeOf).map(row)}
      {finished?.row}
      {once(after, timeOf).map(row)}
      <li className="today-now" aria-label={`Now, ${clockIn(now, zone)}`}>
        Now {clockIn(now, zone)}
      </li>
      {once(next, timeOf).map(row)}
      {later.length > 0 ? (
        <li className="today-item">
          <button type="button" className="today-group disclosure" aria-expanded={weekOpen} onClick={() => setWeekOpen(!weekOpen)}>
            Later this week · {later.length}
            <Icon name="chevronRight" size={12} className="chevron" />
          </button>
        </li>
      ) : null}
      {weekOpen ? once(later, (slot) => weekdayIn(slot.at, zone)).map(row) : null}
    </ol>
  );
}

// Check-ins: ky looks again, on the day, at something you asked about with a date ahead.
function CheckInsSwitch() {
  const { checkIns, onCheckIns } = useContext(AutomationsContext);

  return (
    <button
      type="button"
      className="feed-action pressable"
      aria-pressed={checkIns}
      title={`${NAME} looks again on the day at things you asked about with a date ahead, and tells you only what's new`}
      onClick={() => onCheckIns(!checkIns)}
    >
      Check-ins {checkIns ? "on" : "off"}
    </button>
  );
}

/** The sheet or a routine's form, in place of today's timeline; Escape and the back button leave it. */
export function RoutinesPage({
  view,
  now,
  zone,
  session,
  onView,
}: {
  view: Exclude<RoutinesView, { page: "today" }>;
  now: number;
  zone: string;
  session: string;
  onView: (view: RoutinesView) => void;
}) {
  const { automations } = useContext(AutomationsContext);

  if (view.page === "all") return <AllRoutines glide={view.glide} now={now} session={session} onView={onView} />;
  const back = () => onView(view.back === "all" ? { page: "all", glide: false } : TODAY);
  const automation = automations.find((each) => each.id === view.id);

  // Deleted while open, by ky or another tab: back to where it came from.
  if (view.id !== NEW && automation === undefined) return <BackTo view={back} />;

  return (
    <section className="routine-page" data-glide={view.glide || undefined}>
      <AutomationForm key={view.id} automation={automation} zone={automation?.zone ?? zone} now={now} onClose={back} />
    </section>
  );
}

/** Leaves a page whose routine is gone, once rendered. */
function BackTo({ view }: { view: () => void }) {
  useEffect(view, []);

  return null;
}

// Every routine, soonest first, to pause, resume, run or open; New and Check-ins at the top; archived ones folded below.
function AllRoutines({ glide, now, session, onView }: { glide: boolean; now: number; session: string; onView: (view: RoutinesView) => void }) {
  const { automations: all } = useContext(AutomationsContext);
  const automations = all.filter(notArchived);
  const archived = all.filter((automation) => automation.status === "archived");
  const edit = (id: string) => (event: MouseEvent) => onView({ page: "edit", id, back: "all", glide: glideOf(event) });

  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") onView(TODAY);
  };

  return (
    <section className="routines" aria-label="Routines" data-glide={glide || undefined} onKeyDown={escape}>
      <button type="button" className="page-back pressable" onClick={() => onView(TODAY)}>
        <Icon name="arrowLeft" size={14} />
        Today
      </button>
      <header className="routines-head">
        <h3 className="routines-title">Routines</h3>
        <CheckInsSwitch />
        <button type="button" className="feed-action pressable" onClick={edit(NEW)}>
          <Icon name="plus" size={12} />
          New
        </button>
      </header>
      {automations.length === 0 ? (
        <p className="routines-empty">No routines yet.</p>
      ) : (
        <ul className="feed">
          {byNextRun(automations).map((automation) => (
            <RoutineItem key={automation.id} automation={automation} now={now} session={session} onEdit={edit(automation.id)} />
          ))}
        </ul>
      )}
      <ArchivedAutomations archived={archived} />
    </section>
  );
}

// Archived automations, folded away until asked for; unarchiving one brings it back paused.
function ArchivedAutomations({ archived }: { archived: readonly AutomationInfo[] }) {
  const { onAction } = useContext(AutomationsContext);
  const [open, setOpen] = useState(false);

  if (archived.length === 0) return null;

  return (
    <>
      <button type="button" className="routines-archived disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        Archived · {archived.length}
        <Icon name="chevronRight" size={12} className="chevron" />
      </button>
      {open && (
        <ul className="feed" aria-label="Archived automations">
          {archived.map((automation) => (
            <li key={automation.id} className="feed-item routine" aria-label={automation.title} data-paused>
              <span className="routine-button">
                <span className="today-dot" data-tone="stopped" />
                <span className="routine-title">{plain(automation.title)}</span>
                <span className="routine-when tabular">{scheduleOf(automation)}</span>
              </span>
              <button type="button" className="automation-text pressable" onClick={() => onAction(automation.id, "unarchive")}>
                Unarchive
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

type TaskStatus = TaskRow["status"];

const RAN: Record<TaskStatus, string> = {
  queued: "Running",
  working: "Running",
  done: "Ran",
  failed: "Failed",
  stopped: "Stopped",
};

/** The last run as a word and how long ago: "Ran 2h ago", "Failed 5m ago", "Running"; null before the first run. */
function lastOf(automation: AutomationInfo, now: number): { status: TaskStatus; text: string } | null {
  const last = automation.last_run;

  if (!last) return null;
  const word = RAN[last.status];

  if (last.finished_at === null) return { status: last.status, text: word };
  const since = ago(last.finished_at, now);

  return { status: last.status, text: since === "now" ? `${word} just now` : `${word} ${since} ago` };
}

/** What the row shows and offers in each state it can be listed in. */
const STATES = {
  active: {
    tone: undefined,
    toggle: "Pause",
    action: "pause",
    icon: "pause",
    runs: true,
  },
  paused: {
    tone: "stopped",
    toggle: "Resume",
    action: "resume",
    icon: "play",
    runs: false,
  },
} as const;

type ItemProps = {
  automation: AutomationInfo;
  now: number;
  /** The open chat, so a card names where it reports only when that is elsewhere. */
  session: string;
};

// One line: how the last run went, the title, when it runs and when next; run and pause on hover.
function RoutineItem({ automation, now, onEdit }: ItemProps & { onEdit: (event: MouseEvent) => void }) {
  const { onAction } = useContext(AutomationsContext);
  const paused = automation.status === "paused";
  const state = STATES[paused ? "paused" : "active"];

  return (
    <li className="feed-item automation routine" aria-label={automation.title} data-paused={paused || undefined}>
      <button type="button" className="routine-button" aria-label={`Edit ${automation.title}`} onClick={onEdit}>
        <span className="today-dot" data-tone={paused ? "stopped" : (automation.last_run?.status ?? "next")} />
        <span className="routine-title">{plain(automation.title)}</span>
        <span className="routine-when tabular">{scheduleOf(automation)}</span>
        <span className="routine-next tabular">{nextOf(automation, now)}</span>
      </button>
      <AutomationActions id={automation.id} state={state} onAction={onAction} />
    </li>
  );
}

/** The automations and what the user can do to one, for a routine in the chat's cards; provided around the chat. */
export const RoutinesContext = createContext<{
  automations: readonly AutomationInfo[];
  onAction: (automation: string, action: AutomationAction) => void;
}>({ automations: [], onAction: () => {} });

/**
 * A routine in one of ky's cards (a `routine` block): the model names it, and the row reads it from the automations
 * the page already holds, so its schedule, next and last run stay current and no status text is the model's.
 */
export function RoutineBlock({ id }: { id: string }) {
  const { automations, onAction } = useContext(RoutinesContext);
  const automation = automations.find((each) => each.id === id);
  const now = Date.now();

  if (automation === undefined) return <p className="ui-routine-gone quiet">That routine is gone.</p>;
  const archived = automation.status === "archived";
  const paused = automation.status === "paused";
  const state = STATES[paused ? "paused" : "active"];

  return (
    <div className="ui-routine feed-item automation" aria-label={automation.title} data-paused={paused || archived || undefined}>
      <span className="feed-button">
        <span className="feed-glyph" data-tone={archived ? "stopped" : state.tone}>
          <Icon name="clock" size={16} />
        </span>
        <span className="feed-text">
          <span className="feed-title">{plain(automation.title)}</span>
          <span className="feed-step tabular">{archived ? `${scheduleOf(automation)} · Archived` : metaOf(automation, now)}</span>
          {/* A card leaves out which chat the routine reports to. */}
          <Details automation={automation} now={now} session={automation.chat} />
        </span>
      </span>
      {archived ? null : <AutomationActions id={automation.id} state={state} onAction={onAction} />}
    </div>
  );
}

/** One chip under an automation's title; `title` is shown on hover. */
type Detail = { readonly key: string; readonly text: string; readonly title?: string };

/** A gated automation's chip: its last check's outcome, and the whole note on hover. */
function gateDetail(note: string | null): Detail {
  if (note === null) return { key: "gate", text: "gated" };

  return { key: "gate", text: `gate: ${note.split(":")[0]}`, title: note };
}

/** The last run, then only what differs from the usual: another chat, its own model, a machine, a gate, a post. */
function Details({ automation, now, session }: ItemProps) {
  const last = lastOf(automation, now);
  const chat = automation.chat === MAIN_SESSION ? "Main chat" : plain(automation.chat_label);

  const extras = [
    automation.chat === session ? null : { key: "chat", text: `to ${chat}` },
    automation.model ? { key: "model", text: automation.model.modelId } : null,
    automation.machine ? { key: "machine", text: `on ${automation.machine}` } : null,
    automation.gate ? gateDetail(automation.gate_note) : null,
    automation.post ? { key: "post", text: "posted", title: "Its report is posted as written, with no reply" } : null,
  ].flatMap((extra) => extra ?? []);

  if (!last && extras.length === 0) return null;

  return (
    <span className="automation-details">
      {last && (
        <span className="automation-last" data-status={last.status}>
          {last.text}
        </span>
      )}
      {extras.map((extra) => (
        <span key={extra.key} className="automation-detail" data-detail={extra.key} title={extra.title}>
          {extra.text}
        </span>
      ))}
    </span>
  );
}

function IconButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: "play" | "pause" | "x";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="icon-button pressable"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

function AutomationActions({
  id,
  state,
  onAction,
}: {
  id: string;
  state: (typeof STATES)[keyof typeof STATES];
  onAction: (automation: string, action: AutomationAction) => void;
}) {
  return (
    <span className="automation-actions">
      {state.runs && (
        <IconButton
          label="Run now"
          icon="play"
          onClick={() => onAction(id, "run")}
        />
      )}
      <IconButton
        label={state.toggle}
        icon={state.icon}
        onClick={() => onAction(id, state.action)}
      />
    </span>
  );
}

/** The rhythm chips, each the shape of schedule it writes. */
const CHIPS = [
  { chip: "once", label: "Once" },
  { chip: "hourly", label: "Hourly" },
  { chip: "hours", label: "Every few hours" },
  { chip: "daily", label: "Daily" },
  { chip: "weekly", label: "Weekly" },
  { chip: "cron", label: "Cron" },
] as const;

type Chip = (typeof CHIPS)[number]["chip"];

/** The form's fields as the inputs hold them. Times are wall-clock times in the routine's zone. */
type Form = {
  title: string;
  prompt: string;
  chip: Chip;
  /** The cron as written, for the Cron chip. */
  cron: string;
  /** A one-off's time, for a datetime-local input. */
  at: string;
  /** "HH:MM": Daily's and Weekly's time, and the hour Every few hours starts from. */
  clock: string;
  /** Hourly's minute past the hour. */
  minute: number;
  /** Every few hours' step. */
  every: number;
  /** Weekly's days, 0-6 from Sunday. */
  days: readonly number[];
  /** provider/modelId, or empty for the worker model. */
  model: string;
  thinking: string;
  /** A machine's name, or empty for the cloud. */
  machine: string;
  /** "ky", or the id of the specialist it runs as. */
  owner: string;
  chat: string;
  /** An Executor program each fire runs first, or empty for none. */
  gate: string;
};

const pad = (value: number) => String(value).padStart(2, "0");

/** A form with a schedule's fields at their defaults: weekdays at 9:00 AM. */
function blank(now: number, zone: string): Form {
  return {
    title: "",
    prompt: "",
    chip: "weekly",
    cron: "0 9 * * 1-5",
    at: wallInput(Math.ceil(now / 3_600_000) * 3_600_000, zone),
    clock: "09:00",
    minute: 0,
    every: 3,
    days: [1, 2, 3, 4, 5],
    model: "",
    thinking: "",
    machine: "",
    owner: KY,
    chat: MAIN_SESSION,
    gate: "",
  };
}

/** A cron's chip and the fields it fills; a shape no chip writes opens on Cron. */
function timingFields(cron: string): Partial<Form> {
  const rhythm = rhythmOf(cron);

  switch (rhythm.kind) {
    case "hourly":
      return rhythm.days.length === 7 ? { chip: "hourly", minute: rhythm.minute } : { chip: "cron" };
    case "hours":
      return HOUR_STEPS.some((step) => step === rhythm.every)
        ? { chip: "hours", every: rhythm.every, clock: `${pad(rhythm.hour)}:${pad(rhythm.minute)}` }
        : { chip: "cron" };
    case "daily":
      return {
        chip: rhythm.days.length === 7 ? "daily" : "weekly",
        clock: `${pad(rhythm.hour)}:${pad(rhythm.minute)}`,
        days: rhythm.days.length === 7 ? [1, 2, 3, 4, 5] : rhythm.days,
      };
    default:
      return { chip: "cron" };
  }
}

export function modelFields(
  model: ModelChoice | null,
): Pick<Form, "model" | "thinking"> {
  return model
    ? {
        model: `${model.provider}/${model.modelId}`,
        thinking: model.thinkingLevel,
      }
    : { model: "", thinking: "" };
}

function formOf(automation: AutomationInfo | undefined, now: number, zone: string): Form {
  const empty = blank(now, zone);

  if (!automation) return empty;
  const { title, prompt, chat, cron, at } = automation;
  const timing = cron === null ? { chip: "once" as const, at: wallInput(at ?? now, zone) } : { cron, ...timingFields(cron) };

  return {
    ...empty,
    title,
    prompt,
    chat,
    machine: automation.machine ?? "",
    owner: automation.owner,
    gate: automation.gate ?? "",
    ...timing,
    ...modelFields(automation.model),
  };
}

/** "HH:MM" as an hour and minute. */
function clockParts(clock: string) {
  const [hour = 0, minute = 0] = clock.split(":").map(Number);

  return { hour, minute };
}

/** The cron the chosen chip and its fields write; null for a one-off. */
function cronFor(form: Form): string | null {
  const clock = clockParts(form.clock);

  switch (form.chip) {
    case "once":
      return null;
    case "hourly":
      return cronOf({ kind: "hourly", minute: form.minute, days: [0, 1, 2, 3, 4, 5, 6] });
    case "hours":
      return cronOf({ kind: "hours", every: form.every, ...clock });
    case "daily":
      return cronOf({ kind: "daily", ...clock, days: [0, 1, 2, 3, 4, 5, 6] });
    case "weekly":
      return cronOf({ kind: "daily", ...clock, days: form.days });
    case "cron":
      return form.cron.trim();
  }
}

type Pickable = {
  value: string;
  label: string;
  /** Listed in the picker; the rest can be stored and still resolve. */
  featured: boolean;
  levels: readonly ModelThinkingLevel[];
};

/** Every model a connected provider offers, as `provider/modelId`, featured or not. */
export function modelChoices(providers: readonly ProviderInfo[]): Pickable[] {
  return providers.flatMap((provider) =>
    provider.connected
      ? provider.models.map((model) => ({
          value: `${provider.id}/${model.modelId}`,
          label: `${model.name} · ${provider.name}`,
          featured: model.featured,
          levels: model.levels,
        }))
      : [],
  );
}

/** The chosen thinking level if the model takes it, else its lowest. */
function levelOf(
  thinking: string,
  levels: readonly ModelThinkingLevel[],
): ModelThinkingLevel {
  return levels.find((level) => level === thinking) ?? levels[0] ?? "off";
}

export function choiceOf(
  form: Pick<Form, "model" | "thinking">,
  choices: readonly Pickable[],
): ModelChoice | null {
  const choice = choices.find((each) => each.value === form.model);

  if (!choice) return null;
  const [provider = "", ...rest] = choice.value.split("/");

  return {
    provider,
    modelId: rest.join("/"),
    thinkingLevel: levelOf(form.thinking, choice.levels),
  };
}

function draftOf(form: Form, choices: readonly Pickable[], zone: string): AutomationDraft {
  const cron = cronFor(form);
  const timing = cron === null ? { cron: null, at: inputTime(form.at, zone) } : { cron, at: null };

  return {
    title: form.title.trim(),
    prompt: form.prompt.trim(),
    ...timing,
    model: choiceOf(form, choices),
    machine: form.machine || null,
    owner: form.owner,
    chat: form.chat,
    gate: form.gate.trim() || null,
  };
}

/** Everything a save needs: words, and when it runs. */
function complete(form: Form): boolean {
  const when = form.chip === "once" ? form.at : form.chip === "weekly" && form.days.length === 0 ? "" : (cronFor(form) ?? "");

  return [form.title, form.prompt, when].every((field) => field.trim() !== "");
}

type FieldProps = { form: Form; set: (patch: Partial<Form>) => void };

// The routine's title as the header and how its last run went; its prompt; its schedule; where it runs and
// reports; the rarely changed under More; then leaving it, running it and saving.
export function AutomationForm({
  automation,
  zone,
  now,
  onClose,
  onSaved = onClose,
  page = false,
}: {
  automation?: AutomationInfo | undefined;
  zone: string;
  now: number;
  onClose: () => void;
  /** After a save; closes the form unless the form is a page that stays. */
  onSaved?: () => void;
  /** On a routine's own page, which shows the last run and Run now itself. */
  page?: boolean;
}) {
  const { providers, onSave, onAction } = useContext(AutomationsContext);
  const [form, setForm] = useState(() => formOf(automation, now, zone));
  const [refused, setRefused] = useState<string | undefined>();
  const set = (patch: Partial<Form>) => setForm((current) => ({ ...current, ...patch }));
  const label = automation ? "Edit automation" : "New automation";

  const save = async (event: FormEvent) => {
    event.preventDefault();

    const why = await onSave(automation?.id, draftOf(form, modelChoices(providers), zone));

    setRefused(why);

    if (why === undefined) onSaved();
  };

  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") onClose();
  };

  return (
    <form className="automation-form routine-form" aria-label={label} onSubmit={save} onKeyDown={escape}>
      <div className="routine-form-head">
        <input
          className="routine-name"
          aria-label="Title"
          placeholder="Name it"
          // A new routine starts at its name; an opened one at nothing, so no keyboard pops up.
          autoFocus={!automation}
          value={form.title}
          onChange={(event) => set({ title: event.target.value })}
        />
        {page ? null : <IconButton label="Cancel" icon="x" onClick={onClose} />}
      </div>
      {automation && !page ? <LastRun automation={automation} now={now} /> : null}
      <div className="card routine-prompt-card">
        <textarea
          className="automation-prompt"
          aria-label="Prompt"
          placeholder="What each run does. It knows nothing else."
          rows={3}
          value={form.prompt}
          onChange={(event) => set({ prompt: event.target.value })}
        />
      </div>
      <ScheduleCard form={form} set={set} zone={zone} now={now} />
      <div className="card">
        <PlaceFields form={form} set={set} />
      </div>
      <MoreFields form={form} set={set} />
      {refused && (
        <p className="automation-refused" role="alert">
          {refused}
        </p>
      )}
      <div className="automation-foot">
        {automation && <EndMenu id={automation.id} onClose={onClose} />}
        {automation && !page && automation.status !== "archived" ? (
          <button type="button" className="pill pressable routine-run" onClick={() => onAction(automation.id, "run")}>
            Run now
          </button>
        ) : null}
        <button type="submit" className="pill primary pressable" disabled={!complete(form)}>
          Save
        </button>
      </div>
    </form>
  );
}

/** How the last run went, how long ago, what it came to, and the gate's last check; the first thing asked of a routine. */
function LastRun({ automation, now }: { automation: AutomationInfo; now: number }) {
  const last = lastOf(automation, now);
  const run = automation.last_run;
  const gate = automation.gate ? gateDetail(automation.gate_note) : null;
  const result = run && last && last.status !== "queued" && last.status !== "working" ? resultOf(run) : null;

  if (!last && !gate) return <p className="routine-last">Hasn't run yet</p>;

  return (
    <p className="routine-last">
      {last ? (
        <span className="automation-last" data-status={last.status}>
          {last.text}
        </span>
      ) : null}
      {result && result !== "done" ? <span className="routine-result">{result}</span> : null}
      {gate ? (
        <span className="automation-detail" data-detail="gate" title={gate.title}>
          {gate.text}
        </span>
      ) : null}
    </p>
  );
}

/** Days for Weekly's toggles, Monday first. */
const DAYS = [
  [1, "M", "Monday"],
  [2, "T", "Tuesday"],
  [3, "W", "Wednesday"],
  [4, "T", "Thursday"],
  [5, "F", "Friday"],
  [6, "S", "Saturday"],
  [0, "S", "Sunday"],
] as const;

// The rhythm as chips, the few fields it needs, a sentence of what that comes to, and the next three runs to prove it.
function ScheduleCard({ form, set, zone, now }: FieldProps & { zone: string; now: number }) {
  const cron = cronFor(form);

  const choose = (chip: Chip) => {
    // The raw cron starts as what the chips wrote, so Cron is a way to fine-tune it.
    if (chip === "cron" && cron !== null && form.chip !== "cron") set({ chip, cron });
    else set({ chip });
  };

  const at = inputTime(form.at, zone);

  const sentence =
    cron === null
      ? Number.isNaN(at)
        ? `Once · ${zoneName(zone)}`
        : `Once · ${new Date(at).toLocaleString(undefined, { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · ${zoneName(zone)}`
      : scheduleSentence(cron, zone);

  const runs = cron === null ? [] : previewOf(cron, zone, now);

  return (
    <div className="card routine-schedule">
      <div className="routine-chips" role="radiogroup" aria-label="Rhythm">
        {CHIPS.map(({ chip, label }) => (
          <button key={chip} type="button" role="radio" aria-checked={form.chip === chip} className="routine-chip pressable" onClick={() => choose(chip)}>
            {label}
          </button>
        ))}
      </div>
      <RhythmFields form={form} set={set} />
      <p className="routine-sentence">{sentence}</p>
      {runs.length > 0 ? (
        <p className="routine-runs tabular">Next: {runs.map((run) => runIn(run, zone, now)).join(" · ")}</p>
      ) : null}
    </div>
  );
}

/** The next three runs, as the server books them; none for a cron it cannot read. */
function previewOf(cron: string, zone: string, now: number): number[] {
  try {
    return nextLocals(cron, zone, now, 3);
  } catch {
    return [];
  }
}

/** The fields the chosen chip needs: a time, a minute, a step, days, or the cron itself. */
function RhythmFields({ form, set }: FieldProps) {
  const time = (label: string) => (
    <input className="routine-field" aria-label={label} type="time" value={form.clock} onChange={(event) => set({ clock: event.target.value })} />
  );

  switch (form.chip) {
    case "once":
      return (
        <div className="routine-fields">
          <input className="routine-field" aria-label="Time" type="datetime-local" value={form.at} onChange={(event) => set({ at: event.target.value })} />
        </div>
      );
    case "hourly":
      return (
        <div className="routine-fields">
          At minute
          <input
            className="routine-field routine-minute"
            aria-label="Minute"
            type="number"
            min={0}
            max={59}
            value={form.minute}
            onChange={(event) => set({ minute: Math.min(59, Math.max(0, Math.trunc(Number(event.target.value) || 0))) })}
          />
        </div>
      );
    case "hours":
      return (
        <div className="routine-fields">
          Every
          <span className="automation-pick routine-step">
            <select aria-label="Every" value={form.every} onChange={(event) => set({ every: Number(event.target.value) })}>
              {HOUR_STEPS.map((step) => (
                <option key={step} value={step}>
                  {step} hours
                </option>
              ))}
            </select>
            <Icon name="chevronDown" size={12} />
          </span>
          from {time("From")}
        </div>
      );
    case "daily":
      return <div className="routine-fields">At {time("At")}</div>;
    case "weekly":
      return (
        <div className="routine-fields">
          <span className="routine-days" role="group" aria-label="Days">
            {DAYS.map(([day, letter, name]) => (
              <button
                key={day}
                type="button"
                className="routine-day pressable"
                aria-label={name}
                aria-pressed={form.days.includes(day)}
                onClick={() => set({ days: form.days.includes(day) ? form.days.filter((each) => each !== day) : [...form.days, day] })}
              >
                {letter}
              </button>
            ))}
          </span>
          at {time("At")}
        </div>
      );
    case "cron":
      return (
        <div className="routine-fields">
          <input
            className="routine-field automation-cron"
            aria-label="Cron"
            placeholder="0 9 * * 1-5"
            spellCheck={false}
            value={form.cron}
            onChange={(event) => set({ cron: event.target.value })}
          />
        </div>
      );
  }
}

/** A settings row: its name on the left, a quiet select on the right. */
export function Pick({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="row">
      <span className="row-label">{label}</span>
      <span className="automation-pick">
        <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
          {children}
        </select>
        <Icon name="chevronDown" size={12} />
      </span>
    </label>
  );
}

// The model and the gate, which most routines leave alone: folded, unless this one sets either.
function MoreFields({ form, set }: FieldProps) {
  const [open, setOpen] = useState(() => form.model !== "" || form.gate !== "");
  const { providers } = useContext(AutomationsContext);

  return (
    <>
      <button type="button" className="routine-more disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevronRight" size={12} className="chevron" />
        More
        <span className="routine-more-sub">Model, gate</span>
      </button>
      {open ? (
        <div className="card routine-more-card">
          <ModelPicks providers={providers} form={form} set={set} />
          <label className="automation-gate">
            <span className="automation-gate-label">Gate</span>
            <textarea
              aria-label="Gate"
              placeholder="Optional. An Executor program that returns what to act on, or null to skip the run."
              rows={1}
              spellCheck={false}
              value={form.gate}
              onChange={(event) => set({ gate: event.target.value })}
            />
          </label>
        </div>
      ) : null}
    </>
  );
}

/** The model and, when it has levels, the thinking picks; an empty model is the worker's. */
export function ModelPicks({
  providers,
  form,
  set,
}: {
  providers: readonly ProviderInfo[];
  form: Pick<Form, "model" | "thinking">;
  set: (patch: Partial<Pick<Form, "model" | "thinking">>) => void;
}) {
  const choices = modelChoices(providers);
  const levels = choices.find((choice) => choice.value === form.model)?.levels ?? [];

  return (
    <>
      <Pick label="Model" value={form.model} onChange={(model) => set({ model })}>
        <option value="">Subagents model</option>
        {choices.filter((choice) => choice.featured || choice.value === form.model).map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </Pick>
      {levels.length > 1 && (
        <Pick label="Thinking" value={levelOf(form.thinking, levels)} onChange={(thinking) => set({ thinking })}>
          {levels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </Pick>
      )}
    </>
  );
}

function PlaceFields({ form, set }: FieldProps) {
  const { machines, specialists, chats } = useContext(AutomationsContext);
  const listed = chats.filter((chat) => chat.archived_at === null || chat.session === form.chat);
  const owners = specialists.some((each) => each.id === form.owner) || form.owner === KY ? specialists : [...specialists, { id: form.owner }];

  return (
    <>
      {owners.length > 0 && (
        <Pick label="Owner" value={form.owner} onChange={(owner) => set({ owner })}>
          <option value={KY}>{KY}</option>
          {owners.map((each) => (
            <option key={each.id} value={each.id}>
              @{each.id}
            </option>
          ))}
        </Pick>
      )}
      <Pick label="Runs on" value={form.machine} onChange={(machine) => set({ machine })}>
        <option value="">The cloud</option>
        {machines.map((machine) => (
          <option key={machine.name} value={machine.name}>
            {machine.name}
          </option>
        ))}
      </Pick>
      <Pick label="Reports to" value={form.chat} onChange={(chat) => set({ chat })}>
        <option value={MAIN_SESSION}>Main chat</option>
        {listed.map((chat) => (
          <option key={chat.session} value={chat.session}>
            {chat.title || "Untitled side chat"}
          </option>
        ))}
      </Pick>
    </>
  );
}

/** Archive and Delete, away from Save behind ⋯. Archive keeps it for ky to bring back; Delete asks once more. */
function EndMenu({ id, onClose }: { id: string; onClose: () => void }) {
  const { onAction } = useContext(AutomationsContext);
  const [open, setOpen] = useState<false | "pointer" | "keyboard">(false);
  const [sure, setSure] = useState(false);

  const end = (action: AutomationAction) => {
    onAction(id, action);
    onClose();
  };

  // Focus that leaves the menu and its button closes it.
  const blur = (event: FocusEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  };

  return (
    <span className="routine-end" onBlur={blur}>
      <button
        type="button"
        className="icon-button pressable routine-end-button"
        aria-label="More actions"
        aria-expanded={open !== false}
        onClick={(event) => setOpen(open ? false : event.detail === 0 ? "keyboard" : "pointer")}
      >
        <Icon name="more" size={16} />
      </button>
      {open ? (
        <span className="routine-menu" role="group" aria-label="More actions" data-glide={open === "pointer" || undefined}>
          <button type="button" className="automation-text pressable" onClick={() => end("archive")}>
            Archive
          </button>
          <button type="button" className="automation-text danger pressable" onClick={() => (sure ? end("delete") : setSure(true))}>
            {sure ? "Delete for good" : "Delete"}
          </button>
        </span>
      ) : null}
    </span>
  );
}
