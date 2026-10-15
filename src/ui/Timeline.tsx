import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import type { TaskLogStep, TaskRow } from "../protocol";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { plain } from "./plain";
import { isLive, spendParts } from "./task-progress";
import { type TimelineState, type TimelineStep, taskTimeline, titleParts } from "./timeline-steps";
import { Reveal } from "./ToolRow";

// A task's steps as a live vertical timeline in a sheet: a glyph per step on a dotted line, its
// title with the key result, a dim line of what came back, and the raw call behind a chevron.

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

// Outlined circles: a check when done, empty and amber while running, a cross when it failed.
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

const DETAIL: Partial<Record<TimelineState, string>> = { running: "In progress", stopped: "Stopped before it finished" };

function Step({ step }: { step: TimelineStep }) {
  const [open, setOpen] = useState(false);
  const opens = step.input !== "" || step.output !== "";
  const detail = step.detail || DETAIL[step.state] || "";

  return (
    <li className="timeline-step" data-state={step.state}>
      <Glyph state={step.state} />
      <div className="timeline-main">
        <button type="button" className="timeline-row" aria-expanded={opens ? open : undefined} disabled={!opens} onClick={() => setOpen((value) => !value)}>
          <span className="timeline-text">
            <Title title={step.title} />
            {detail ? <span className="timeline-detail">{detail}</span> : null}
          </span>
          {opens ? <Icon name="chevronRight" size={14} className="timeline-chevron" /> : null}
        </button>
        {opens ? (
          <Reveal open={open}>
            <div className="timeline-raw">
              {step.input ? <pre>{step.input}</pre> : null}
              {step.output ? <pre>{step.output}</pre> : null}
            </div>
          </Reveal>
        ) : null}
      </div>
    </li>
  );
}

/** Steps as a timeline, newest last, with a Working line under them while the work goes on. */
export function Timeline({ steps, working, empty = "No steps yet" }: { steps: readonly TimelineStep[]; working: boolean; empty?: string }) {
  return (
    <>
      {steps.length > 0 ? (
        <ol className="timeline" aria-label="Steps">
          {steps.map((step) => (
            <Step key={step.id} step={step} />
          ))}
        </ol>
      ) : working ? null : (
        <p className="timeline-empty">{empty}</p>
      )}
      {working ? (
        <div className="timeline-working" role="status">
          <Flower />
          <span className="shimmer">Working</span>
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

/** A task's timeline, live while it works; once it ends, what it reported under the steps. */
export function TaskTimeline({ task, now, onClose, onOpenChat }: { task: TaskRow; now: number; onClose: () => void; onOpenChat?: () => void }) {
  const steps = taskTimeline(task, useTaskLog(task));
  const working = isLive(task);
  const sub = [task.worker, ENDED[task.status], ...(working ? [] : spendParts(task, now))].join(" · ");

  return (
    <TimelineSheet
      title={plain(task.title)}
      sub={sub}
      onClose={onClose}
      tools={
        onOpenChat ? (
          <button type="button" className="timeline-open pressable" onClick={onOpenChat}>
            Open chat
          </button>
        ) : undefined
      }
    >
      <Timeline steps={steps} working={working} empty={task.status === "queued" ? "Waiting to start" : "No steps recorded"} />
      {!working && task.summary ? (
        <div className="timeline-result" data-tone={task.status}>
          <Markdown source={task.summary} />
        </div>
      ) : null}
    </TimelineSheet>
  );
}
