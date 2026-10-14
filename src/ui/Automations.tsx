import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createContext, type FormEvent, type KeyboardEvent, type ReactNode, useContext, useState } from "react";
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
import { byNextRun } from "./automation-order";
import { Icon } from "./Icon";
import { MAIN_SESSION } from "./open-chat";
import { plain } from "./plain";
import { ago } from "./time";

const PLAIN_CRON = /^(\d+) (\d+|\*) \* \* (\S+)$/;

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const EVERY = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"] as const;

/** A cron weekday field as days 0-6, or undefined when it is not a plain list or range. */
function weekdays(field: string): number[] | undefined {
  if (field === "*") return [0, 1, 2, 3, 4, 5, 6];
  const days = new Set<number>();

  for (const part of field.split(",")) {
    const range = /^(\d)(?:-(\d))?$/.exec(part);

    if (!range) return undefined;
    const from = Number(range[1]);
    const to = Number(range[2] ?? range[1]);

    if (to < from || to > 7) return undefined;

    for (let day = from; day <= to; day++) days.add(day % 7);
  }

  return [...days].sort((a, b) => a - b);
}

/** Days 0-6 in words: Daily, Weekdays, Weekends, Mondays, or Mon, Wed, Fri. */
function daysInWords(days: readonly number[]): string {
  const key = days.join(",");

  if (days.length === 7) return "Daily";

  if (key === "1,2,3,4,5") return "Weekdays";

  if (key === "0,6") return "Weekends";

  if (days.length === 1) return EVERY[days[0] ?? 0] ?? key;

  // Monday first, as a week reads.
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((day) => WEEK[day]).join(", ");
}

const clockOf = (date: Date) => date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * A plain hourly, daily or weekly UTC cron in the browser's time: "Daily · 7:00 AM",
 * "Weekdays · 9:30 AM", "Hourly at :45"; undefined for any other cron.
 */
function plainTime([, minute = "", hour = "", weekday = ""]: string[], now: number): string | undefined {
  const utc = new Date(now);

  utc.setUTCHours(hour === "*" ? 0 : Number(hour), Number(minute), 0, 0);

  if (hour === "*")
    return weekday === "*" ? `Hourly at :${String(utc.getMinutes()).padStart(2, "0")}` : undefined;
  const days = weekdays(weekday);

  if (!days) return undefined;
  // The local day can fall a day either side of the UTC one.
  const shift = (utc.getDay() - utc.getUTCDay() + 7) % 7;
  const local = days.map((day) => (day + shift) % 7).sort((a, b) => a - b);

  return `${daysInWords(local)} · ${clockOf(utc)}`;
}

/** A cron in words, in the browser's time, when it is a plain hourly, daily or weekly time; else as written, in UTC. */
function cronInWords(cron: string, now = Date.now()): string {
  const parts = PLAIN_CRON.exec(cron);

  return (parts && plainTime([...parts], now)) ?? `${cron} UTC`;
}

