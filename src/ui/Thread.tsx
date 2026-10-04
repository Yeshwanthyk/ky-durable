import { useEffect, useState } from "react";
import { Attachments } from "./Attachments";
import { useLightbox } from "./Lightbox";
import type { Item, Tool, Turn } from "./conversation";
import { duration } from "./duration";
import { Icon, Spinner } from "./Icon";
import { Markdown } from "./Markdown";
import { ExploreGroup, ToolRow } from "./ToolRow";

// The last few turns stay open; older ones fold behind one button, as in pecan.
const openTurns = 3;

// How the last turn shows while it streams. "live": the agent is working on it. "booting": the
// session is still starting, so it shows only its prompt. "dormant": nothing is working on it, so
// it was cut off. Any earlier streaming turn was cut off by a crash or a stop, whatever the mode.
export type ThreadMode = "live" | "booting" | "dormant";

export function Thread({
  turns,
  mode = "live",
}: {
  turns: ReadonlyArray<Turn>;
  mode?: ThreadMode;
}) {
  const [showAll, setShowAll] = useState(false);
  const hidden = showAll ? 0 : Math.max(0, turns.length - openTurns);
  return (
    <>
      {hidden > 0 ? (
        <button type="button" className="earlier pressable" onClick={() => setShowAll(true)}>
          <Icon name="chevronDown" size={14} />
          <span>
            {hidden} earlier {hidden === 1 ? "turn" : "turns"}
          </span>
        </button>
      ) : null}
      {turns.slice(hidden).map((turn, index, shown) => (
        <TurnView
          key={turn.id}
          turn={turn}
          mode={index === shown.length - 1 ? mode : "dormant"}
        />
      ))}
    </>
  );
}

