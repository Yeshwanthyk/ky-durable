import { createContext, useContext } from "react";
import type { AutomationAction, AutomationInfo } from "../protocol";
import { Icon } from "./Icon";
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
function plainTime([, minute = "", hour, weekday = ""]: string[]): string | undefined {
  if (hour === "*") return weekday === "*" ? `Hourly at :${minute.padStart(2, "0")}` : undefined;
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
  (automation) => (automation.chat_label === "main" ? null : `to ${automation.chat_label}`),
  (automation) => automation.model?.modelId ?? null,
  (automation) => (automation.machine ? `on ${automation.machine}` : null),
];

/** Only what differs from the usual: ky made it, it reports elsewhere, its own model, a machine. */
function metaOf(automation: AutomationInfo): string[] {
  return META.flatMap((detail) => detail(automation) ?? []);
}

/** The automations, and what the user can do to one, provided around the panel. */
export const AutomationsContext = createContext<{
  automations: readonly AutomationInfo[];
  onAction: (automation: string, action: AutomationAction) => void;
}>({ automations: [], onAction: () => {} });

// Scheduled work, active and paused, with pause, resume and archive; ky does the editing.
export function Automations({ now }: { now: number }) {
  const { automations } = useContext(AutomationsContext);
  const shown = automations.filter((each) => each.status === "active" || each.status === "paused");

  if (shown.length === 0) return null;

  return (
    <section className="feed-group automations">
      <h3 className="feed-head">Automations</h3>
      <ul className="feed">
        {shown.map((automation) => (
          <AutomationItem key={automation.id} automation={automation} now={now} />
        ))}
      </ul>
    </section>
  );
}

/** The last run's status and summary, or null before the first run. */
function lastOf(automation: AutomationInfo): string | null {
  const last = automation.last_run;

  if (!last) return null;

  return last.summary ? `Last run ${last.status}: ${last.summary}` : `Last run ${last.status}`;
}

/** What the row shows and offers in each state it can be listed in. */
const STATES = {
  active: { tile: "refresh", tone: undefined, toggle: "Pause", action: "pause", icon: "pause" },
  paused: { tile: "pause", tone: "stopped", toggle: "Resume", action: "resume", icon: "play" },
} as const;

function AutomationItem({ automation, now }: { automation: AutomationInfo; now: number }) {
  const { onAction } = useContext(AutomationsContext);
  const state = STATES[automation.status === "paused" ? "paused" : "active"];
  const last = lastOf(automation);
  const meta = metaOf(automation).join(" · ");

  return (
    <li className="feed-item automation" aria-label={automation.title}>
      <span className="feed-tile" data-tone={state.tone}>
        <Icon name={state.tile} size={16} />
      </span>
      <span className="feed-text">
        <span className="feed-title">{automation.title}</span>
        <span className="feed-step">{scheduleOf(automation)}</span>
        <span className="feed-step tabular">{nextOf(automation, now)}</span>
        {last && <span className="feed-summary">{last}</span>}
        {meta && <span className="feed-meta">{meta}</span>}
      </span>
      <span className="automation-actions">
        <button
          type="button"
          className="icon-button pressable"
          aria-label={state.toggle}
          title={state.toggle}
          onClick={() => onAction(automation.id, state.action)}
        >
          <Icon name={state.icon} size={14} />
        </button>
        <button
          type="button"
          className="icon-button pressable"
          aria-label="Archive"
          title="Archive"
          onClick={() => onAction(automation.id, "archive")}
        >
          <Icon name="archive" size={14} />
        </button>
      </span>
    </li>
  );
}