/** When it runs: a cron, or a one-off's local time. */
function scheduleOf(automation: AutomationInfo, now: number): string {
  if (automation.cron !== null) return cronInWords(automation.cron, now);

  const at = new Date(automation.at ?? 0).toLocaleString(undefined, {
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

/** The row's one muted line: when it runs, when next, and a quiet "by ky" or "check-in" when ky made it. */
function metaOf(automation: AutomationInfo, now: number): string {
  const by = automation.created_by === "ky" ? ["by ky"] : automation.created_by === "dream" ? ["check-in"] : [];

  return [scheduleOf(automation, now), nextOf(automation, now), ...by].join(" · ");
}

/** The automations, what the user can do to one, and what a form offers; provided around the panel. */
export const AutomationsContext = createContext<{
  automations: readonly AutomationInfo[];
  providers: readonly ProviderInfo[];
  machines: readonly MachineInfo[];
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
  chats: [],
  onAction: () => {},
  onSave: async () => undefined,
  checkIns: true,
  onCheckIns: () => {},
});

/** The editor open in the list: a new automation, one by id, or none. */
const NEW = "new";

// Check-ins: ky looks again, on the day, at something you asked about with a date ahead.
function CheckInsSwitch() {
  const { checkIns, onCheckIns } = useContext(AutomationsContext);

  return (
    <button
      type="button"
      className="feed-action pressable"
      aria-pressed={checkIns}
      title="ky looks again on the day at things you asked about with a date ahead, and tells you only what's new"
      onClick={() => onCheckIns(!checkIns)}
    >
      Check-ins {checkIns ? "on" : "off"}
    </button>
  );
}

// Scheduled work, active and paused: add, edit, run now, pause, resume, archive and delete.
export function Automations({ now, session }: { now: number; session: string }) {
  const { automations } = useContext(AutomationsContext);
  const [editing, setEditing] = useState<string | null>(null);
  const close = () => setEditing(null);
  // Nothing to list: the empty state stands in for the card.
  const empty = automations.length === 0 && editing === null;

  return (
    <section className="feed-group automations">
      <h3 className="feed-head">
        Automations
        <CheckInsSwitch />
        <button
          type="button"
          className="feed-action pressable"
          onClick={() => setEditing(NEW)}
        >
          <Icon name="plus" size={12} />
          New
        </button>
      </h3>
      {empty ? (
        <p className="group-empty">Nothing scheduled. Add one, or ask ky.</p>
      ) : (
        <ul className="feed">
          {editing === NEW && <AutomationForm onClose={close} />}
          {byNextRun(automations).map((automation) =>
            automation.id === editing ? (
              <AutomationForm
                key={automation.id}
                automation={automation}
                onClose={close}
              />
            ) : (
              <AutomationItem
                key={automation.id}
                automation={automation}
                now={now}
                session={session}
                onEdit={() => setEditing(automation.id)}
              />
            ),
          )}
        </ul>
      )}
    </section>
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
  /** The open chat, so a row names where it reports only when that is elsewhere. */
  session: string;
  onEdit: () => void;
};

// Title, one muted line of when, and a quiet line of the last run and anything unusual; every line one line.
function AutomationItem({ automation, now, session, onEdit }: ItemProps) {
  const paused = automation.status === "paused";
  const state = STATES[paused ? "paused" : "active"];

  return (
    <li className="feed-item automation" aria-label={automation.title} data-paused={paused || undefined}>
      <button
        type="button"
        className="feed-button"
        aria-label={`Edit ${automation.title}`}
        onClick={onEdit}
      >
        <span className="feed-glyph" data-tone={state.tone}>
          <Icon name="clock" size={16} />
        </span>
        <span className="feed-text">
          <span className="feed-title">{plain(automation.title)}</span>
          <span className="feed-step tabular">{metaOf(automation, now)}</span>
          <Details automation={automation} now={now} session={session} />
        </span>
      </button>
      <AutomationActions id={automation.id} state={state} />
    </li>
  );
}

/** A gated automation's chip: its last check's outcome, and the whole note on hover. */
function gateDetail(note: string | null): { key: string; text: string; title?: string } {
  if (note === null) return { key: "gate", text: "gated" };

  return { key: "gate", text: `gate: ${note.split(":")[0]}`, title: note };
}

/** The last run, then only what differs from the usual: another chat, its own model, a machine. */
function Details({ automation, now, session }: Omit<ItemProps, "onEdit">) {
  const last = lastOf(automation, now);
  const chat = automation.chat === MAIN_SESSION ? "Main chat" : plain(automation.chat_label);

  const extras = [
    automation.chat === session ? null : { key: "chat", text: `to ${chat}` },
    automation.model ? { key: "model", text: automation.model.modelId } : null,
    automation.machine ? { key: "machine", text: `on ${automation.machine}` } : null,
    automation.gate ? gateDetail(automation.gate_note) : null,
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
}: {
  id: string;
  state: (typeof STATES)[keyof typeof STATES];
}) {
  const { onAction } = useContext(AutomationsContext);

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

/** The form's fields as the inputs hold them. */
type Form = {
  title: string;
  prompt: string;
  repeat: boolean;
  /** A UTC cron, when it repeats. */
  cron: string;
  /** A local time for a datetime-local input, when it runs once. */
  at: string;
  /** provider/modelId, or empty for the worker model. */
  model: string;
  thinking: string;
  /** A machine's name, or empty for the cloud. */
  machine: string;
  chat: string;
  /** An Executor program each fire runs first, or empty for none. */
  gate: string;
};

const BLANK: Form = {
  title: "",
  prompt: "",
  repeat: true,
  cron: "0 9 * * 1-5",
  at: "",
  model: "",
  thinking: "",
  machine: "",
  chat: MAIN_SESSION,
  gate: "",
};

/** Epoch ms as a datetime-local input's value, in local time. */
function localInput(ms: number): string {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
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

function timingFields(
  automation: AutomationInfo,
): Pick<Form, "repeat" | "cron" | "at"> {
  if (automation.cron !== null)
    return { repeat: true, cron: automation.cron, at: "" };

  return {
    repeat: false,
    cron: BLANK.cron,
    at: localInput(automation.at ?? Date.now()),
  };
}

function formOf(automation: AutomationInfo | undefined): Form {
  if (!automation) return BLANK;
  const { title, prompt, chat } = automation;

  return {
    title,
    prompt,
    chat,
    machine: automation.machine ?? "",
    gate: automation.gate ?? "",
    ...timingFields(automation),
    ...modelFields(automation.model),
  };
}

type Pickable = {
  value: string;
  label: string;
  levels: readonly ModelThinkingLevel[];
};

/** Every model a connected provider offers, as `provider/modelId`. */
export function modelChoices(providers: readonly ProviderInfo[]): Pickable[] {
  return providers.flatMap((provider) =>
    provider.connected
      ? provider.models.map((model) => ({
          value: `${provider.id}/${model.modelId}`,
          label: `${model.name} · ${provider.name}`,
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

function draftOf(form: Form, choices: readonly Pickable[]): AutomationDraft {
  const timing = form.repeat
    ? { cron: form.cron.trim(), at: null }
    : { cron: null, at: new Date(form.at).getTime() };

  return {
    title: form.title.trim(),
    prompt: form.prompt.trim(),
    ...timing,
    model: choiceOf(form, choices),
    machine: form.machine || null,
    chat: form.chat,
    gate: form.gate.trim() || null,
  };
}

/** Everything a save needs: words, and when it runs. */
function complete(form: Form): boolean {
  const when = form.repeat ? form.cron : form.at;

  return [form.title, form.prompt, when].every((field) => field.trim() !== "");
}

type FieldProps = { form: Form; set: (patch: Partial<Form>) => void };

// Two cards, like Settings: the words as one note, then how it runs as rows.
function AutomationForm({
  automation,
  onClose,
}: {
  automation?: AutomationInfo;
  onClose: () => void;
}) {
  const { providers, onSave } = useContext(AutomationsContext);
  const [form, setForm] = useState(() => formOf(automation));
  const [refused, setRefused] = useState<string | undefined>();
  const set = (patch: Partial<Form>) => setForm((current) => ({ ...current, ...patch }));
  const label = automation ? "Edit automation" : "New automation";

  const save = async (event: FormEvent) => {
    event.preventDefault();

    const why = await onSave(automation?.id, draftOf(form, modelChoices(providers)));

    setRefused(why);

    if (why === undefined) onClose();
  };

  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") onClose();
  };

  return (
    <li className="automation-editor">
      <form className="automation-form" aria-label={label} onSubmit={save} onKeyDown={escape}>
        <div className="automation-editor-head">
          <span>{label}</span>
          <IconButton label="Cancel" icon="x" onClick={onClose} />
        </div>
        <div className="card automation-words">
          <input
            className="automation-name"
            aria-label="Title"
            placeholder="Name it"
            value={form.title}
            onChange={(event) => set({ title: event.target.value })}
          />
          <textarea
            className="automation-prompt"
            aria-label="Prompt"
            placeholder="What each run does. It knows nothing else."
            rows={3}
            value={form.prompt}
            onChange={(event) => set({ prompt: event.target.value })}
          />
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
        <div className="card">
          <WhenField form={form} set={set} />
          <ModelField form={form} set={set} />
          <PlaceFields form={form} set={set} />
        </div>
        {refused && (
          <p className="automation-refused" role="alert">
            {refused}
          </p>
        )}
        <div className="automation-foot">
          {automation && <EndButtons id={automation.id} onClose={onClose} />}
          <button type="submit" className="pill primary pressable" disabled={!complete(form)}>
            Save
          </button>
        </div>
      </form>
    </li>
  );
}

const WHENS = [
  { repeat: true, label: "Repeat" },
  { repeat: false, label: "Once" },
] as const;

function WhenField({ form, set }: FieldProps) {
  return (
    <>
      <div className="row">
        <span className="row-label">When</span>
        <div className="segmented small automation-when" role="radiogroup" aria-label="When">
          {WHENS.map((when) => (
            <button
              key={when.label}
              type="button"
              role="radio"
              aria-checked={form.repeat === when.repeat}
              className="pressable"
              onClick={() => set({ repeat: when.repeat })}
            >
              {when.label}
            </button>
          ))}
        </div>
      </div>
      {form.repeat ? <CronRow form={form} set={set} /> : <TimeRow form={form} set={set} />}
    </>
  );
}

function CronRow({ form, set }: FieldProps) {
  return (
    <label className="row">
      <span className="row-text">
        <span className="row-label">Schedule</span>
        <span className="row-sub">{cronInWords(form.cron.trim())}, your time</span>
      </span>
      <input
        className="automation-cron"
        aria-label="Cron"
        placeholder="0 9 * * 1-5"
        spellCheck={false}
        value={form.cron}
        onChange={(event) => set({ cron: event.target.value })}
      />
    </label>
  );
}

function TimeRow({ form, set }: FieldProps) {
  return (
    <label className="row">
      <span className="row-text">
        <span className="row-label">Time</span>
        <span className="row-sub">Your local time</span>
      </span>
      <input
        className="automation-time"
        aria-label="Time"
        type="datetime-local"
        value={form.at}
        onChange={(event) => set({ at: event.target.value })}
      />
    </label>
  );
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

function ModelField({ form, set }: FieldProps) {
  return <ModelPicks providers={useContext(AutomationsContext).providers} form={form} set={set} />;
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
        {choices.map((choice) => (
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
  const { machines, chats } = useContext(AutomationsContext);
  const listed = chats.filter((chat) => chat.archived_at === null || chat.session === form.chat);

  return (
    <>
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

/** Archive keeps it for ky to bring back; delete asks once more, then removes it for good. */
function EndButtons({ id, onClose }: { id: string; onClose: () => void }) {
  const { onAction } = useContext(AutomationsContext);
  const [sure, setSure] = useState(false);

  const end = (action: AutomationAction) => {
    onAction(id, action);
    onClose();
  };

  return (
    <span className="automation-end">
      <button type="button" className="automation-text pressable" onClick={() => end("archive")}>
        Archive
      </button>
      <button
        type="button"
        className="automation-text danger pressable"
        onClick={() => (sure ? end("delete") : setSure(true))}
      >
        {sure ? "Delete for good" : "Delete"}
      </button>
    </span>
  );
}
