import { type MouseEvent, useContext, useState } from "react";
import type { AutomationInfo, RunInfo, TaskRow } from "../protocol";
import { byNextRun } from "./automation-order";
import { AutomationForm, AutomationsContext, scheduleOf, useZone } from "./Automations";
import { Switch } from "./Controls";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { MAIN_SESSION } from "./open-chat";
import { plain } from "./plain";
import { clock } from "./time";

/** The Routines page's open row for a routine not made yet. */
const NEW_ROUTINE = "new";

/** How many runs a row's strip shows, oldest on the left. */
const STRIP = 14;

const live = (run: RunInfo | undefined) => run?.status === "queued" || run?.status === "working";

const WORD = { queued: "Starting", working: "Running", done: "Succeeded", failed: "Failed", stopped: "Stopped" } as const;

/** A wait as people say it: "under a minute", "14 min", "2 h 14 min", "3 d 9 h". */
function waitOf(ms: number): string {
  const minutes = Math.round(ms / 60_000);

  if (minutes < 1) return "under a minute";

  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);

  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;

  return hours % 24 === 0 ? `${Math.floor(hours / 24)} d` : `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** How long a run took, as people say it: "41 s", "3 min", "1 h 5 min". */
function lengthOf(ms: number): string {
  const seconds = Math.round(ms / 1000);

  if (seconds < 1) return "under a second";

  if (seconds < 60) return `${seconds} s`;

  return waitOf(ms);
}

/** When something happened, near now: "today 9:00 am", "yesterday 9:00 am", "Fri 9:00 am", "Fri 16 Oct, 9:00 am". */
function whenOf(at: number, now: number): string {
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);

  if (days <= 0) return `today ${clock(at)}`;

  if (days === 1) return `yesterday ${clock(at)}`;
  const date = new Date(at);

  if (days < 7) return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${clock(at)}`;

  return `${date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${clock(at)}`;
}

const startOf = (run: RunInfo) => run.started_at ?? run.created_at;

