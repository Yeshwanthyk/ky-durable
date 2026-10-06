import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createContext, type FormEvent, type KeyboardEvent, type ReactNode, useContext, useState } from "react";
import type {
  AutomationAction,
  AutomationDraft,
  AutomationInfo,
  ChatRow,
  MachineInfo,
  ProviderInfo,
  SlotSetting,
} from "../protocol";
import { Icon } from "./Icon";
import { MAIN_SESSION } from "./open-chat";
import { ago } from "./time";

const DAYS = new Map([
  ["*", "Every day"],
  ["1-5", "Weekdays"],
  ["0,6", "Weekends"],
  ["6,0", "Weekends"],
  ["0", "Sundays"],
  ["1", "Mondays"],
  ["2", "Tuesdays"],
  ["3", "Wednesdays"],
  ["4", "Thursdays"],
  ["5", "Fridays"],
  ["6", "Saturdays"],
]);

const PLAIN_CRON = /^(\d+) (\d+|\*) \* \* (\S+)$/;

/** "Weekdays 9:00 UTC" or "Hourly at :15", or undefined for any other cron. */
function plainTime([, minute = "", hour, weekday = ""]: string[]):
  string | undefined {
  if (hour === "*")
    return weekday === "*"
      ? `Hourly at :${minute.padStart(2, "0")}`
      : undefined;
  const days = DAYS.get(weekday);

  return days && `${days} ${hour}:${minute.padStart(2, "0")} UTC`;
}

/** A cron in words when it is a plain hourly, daily or weekly time, else as written; crons are UTC. */
function cronInWords(cron: string): string {
  const parts = PLAIN_CRON.exec(cron);

  return (parts && plainTime([...parts])) ?? `${cron} UTC`;
}

/** When it runs: a cron, or a one-off's time. */
function scheduleOf(automation: AutomationInfo): string {
  if (automation.cron !== null) return cronInWords(automation.cron);

  const at = new Date(automation.at ?? 0).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return `Once, ${at}`;
}

/** Paused, or when it runs next. */
function nextOf(automation: AutomationInfo, now: number): string {
  if (automation.status === "paused") return "Paused";

  if (automation.next_run === null) return "Nothing booked";
  const wait = ago(now, automation.next_run);

  return wait === "now" ? "Runs now" : `Next in ${wait}`;
}

/** The details worth a line only when they differ from the usual. */
const META: ((automation: AutomationInfo) => string | null)[] = [
  (automation) => (automation.created_by === "ky" ? "Made by ky" : null),
  (automation) =>
    automation.chat_label === "main" ? null : `to ${automation.chat_label}`,
  (automation) => automation.model?.modelId ?? null,
  (automation) => (automation.machine ? `on ${automation.machine}` : null),
];

/** Only what differs from the usual: ky made it, it reports elsewhere, its own model, a machine. */
function metaOf(automation: AutomationInfo): string[] {
  return META.flatMap((detail) => detail(automation) ?? []);
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
}>({
  automations: [],
  providers: [],
  machines: [],
  chats: [],
  onAction: () => {},
  onSave: async () => undefined,
});

/** The editor open in the list: a new automation, one by id, or none. */
const NEW = "new";

// Scheduled work, active and paused: add, edit, run now, pause, resume, archive and delete.
export function Automations({ now }: { now: number }) {
  const { automations } = useContext(AutomationsContext);
  const [editing, setEditing] = useState<string | null>(null);
  const close = () => setEditing(null);

  return (
    <section className="feed-group automations">
      <h3 className="feed-head">
        Automations
        <button
          type="button"
          className="feed-action pressable"
          onClick={() => setEditing(NEW)}
        >
          <Icon name="plus" size={12} />
          New
        </button>
      </h3>
      <ul className="feed">
        {editing === NEW && <AutomationForm onClose={close} />}
        {automations.map((automation) =>
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
              onEdit={() => setEditing(automation.id)}
            />
          ),
        )}
      </ul>
      {automations.length === 0 && editing === null && (
        <p className="panel-note">Nothing scheduled. Add one, or ask ky.</p>
      )}
    </section>
  );
}

/** The last run's status and summary, or null before the first run. */
function lastOf(automation: AutomationInfo): string | null {
  const last = automation.last_run;

  if (!last) return null;

  return last.summary
    ? `Last run ${last.status}: ${last.summary}`
    : `Last run ${last.status}`;
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
  onEdit: () => void;
};

// The row opens its editor; run and pause sit on top of it, shown on hover.
function AutomationItem({ automation, now, onEdit }: ItemProps) {
  const state = STATES[automation.status === "paused" ? "paused" : "active"];
  const last = lastOf(automation);

  return (
    <li className="feed-item automation" aria-label={automation.title}>
      <button
        type="button"
        className="feed-button"
        aria-label={`Edit ${automation.title}`}
        onClick={onEdit}
      >
        <span className="feed-tile" data-tone={state.tone}>
          <Icon name="clock" size={16} />
        </span>
        <span className="feed-text">
          <span className="feed-title">{automation.title}</span>
          <span className="feed-step tabular">
            {scheduleOf(automation)} · {nextOf(automation, now)}
          </span>
          {last && <span className="feed-summary">{last}</span>}
          <Tokens automation={automation} />
        </span>
      </button>
      <AutomationActions id={automation.id} state={state} />
    </li>
  );
}

/** Its own model, machine or chat, as small tokens apart from the words. */
function Tokens({ automation }: { automation: AutomationInfo }) {
  const tokens = metaOf(automation);

  if (tokens.length === 0) return null;

  return (
    <span className="automation-tokens">
      {tokens.map((token) => (
        <span key={token} className="token">
          {token}
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
  /** provider/modelId, or empty for the subagents model. */
  model: string;
  thinking: string;
  /** A machine's name, or empty for the cloud. */
  machine: string;
  chat: string;
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
};

/** Epoch ms as a datetime-local input's value, in local time. */
function localInput(ms: number): string {
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function modelFields(
  model: SlotSetting | null,
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
    ...timingFields(automation),
    ...modelFields(automation.model),
  };
}

type ModelChoice = {
  value: string;
  label: string;
  levels: readonly ModelThinkingLevel[];
};

/** Every model a connected provider offers, as `provider/modelId`. */
function modelChoices(providers: readonly ProviderInfo[]): ModelChoice[] {
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

function settingOf(
  form: Form,
  choices: readonly ModelChoice[],
): SlotSetting | null {
  const choice = choices.find((each) => each.value === form.model);

  if (!choice) return null;
  const [provider = "", ...rest] = choice.value.split("/");

  return {
    provider,
    modelId: rest.join("/"),
    thinkingLevel: levelOf(form.thinking, choice.levels),
  };
}

function draftOf(form: Form, choices: readonly ModelChoice[]): AutomationDraft {
  const timing = form.repeat
    ? { cron: form.cron.trim(), at: null }
    : { cron: null, at: new Date(form.at).getTime() };

  return {
    title: form.title.trim(),
    prompt: form.prompt.trim(),
    ...timing,
    model: settingOf(form, choices),
    machine: form.machine || null,
    chat: form.chat,
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
        <span className="row-sub">{cronInWords(form.cron.trim())}</span>
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
function Pick({
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
  const choices = modelChoices(useContext(AutomationsContext).providers);
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
