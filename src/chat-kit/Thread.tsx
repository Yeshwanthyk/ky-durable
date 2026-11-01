import { type ReactNode, useState, useRef } from "react";
import { flushSync } from "react-dom";
import { Icon } from "./Icon";
import { Reveal } from "./Reveal";

/**
 * The thread's shell: one turn, the user's bubble, ky's side of it (the work log folded behind "Worked", the answer,
 * the turn's end) and the working line while it runs. What fills them, such as Markdown, cards or an avatar, the host
 * passes in.
 */

/** How a finished turn ended. */
export type TurnState = "completed" | "aborted" | "failed";

/** One turn: the user's message, then the reply. A new chat's first turn rises in; one on its way can dim. */
export function ChatTurn({ arrived = false, sending = false, children }: { arrived?: boolean; sending?: boolean; children: ReactNode }) {
  return (
    <article className="turn" data-arrived={arrived} data-sending={sending || undefined}>
      {children}
    </article>
  );
}

/** Past eight lines or 700 characters, the bubble clamps behind "Show more". */
const isLong = (text: string) => text.split("\n").length > 8 || text.length > 700;

/** The user's words in a soft bubble, at the turn's right. */
export function UserBubble({ text }: { text: string }) {
  const long = isLong(text);
  const [open, setOpen] = useState(false);
  const bubble = useRef<HTMLDivElement>(null);

  // The clamp is a max-height, which cannot ease to "none"; so the bubble's height eases from what
  // it was to what it is now, clipped while it moves.
  const toggle = () => {
    const element = bubble.current;
    const from = element?.offsetHeight;

    flushSync(() => setOpen((value) => !value));

    if (!element || from === undefined || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = element.offsetHeight;

    element.animate(
      { height: [`${from}px`, `${to}px`], overflow: ["hidden", "hidden"] },
      { duration: to > from ? 220 : 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  };

  return (
    <>
      <div ref={bubble} className="user-message" data-clamped={long && !open}>
        {text}
      </div>
      {long ? (
        <button type="button" className="more-lines" onClick={toggle}>
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}

/** The reply's column: the work log, the answer and the turn's end, one under another. */
export function Assistant({ children }: { children: ReactNode }) {
  return <div className="assistant">{children}</div>;
}

/**
 * A finished turn's work, folded behind one line that reads what it took ("Worked for 12s · 3 steps"), which opens it
 * in place. While the turn runs the log stays open and the line isn't shown.
 */
export function WorkLog({
  live,
  state = "completed",
  took,
  steps,
  children
}: {
  live: boolean;
  state?: TurnState;
  /** How long the turn took, already worded; none, and the line says only what it did. */
  took?: string;
  steps: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {live ? null : (
        <button type="button" className="worked" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <span>
            {state === "completed" ? "Worked" : "Ran"}
            {took ? (
              <>
                {" for "}
                <b className="tabular">{took}</b>
              </>
            ) : null}
            {steps > 0 ? ` · ${steps} ${steps === 1 ? "step" : "steps"}` : null}
          </span>
          <Icon name="chevronRight" size={12} className="chevron" />
        </button>
      )}
      <Reveal open={live || open}>
        <div className="worklog" data-live={live}>
          {children}
        </div>
      </Reveal>
    </>
  );
}

/** Commentary in the work log, in its smaller grey type. */
export function LogText({ children }: { children: ReactNode }) {
  return <div className="log-text">{children}</div>;
}

/** A reasoning summary: one clamped line that opens on a tap. Codex's open with a bold title, read as its heading. */
export function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const match = /^\*\*(.+?)\*\*\s*/.exec(text);
  const title = match?.[1];
  const body = (match === null ? text : text.slice(match[0].length)).replace(/\*\*/g, "");

  return (
    <div
      className="log-thought"
      data-open={open}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") setOpen((value) => !value);
      }}
    >
      {title ? <b>{title}. </b> : null}
      {body}
    </div>
  );
}

/** A quiet line in the work, or an error in a red wash. */
export function Notice({ text, tone }: { text: string; tone: "info" | "error" }) {
  return (
    <div className="notice" data-tone={tone}>
      <Icon name={tone === "error" ? "alert" : text.startsWith("Context") ? "compress" : "refresh"} size={13} />
      <span>{text}</span>
    </div>
  );
}

/** The answer: the host's rendering of the reply's last text. */
export function Answer({ children }: { children: ReactNode }) {
  return <div className="answer">{children}</div>;
}

/** Actions on an answer, such as copy, shown when the pointer is on the turn. */
export function AnswerActions({ children }: { children: ReactNode }) {
  return <span className="answer-actions">{children}</span>;
}

/**
 * The working line while a turn runs: who is working (`avatar`), what they are doing ("Thinking", "Writing"), for how
 * long, and how many steps so far. With `onOpenSteps` it is a button that opens them.
 */
export function WorkingLine({
  avatar,
  phase,
  took,
  steps,
  onOpenSteps
}: {
  avatar: ReactNode;
  /** What the turn is doing; none while a tool's own row says so. */
  phase: string | null;
  took?: string;
  steps: number;
  onOpenSteps: (() => void) | null;
}) {
  return (
    <button type="button" className="live" disabled={onOpenSteps === null} aria-haspopup="dialog" onClick={onOpenSteps ?? undefined}>
      <span className="live-avatar" aria-hidden="true">
        {avatar}
      </span>
      {phase ? <span className="shimmer">{phase}</span> : null}
      {took ? <span className="quiet tabular">{took}</span> : null}
      {steps > 0 && onOpenSteps ? (
        <span className="quiet live-steps">
          {steps} {steps === 1 ? "step" : "steps"}
          <Icon name="chevronRight" size={11} />
        </span>
      ) : null}
    </button>
  );
}

/** Under a finished turn: whether it was interrupted or failed, then the host's actions on it. */
export function TurnEnd({ state, children }: { state: TurnState; children?: ReactNode }) {
  return (
    <div className="turn-end" data-state={state}>
      {state === "aborted" ? (
        <span className="interrupted">
          <Icon name="stop" size={9} /> Interrupted
        </span>
      ) : state === "failed" ? (
        <>
          <Icon name="alert" size={13} /> Turn failed
        </>
      ) : null}
      {children}
    </div>
  );
}
