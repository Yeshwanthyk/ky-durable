import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { SENDING } from "../outbox";
import { flushSync } from "react-dom";
import { Attachments } from "./Attachments";
import { BotAvatar } from "./BotAvatar";
import { Changes } from "./Changes";
import { CopyButton } from "./CopyButton";
import { useLightbox } from "./Lightbox";
import type { Item, Tool, Turn } from "./conversation";
import { duration } from "./duration";
import { Icon, Spinner } from "./Icon";
import { Markdown } from "./Markdown";
import { ExploreGroup, Reveal, ToolRow } from "./ToolRow";

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
  // The first message of a new chat rises in where the welcome screen was, rather than swapping
  // in; opening a chat that already has a turn shows it at once.
  const [arrived] = useState(() => turns.length === 1 && turns[0] !== undefined && fresh(turns[0]));

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
          arrived={arrived}
        />
      ))}
    </>
  );
}

// A turn that is still running, or started moments ago, was just sent.
function fresh(turn: Turn) {
  return turn.state === "streaming" || turn.startedAt === null || Date.now() - Date.parse(turn.startedAt) < 10_000;
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
        <Reveal open={open}>
          <div className="tool-body">
            <pre>{text}</pre>
          </div>
        </Reveal>
      </div>
      {task ? <Attachments task={task} /> : null}
      {task ? <Changes task={task} /> : null}
    </>
  );
}

function UserBubble({ text }: { text: string }) {
  const long = text.split("\n").length > 8 || text.length > 700;
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

// The answer is the turn's last text; everything before it is the work log. While the turn
// streams, its last text is the answer from its first token, so the reply does not restyle when the
// turn ends; once a tool call or thinking follows it, it was commentary and joins the log.
function split(items: ReadonlyArray<Item>, streaming: boolean) {
  const last = items.findLastIndex((item) => item.kind === "text");
  const answer = items[last];
  const followed = items.slice(last + 1).some((item) => item.kind === "tool" || item.kind === "thinking");

  if (answer?.kind === "text" && (answer.final || !streaming || !followed))
    return { log: items.filter((_, index) => index !== last), answer: answer.text };

  return { log: items, answer: "" };
}

function useNow(live: boolean, every = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), every);

    return () => clearInterval(timer);
  }, [live, every]);

  return now;
}

// Memoised: buildTurns keeps a finished turn's identity, so only the streaming turn renders per token.
const TurnView = memo(function TurnView({ turn, mode, arrived }: { turn: Turn; mode: ThreadMode; arrived: boolean }) {
  // A streaming turn nothing is working on was cut off; it must not look live. While booting, one
  // that already has output is left from before the restart.
  const cutOff = mode === "dormant" || (mode === "booting" && turn.items.length > 0);
  const state = turn.state === "streaming" && cutOff ? "aborted" : turn.state;
  const live = state === "streaming";
  const now = useNow(live && mode === "live");
  // Specialists' replies are their own messages, under ky's part of the turn.
  const replies = turn.items.filter((item): item is Reply => item.kind === "specialist");
  const waiting = turn.to.filter((id) => !replies.some((reply) => reply.from === id));
  const { log, answer } = split(turn.items.filter((item) => item.kind !== "specialist"), live);
  const [open, setOpen] = useState(false);
  const started = turn.startedAt === null ? undefined : Date.parse(turn.startedAt);
  // A cut-off turn has no end time, so it has no duration either.
  const ended = turn.endedAt !== null ? Date.parse(turn.endedAt) : live ? now : undefined;
  const took = started === undefined || ended === undefined ? undefined : duration(ended - started);
  const errors = log.filter((item) => item.kind === "notice" && item.tone === "error");
  const steps = log.filter((item) => item.kind === "tool").length;

  // One layout for live and finished, so the work log and the answer keep their elements when the
  // turn ends: the log folds away behind "Worked" and the answer stays put.
  return (
    <article className="turn" data-arrived={arrived} data-sending={turn.id.startsWith(SENDING) || undefined}>
      <UserMessage text={turn.user} images={turn.images} from={turn.from} task={turn.task} />
      <div className="assistant">
        {live && mode === "booting" ? null : (
          <>
            {!live && log.length > 0 ? (
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
            ) : null}
            {log.length > 0 ? (
              <Reveal open={live || open}>
                <WorkLog items={live ? log : log.filter((item) => !errors.includes(item))} live={live} />
              </Reveal>
            ) : null}
            {live
              ? null
              : errors.map((item) =>
                  item.kind === "notice" ? <Notice key={item.id} text={item.text} tone="error" /> : null,
                )}
            {answer ? (
              <div className="answer">
                <Markdown source={answer} />
              </div>
            ) : null}
            {live ? (
              <div className="live">
                <Spinner size={13} />
                <span className="shimmer">Working</span>
                {took ? <span className="quiet tabular">{took}</span> : null}
              </div>
            ) : (
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
                    <CopyButton text={answer} label="Copy answer" />
                  </span>
                ) : null}
              </div>
            )}
          </>
        )}
      </div>
      {replies.map((reply) => (
        <SpecialistReply key={reply.id} reply={reply} />
      ))}
      {waiting.map((id) => (
        <SpecialistWaiting key={id} id={id} />
      ))}
    </article>
  );
});

type Reply = Extract<Item, { kind: "specialist" }>;

// Who wrote a specialist's message: its blob and @id, as a chat shows a member.
function Speaker({ id, active = false, children }: { id: string; active?: boolean; children?: ReactNode }) {
  return (
    <div className="specialist-head">
      <BotAvatar name={`@${id}`} identity={id} still={!active} active={active} size={22} />
      <span className="specialist-name">@{id}</span>
      {children}
    </div>
  );
}

function SpecialistReply({ reply }: { reply: Reply }) {
  return (
    <section className="specialist-reply" aria-label={`@${reply.from} replied`} data-failed={reply.failed}>
      <Speaker id={reply.from}>
        {reply.failed ? null : (
          <span className="answer-actions">
            <CopyButton text={reply.text} label={`Copy @${reply.from}'s reply`} />
          </span>
        )}
      </Speaker>
      {reply.failed ? (
        <p className="specialist-failed">{reply.text}</p>
      ) : (
        <div className="answer">
          <Markdown source={reply.text} />
        </div>
      )}
    </section>
  );
}

function SpecialistWaiting({ id }: { id: string }) {
  return (
    <section className="specialist-reply" aria-label={`@${id} is replying`} data-waiting="true">
      <Speaker id={id} active />
      <span className="shimmer">Replying</span>
    </section>
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
    case "notice":
      return <Notice text={item.text} tone={item.tone} />;
    case "specialist":
      return null;
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