/** A cost in dollars: to the cent, or to a tenth of one below a cent. */
function costOf(usd: number): string {
  if (usd < 0.001) return "under $0.001";

  return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/** The model a routine runs on, as its picker names it. */
const modelOf = (automation: AutomationInfo) => automation.model?.modelId ?? "Worker model";

/** What a row says under its title: when it runs, then when next, paused, or the step a live run is on. */
function stateOf(automation: AutomationInfo, task: TaskRow | undefined, now: number): string[] {
  if (live(automation.runs[0])) {
    const step = task?.steps.at(-1)?.text;

    return step ? ["Running", step] : ["Running"];
  }

  if (automation.status === "paused") return ["Paused"];

  if (automation.next_run === null) return [];

  return [`Next run in ${waitOf(Math.max(0, automation.next_run - now))}`];
}

/** The row's last word on how it went: the newest run that ended, and when. */
function LastLine({ automation, now }: { automation: AutomationInfo; now: number }) {
  const ended = automation.runs.find((run) => !live(run));

  if (!ended) return <span className="rt-last">{live(automation.runs[0]) ? "First run" : "No runs yet"}</span>;

  return (
    <span className="rt-last" data-status={ended.status}>
      <Icon name={ended.status === "done" ? "checkCircle" : ended.status === "failed" ? "alert" : "stop"} size={14} />
      Last run {whenOf(startOf(ended), now)}
    </span>
  );
}

/** One bar per recent run, oldest on the left, padded with empty ones; an open row's bars pick the run it shows. */
function Strip({
  runs,
  picked,
  now,
  onPick,
}: {
  runs: readonly RunInfo[];
  picked: string | undefined;
  now: number;
  onPick: ((id: string) => void) | null;
}) {
  const shown = runs.slice(0, STRIP).toReversed();
  const empty = Array.from({ length: STRIP - shown.length }, (_, index) => index);

  return (
    <div className="rt-strip" role={onPick ? "listbox" : undefined} aria-label="Recent runs">
      {empty.map((index) => (
        <span key={`empty-${index}`} className="rt-bar" data-status="none" aria-hidden />
      ))}
      {shown.map((run) => {
        const label = `${WORD[run.status]} ${whenOf(startOf(run), now)}`;

        return onPick ? (
          <button
            key={run.id}
            type="button"
            role="option"
            aria-selected={run.id === picked}
            aria-label={label}
            title={label}
            className="rt-bar"
            data-status={run.status}
            onClick={() => onPick(run.id)}
          />
        ) : (
          <span key={run.id} className="rt-bar" data-status={run.status} title={label} aria-hidden />
        );
      })}
    </div>
  );
}

/** Where a run happens and where it reports: "☁ The cloud → 💬 Main chat". */
function Places({ automation }: { automation: AutomationInfo }) {
  const chat = automation.chat === MAIN_SESSION ? "Main chat" : plain(automation.chat_label);

  return (
    <span className="rt-places">
      <Icon name={automation.machine === null ? "cloud" : "monitor"} size={13} />
      {automation.machine ?? "The cloud"}
      <Icon name="chevronRight" size={12} />
      <Icon name="chat" size={13} />
      {chat}
    </span>
  );
}

/** A run, opened: how it went and its facts on one line, the steps it took, then what it came to. */
function RunDetail({ automation, run, newest, task, now }: { automation: AutomationInfo; run: RunInfo; newest: boolean; task: TaskRow | undefined; now: number }) {
  const going = live(run);
  const steps = task?.steps ?? [];
  const took = run.started_at === null ? null : (run.finished_at ?? now) - run.started_at;

  const facts = [
    whenOf(startOf(run), now),
    took === null ? null : lengthOf(took),
    modelOf(automation),
    run.cost_usd === null || run.cost_usd === 0 ? null : costOf(run.cost_usd),
  ].filter((fact) => fact !== null);

  return (
    <section className="rt-section" aria-label={newest ? "Latest run" : "Run"}>
      <header className="rt-section-head">
        <h3>{newest ? "Latest run" : "Run"}</h3>
        {going ? (
          <span className="rt-facts tabular">{steps.length > 0 ? `Step ${steps.length}` : "Starting"}</span>
        ) : (
          <span className="rt-facts tabular" data-status={run.status}>
            <Icon name={run.status === "done" ? "checkCircle" : run.status === "failed" ? "alert" : "stop"} size={14} />
            <strong>{WORD[run.status]}</strong>
            {facts.join(" · ")}
          </span>
        )}
      </header>
      {steps.length > 0 && (going || !run.summary || run.status === "stopped") ? (
        <ol className="rt-steps">
          {steps.map((step, index) => {
            // The last step is the one a live run is on, or the one a stopped or failed run ended in.
            const state = index < steps.length - 1 || run.status === "done" ? "done" : going ? "running" : run.status;

            return (
              <li key={`${step.at}-${index}`} data-state={state}>
                {state === "running" ? (
                  <span className="rt-step-dot" aria-hidden />
                ) : (
                  <Icon name={state === "done" ? "check" : state === "failed" ? "alert" : "stop"} size={14} />
                )}
                {step.text}
              </li>
            );
          })}
        </ol>
      ) : null}
      {!going && run.summary && run.status !== "stopped" ? (
        <div className="rt-summary">
          <Markdown source={run.summary} />
        </div>
      ) : null}
    </section>
  );
}

type RowProps = {
  automation: AutomationInfo;
  open: boolean;
  tasks: readonly TaskRow[];
  now: number;
  onOpen: (open: boolean) => void;
};

// A routine: a quiet row of what it is, when it runs and how its runs went; open, it shows the latest run, its
// instructions and its schedule, with Edit for the form.
function RoutineRow({ automation, open, tasks, now, onOpen }: RowProps) {
  const { onAction } = useContext(AutomationsContext);
  const [picked, setPicked] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);
  const on = automation.status === "active";
  const going = live(automation.runs[0]);
  const taskOf = (run: RunInfo | undefined) => (run ? tasks.find((row) => row.id === run.id) : undefined);
  const run = automation.runs.find((each) => each.id === picked) ?? automation.runs[0];
  const body = `routine-${automation.id}`;

  // A click on the row opens it; one on a control inside it is the control's.
  const onRow = (event: MouseEvent) => {
    if (open || (event.target instanceof Element && event.target.closest("button, a, input, textarea, select, [role=listbox]"))) return;
    onOpen(true);
  };

  return (
    <li className="rt-row" data-open={open || undefined} data-paused={automation.status === "paused" || undefined} data-live={going || undefined} aria-label={automation.title} onClick={onRow}>
      <div className="rt-head">
        <button type="button" className="rt-title" aria-expanded={open} aria-controls={body} onClick={() => onOpen(!open)}>
          <span>{automation.title}</span>
          <Icon name="chevronDown" size={14} />
        </button>
        <div className="rt-actions">
          {going ? (
            <button type="button" className="rt-run pressable" onClick={() => onAction(automation.id, "stop")}>
              <Icon name="stop" size={13} />
              Stop
            </button>
          ) : on ? (
            <button type="button" className="rt-run pressable" onClick={() => onAction(automation.id, "run")}>
              <Icon name="play" size={13} />
              Run now
            </button>
          ) : null}
          <Switch on={on} label={on ? `Pause ${automation.title}` : `Resume ${automation.title}`} onFlip={() => onAction(automation.id, on ? "pause" : "resume")} />
        </div>
        <p className="rt-meta">{[scheduleOf(automation), ...stateOf(automation, taskOf(automation.runs[0]), now)].join(" · ")}</p>
        <LastLine automation={automation} now={now} />
        <Places automation={automation} />
        {automation.runs.length > 0 ? <Strip runs={automation.runs} picked={open ? run?.id : undefined} now={now} onPick={open ? setPicked : null} /> : null}
      </div>
      <div className="rt-progress" aria-hidden />
      {open ? (
        <div className="rt-body" id={body}>
          {editing ? (
            <AutomationForm
              automation={automation}
              zone={automation.zone}
              now={now}
              onClose={() => setEditing(false)}
              onSaved={() => setEditing(false)}
              page
            />
          ) : (
            <>
              {run ? (
                <RunDetail automation={automation} run={run} newest={run.id === automation.runs[0]?.id} task={taskOf(run)} now={now} />
              ) : (
                <p className="rt-quiet">No runs yet. Run now tries it.</p>
              )}
              <section className="rt-section" aria-label="Instructions">
                <h3>Instructions</h3>
                <p className="rt-prose">{automation.prompt}</p>
              </section>
              <section className="rt-section" aria-label="Schedule">
                <h3>Schedule</h3>
                <p className="rt-quiet">
                  {scheduleOf(automation)} · {automation.zone}
                  {automation.cron !== null ? (
                    <>
                      {" · Cron "}
                      <code>{automation.cron}</code>
                    </>
                  ) : null}
                </p>
              </section>
              <div className="rt-foot">
                <button type="button" className="rt-run pressable" onClick={() => setEditing(true)}>
                  <Icon name="pencil" size={13} />
                  Edit
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

// Every routine on one page: a row each, opened in place, the way a chat opens from the sidebar.
export function RoutineList({
  open,
  tasks,
  now,
  onOpen,
  onChats,
}: {
  /** The open row's routine id, NEW_ROUTINE for the form, "" for none. */
  open: string;
  tasks: readonly TaskRow[];
  now: number;
  onOpen: (id: string) => void;
  onChats: () => void;
}) {
  const { automations } = useContext(AutomationsContext);
  const zone = useZone();
  const shown = byNextRun(automations.filter((automation) => automation.status === "active" || automation.status === "paused"));
  const on = shown.filter((automation) => automation.status === "active").length;
  const week = now - 7 * 86_400_000;
  const failed = shown.flatMap((automation) => automation.runs).filter((run) => run.status === "failed" && startOf(run) > week).length;

  return (
    <section className="stage artifacts rt-page" aria-label="Routines">
      <header className="artifacts-head rt-page-head">
        <button type="button" className="icon-button pressable drawer-toggle" aria-label="Chats" onClick={onChats}>
          <Icon name="menu" size={18} />
        </button>
        <div className="rt-page-title">
          <h1>Routines</h1>
          {shown.length > 0 ? (
            <p className="tabular">
              {on} of {shown.length} on schedule{failed > 0 ? ` · ${failed} failed this week` : ""}
            </p>
          ) : null}
        </div>
        <button type="button" className="rt-new pressable" onClick={() => onOpen(NEW_ROUTINE)}>
          <Icon name="plus" size={14} />
          New routine
        </button>
      </header>
      <div className="rt-scroll">
        <ul className="rt-list">
          {open === NEW_ROUTINE ? (
            <li className="rt-row rt-row-new" data-open aria-label="New routine">
              <AutomationForm zone={zone} now={now} onClose={() => onOpen("")} />
            </li>
          ) : null}
          {shown.map((automation) => (
            <RoutineRow
              key={automation.id}
              automation={automation}
              open={open === automation.id}
              tasks={tasks}
              now={now}
              onOpen={(next) => onOpen(next ? automation.id : "")}
            />
          ))}
        </ul>
        {shown.length === 0 && open !== NEW_ROUTINE ? (
          <div className="rt-empty">
            <p>No routines yet</p>
            <p className="rt-quiet">Ask ky to do something on a schedule, or add one here.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
