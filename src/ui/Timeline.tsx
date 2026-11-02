import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import type { TaskLogStep, TaskRow } from "../protocol";
import { Icon } from "../chat-kit/Icon";
import { Markdown } from "./Markdown";
import { plain } from "./plain";
import { isLive, spendParts } from "./task-progress";
import { type TimelineEntry, type TimelineState, type TimelineStep, taskTimeline, titleParts } from "./timeline-steps";
import { Reveal } from "../chat-kit/Reveal";

// A task's steps as a live vertical timeline in a sheet: a quiet glyph per step, its title with the
// key result, the raw call behind a chevron, and the agent's own words between them as plain text.

/** Asks the server for a task's full log; a page with no connection gets none. */
export const TaskStepsContext = createContext<(task: string) => Promise<readonly TaskLogStep[]>>(() => Promise.resolve([]));

/** A task's log, asked for again each time its row changes: every step it takes and ends bumps it. */
function useTaskLog(task: TaskRow): readonly TaskLogStep[] | null {
  const load = useContext(TaskStepsContext);
  const [log, setLog] = useState<readonly TaskLogStep[] | null>(null);
  const version = `${task.id}:${task.updated_at}:${task.status}`;

  useEffect(() => {
    let current = true;
    load(task.id).then(
      (steps) => current && setLog(steps),
      () => undefined
    );

    return () => {
      current = false;
    };
    // The version says when the row changed; the id alone would ask once.
  }, [load, task.id, version]);

  return log;
}