function UserMessage({
  text,
  images,
  from,
  task,
}: {
  text: string;
  images: readonly string[];
  from: string | null;
  task: string | null;
}) {
  const open = useLightbox();

  if (from !== null) return <Report text={text} from={from} task={task} />;
  const media = images.map((src, index) => ({ src, label: `Image ${index + 1} you sent` }));

  return (
    <>
      {images.length > 0 ? (
        <div className="user-images">
          {media.map((item, index) => (
            <button key={index} type="button" className="attachment-open" aria-label={`Open ${item.label}`} onClick={() => open(media, index)}>
              <img src={item.src} alt={item.label} loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}
      {text ? <UserBubble text={text} /> : null}
    </>
  );
}

// A subagent's or machine's report arrives as input; it reads as a note, not as the user.
function Report({ text, from, task }: { text: string; from: string; task: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="tool">
        <button
          type="button"
          className="tool-row"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="nodes" size={14} />
          <span className="verb">Report from</span>
          <span className="target">{from}</span>
          <span className="trail">
            <Icon name="chevronRight" size={12} className="chevron" />
          </span>
        </button>
        {open ? (
          <div className="tool-body">
            <pre>{text}</pre>
          </div>
        ) : null}
      </div>
      {task ? <Attachments task={task} /> : null}
    </>
  );
}

function UserBubble({ text }: { text: string }) {
  const long = text.split("\n").length > 8 || text.length > 700;
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="user-message" data-clamped={long && !open}>
        {text}
      </div>
      {long ? (
        <button type="button" className="more-lines" onClick={() => setOpen((value) => !value)}>
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}

// The answer is the turn's last final message; everything before it is the work log.
function split(turn: Turn) {
  const last = turn.items.findLastIndex((item) => item.kind === "text");
  const answer = turn.items[last];
  if (answer?.kind === "text" && (answer.final || turn.state !== "streaming"))
    return { log: turn.items.filter((_, index) => index !== last), answer: answer.text };
  return { log: turn.items, answer: turn.items.length === 0 ? turn.assistant : "" };
}

export function useNow(live: boolean, every = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [live, every]);
  return now;
}

function TurnView({ turn, mode }: { turn: Turn; mode: ThreadMode }) {
  // A streaming turn nothing is working on was cut off; it must not look live. While booting, one
  // that already has output is left from before the restart.
  const cutOff =
    mode === "dormant" || (mode === "booting" && (turn.items.length > 0 || turn.assistant !== ""));
  const state = turn.state === "streaming" && cutOff ? "aborted" : turn.state;
  const live = state === "streaming";
  const now = useNow(live && mode === "live");
  const { log, answer } = split(turn);
  const [open, setOpen] = useState(false);
  const started = turn.startedAt === null ? undefined : Date.parse(turn.startedAt);
  // A cut-off turn has no end time, so it has no duration either.
  const ended = turn.endedAt !== null ? Date.parse(turn.endedAt) : live ? now : undefined;
  const took = started === undefined || ended === undefined ? undefined : duration(ended - started);
  const errors = log.filter((item) => item.kind === "notice" && item.tone === "error");
  const steps = log.filter((item) => item.kind === "tool").length;
  const [copied, setCopied] = useState(false);
  return (
    <article className="turn">
      <UserMessage text={turn.user} images={turn.images} from={turn.from} task={turn.task} />
      <div className="assistant">
        {live && mode === "booting" ? null : live ? (
          <>
            <WorkLog items={log} live />
            {answer ? <Markdown source={answer} /> : null}
            <div className="live">
              <Spinner size={13} />
              <span className="shimmer">Working</span>
              {took ? <span className="quiet tabular">{took}</span> : null}
            </div>
          </>
        ) : (
          <>
            {log.length > 0 ? (
              <>
                <button
                  type="button"
                  className="worked"
                  aria-expanded={open}
                  onClick={() => setOpen((value) => !value)}
                >
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
                {open ? <WorkLog items={log.filter((item) => !errors.includes(item))} /> : null}
              </>
            ) : null}
            {errors.map((item) =>
              item.kind === "notice" ? (
                <Notice key={item.id} text={item.text} tone="error" />
              ) : null,
            )}
            {answer ? (
              <div className="answer">
                <Markdown source={answer} />
              </div>
            ) : null}
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
              {answer ? (
                <span className="answer-actions">
                  <button
                    type="button"
                    className="icon-button pressable"
                    aria-label="Copy answer"
                    onClick={() =>
                      void navigator.clipboard.writeText(answer).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1200);
                      })
                    }
                  >
                    <Icon name={copied ? "check" : "copy"} size={14} />
                  </button>
                </span>
              ) : null}
            </div>
          </>
        )}
      </div>
    </article>
  );
}

type Entry = { kind: "explore"; id: string; tools: Tool[] } | { kind: "item"; item: Item };

// Runs of two or more read-only tools collapse into one explore line.
function entries(items: ReadonlyArray<Item>): Entry[] {
  const out: Entry[] = [];
  for (const item of items) {
    const previous = out.at(-1);
    if (item.kind === "tool" && item.category === "inspect" && item.status !== "failed") {
      if (previous?.kind === "explore") previous.tools.push(item);
      else out.push({ kind: "explore", id: item.id, tools: [item] });
    } else out.push({ kind: "item", item });
  }
  return out.map((entry) =>
    entry.kind === "explore" && entry.tools.length === 1 && entry.tools[0] !== undefined
      ? { kind: "item", item: entry.tools[0] }
      : entry,
  );
}

function WorkLog({ items, live = false }: { items: ReadonlyArray<Item>; live?: boolean }) {
  return (
    <div className="worklog" data-live={live}>
      {entries(items).map((entry) =>
        entry.kind === "explore" ? (
          <ExploreGroup key={entry.id} tools={entry.tools} />
        ) : (
          <LogItem key={entry.item.id} item={entry.item} />
        ),
      )}
    </div>
  );
}

function LogItem({ item }: { item: Item }) {
  switch (item.kind) {
    case "tool":
      return <ToolRow tool={item} />;
    case "text":
      return item.text ? (
        <div className="log-text">
          <Markdown source={item.text} />
        </div>
      ) : null;
    case "thinking":
      return item.text ? <Thought text={item.text} /> : null;
    case "plan":
      return <Plan steps={item.steps} />;
    case "notice":
      return <Notice text={item.text} tone={item.tone} />;
  }
}

// Codex reasoning summaries open with a bold title; it reads as the thought's heading.
function Thought({ text }: { text: string }) {
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

function Plan({ steps }: { steps: ReadonlyArray<{ step: string; status: string }> }) {
  const done = steps.filter((step) => step.status === "completed").length;
  return (
    <div className="plan">
      <div className="plan-head">
        <span>Plan</span>
        <span className="tabular">
          {done}/{steps.length}
        </span>
      </div>
      {steps.map((step, index) => (
        <div className="plan-step" data-status={step.status} key={index}>
          {step.status === "completed" ? (
            <Icon name="check" size={13} />
          ) : step.status === "inProgress" ? (
            <Spinner size={12} />
          ) : (
            <Icon name="circle" size={13} />
          )}
          <span>{step.step}</span>
        </div>
      ))}
    </div>
  );
}

function Notice({ text, tone }: { text: string; tone: "info" | "error" }) {
  return (
    <div className="notice" data-tone={tone}>
      <Icon
        name={tone === "error" ? "alert" : text.startsWith("Context") ? "compress" : "refresh"}
        size={13}
      />
      <span>{text}</span>
    </div>
  );
}