// Outlined circles: a check when done, empty and pulsing while running, a cross when it failed.
function Glyph({ state }: { state: TimelineState }) {
  return (
    <svg className="timeline-glyph" data-state={state} width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
      <circle cx="10" cy="10" r="8.25" stroke="currentColor" strokeWidth="1.5" />
      {state === "done" ? <path d="M6.4 10.3l2.4 2.4 4.8-5.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> : null}
      {state === "failed" ? <path d="M7.4 7.4l5.2 5.2M12.6 7.4l-5.2 5.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /> : null}
      {state === "stopped" ? <path d="M7 10h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /> : null}
    </svg>
  );
}

// Six petals turning: the timeline's one sign that the work goes on.
function Flower() {
  return (
    <svg className="timeline-flower" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      {[0, 60, 120, 180, 240, 300].map((angle) => (
        <ellipse key={angle} cx="8" cy="4" rx="1.6" ry="3" fill="currentColor" transform={`rotate(${angle} 8 8)`} />
      ))}
    </svg>
  );
}

function Title({ title }: { title: string }) {
  return (
    <span className="timeline-title">
      {titleParts(title).map((piece, index) => (piece.code ? <code key={index}>{piece.text}</code> : <span key={index}>{piece.text}</span>))}
    </span>
  );
}

/** A step's title, as a button that opens its raw call when it has one; without one, it has no chevron. The glyph says how it stands. */
function StepRow({ step, opens, open, onToggle }: { step: TimelineStep; opens: boolean; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="timeline-row" aria-expanded={opens ? open : undefined} disabled={!opens} onClick={onToggle}>
      <span className="timeline-text">
        <Title title={step.title} />
      </span>
      <Icon name="chevronRight" size={14} className="timeline-chevron" />
    </button>
  );
}

/** What a step's tool was given and what came back, in mono. */
function StepRaw({ step, open }: { step: TimelineStep; open: boolean }) {
  return (
    <Reveal open={open}>
      <div className="timeline-raw">
        {[step.input, step.output].flatMap((text, index) => (text ? [<pre key={index}>{text}</pre>] : []))}
      </div>
    </Reveal>
  );
}

function Step({ step }: { step: TimelineStep }) {
  const [open, setOpen] = useState(false);
  const opens = step.input !== "" || step.output !== "";

  return (
    <li className="timeline-step" data-state={step.state}>
      <Glyph state={step.state} />
      <div className="timeline-main">
        <StepRow step={step} opens={opens} open={open} onToggle={() => setOpen((value) => !value)} />
        {opens ? <StepRaw step={step} open={open} /> : null}
      </div>
    </li>
  );
}

/** The agent's words between its steps: plain text, lined up with the step titles. */
function Note({ text }: { text: string }) {
  return (
    <li className="timeline-note">
      {titleParts(text).map((piece, index) => (piece.code ? <code key={index}>{piece.text}</code> : <span key={index}>{piece.text}</span>))}
    </li>
  );
}

/** Steps and notes as a timeline, newest last; while the work goes on and no step is running, a Thinking line under them. */
export function Timeline({ steps, working, empty = "No steps yet" }: { steps: readonly TimelineEntry[]; working: boolean; empty?: string }) {
  const newest = steps.at(-1);
  const thinking = working && !(newest?.kind === "step" && newest.state === "running");

  return (
    <>
      {steps.length > 0 ? (
        <ol className="timeline" aria-label="Steps">
          {steps.map((entry) => (entry.kind === "note" ? <Note key={entry.id} text={entry.text} /> : <Step key={entry.id} step={entry} />))}
        </ol>
      ) : working ? null : (
        <p className="timeline-empty">{empty}</p>
      )}
      {thinking ? (
        <div className="timeline-working" role="status">
          <Flower />
          <span className="shimmer">Thinking</span>
        </div>
      ) : null}
    </>
  );
}

/** A sheet over the page with a title, an X at the top right, and a timeline. It opens as it mounts. */
export function TimelineSheet({
  title,
  sub,
  tools,
  onClose,
  children
}: {
  title: string;
  sub?: string;
  tools?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="soul-sheet timeline-sheet"
      aria-label={title}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <header className="timeline-head">
        <div className="timeline-heading">
          <h2>{title}</h2>
          {sub ? <p>{sub}</p> : null}
        </div>
        {tools}
        <button type="button" className="timeline-close pressable" aria-label="Close" onClick={() => dialog.current?.close()}>
          <Icon name="x" size={16} />
        </button>
      </header>
      <div className="timeline-body" data-scroll>
        {children}
      </div>
    </dialog>
  );
}

const ENDED: Record<TaskRow["status"], string> = { queued: "Queued", working: "Working", done: "Done", failed: "Failed", stopped: "Stopped" };

const EMPTY: Partial<Record<TaskRow["status"], string>> = { queued: "Waiting to start" };

/** Who runs the task and how it stands; once it ends, what it spent. */
const taskLine = (task: TaskRow, now: number) => [task.worker, ENDED[task.status], ...(isLive(task) ? [] : spendParts(task, now))].join(" · ");

function OpenChat({ onOpen }: { onOpen?: () => void }) {
  if (!onOpen) return null;

  return (
    <button type="button" className="timeline-open pressable" onClick={onOpen}>
      Open chat
    </button>
  );
}

/** What a task reported once it ended. */
function TaskResult({ task }: { task: TaskRow }) {
  if (isLive(task) || !task.summary) return null;

  return (
    <div className="timeline-result" data-tone={task.status}>
      <Markdown source={task.summary} />
    </div>
  );
}

/** A task's timeline, live while it works; once it ends, what it reported under the steps. */
export function TaskTimeline({ task, now, onClose, onOpenChat }: { task: TaskRow; now: number; onClose: () => void; onOpenChat?: () => void }) {
  const steps = taskTimeline(task, useTaskLog(task));

  return (
    <TimelineSheet title={plain(task.title)} sub={taskLine(task, now)} onClose={onClose} tools={<OpenChat onOpen={onOpenChat} />}>
      <Timeline steps={steps} working={isLive(task)} empty={EMPTY[task.status] ?? "No steps recorded"} />
      <TaskResult task={task} />
    </TimelineSheet>
  );
}
