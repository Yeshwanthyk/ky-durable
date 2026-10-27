import { createContext, Fragment, memo, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { SENDING } from "../outbox";
import { flushSync } from "react-dom";
import { Attachments } from "./Attachments";
import { KY_AVATAR } from "../avatars/contract";
import type { BlobVariantId } from "./blob-catalog";
import { BlockCard } from "./Blocks";
import { answeredWith, isQuestion } from "./card-answers";
import type { CardAnswer } from "../cards/contract";
import type { MediaClip } from "../files/media";
import { BotAvatar } from "./BotAvatar";
import { Changes } from "./Changes";
import { CopyButton } from "./CopyButton";
import { useLightbox } from "./Lightbox";
import type { Item, ReportFrom, Tool, Turn } from "./conversation";
import { duration } from "./duration";
import { eventsOf, type ThreadEvent } from "./events";
import { Icon } from "./Icon";
import { type Placement, placements, wrote } from "./living-cards";
import { Markdown } from "./Markdown";
import { SentClip } from "./Media";
import { firstNew, folded, type Mark, marks, type Visit } from "./thread-marks";
import { ExploreGroup, Reveal, ToolRow } from "./ToolRow";

/** Opens the running turn's steps as a timeline; a thread with nowhere to show them has none. */
export const OpenStepsContext = createContext<(() => void) | null>(null);

/** What turn-start recall gave the model for each of the chat's user messages, by message id. */
export const RecalledContext = createContext<Readonly<Record<string, readonly string[]>>>({});

/** What the user answered on ky's cards, by the ui call's id. */
export const AnswersContext = createContext<Readonly<Record<string, CardAnswer>>>({});

/** Where each of ky's cards lands in the turns shown (src/ui/living-cards.ts), and whether the last turn is live, which keeps every card from taking taps. */
const CardsContext = createContext<{ readonly placed: ReadonlyMap<string, Placement>; readonly busy: boolean }>({ placed: new Map(), busy: false });

/** Who answers in this chat, for the working row: ky's name and blob, or a subagent's name without one. */
export type Speaker = { readonly name: string; readonly variantId?: BlobVariantId };

export const SpeakerContext = createContext<Speaker>({ name: "ky" });

// The last few turns stay open; older ones fold behind one button, as in pecan.
const openTurns = 3;

// How the last turn shows while it streams. "live": the agent is working on it. "booting": the
// session is still starting, so it shows only its prompt. "dormant": nothing is working on it, so
// it was cut off. Any earlier streaming turn was cut off by a crash or a stop, whatever the mode.
export type ThreadMode = "live" | "booting" | "dormant";

export function Thread({
  turns,
  mode = "live",
  visit = null,
}: {
  turns: ReadonlyArray<Turn>;
  mode?: ThreadMode;
  /** When the user last saw this chat, for the New divider above what landed since. */
  visit?: Visit;
}) {
  const [showAll, setShowAll] = useState(false);
  const hidden = showAll ? 0 : folded(turns.length, openTurns, firstNew(turns, visit));
  const shownTurns = turns.slice(hidden);
  const above = marks(shownTurns, visit, Date.now());
  // The first message of a new chat rises in where the welcome screen was, rather than swapping
  // in; opening a chat that already has a turn shows it at once.
  const [arrived] = useState(() => turns.length === 1 && turns[0] !== undefined && fresh(turns[0]));
  const placed = useSamePlacements(shownTurns);
  const lastTurn = shownTurns.at(-1);
  const busy = lastTurn !== undefined && isLive(lastTurn, mode);
  const cards = useMemo(() => ({ placed, busy }), [placed, busy]);

  return (
    <CardsContext.Provider value={cards}>
      {hidden > 0 ? (
        <button type="button" className="earlier pressable" onClick={() => setShowAll(true)}>
          <Icon name="chevronDown" size={14} />
          <span>
            {hidden} earlier {hidden === 1 ? "turn" : "turns"}
          </span>
        </button>
      ) : null}
      {shownTurns.map((turn, index, shown) => (
        <Fragment key={turn.id}>
          <TurnMark mark={above[index]} />
          <TurnView
            turn={turn}
            mode={index === shown.length - 1 ? mode : "dormant"}
            arrived={arrived}
            next={wrote(shown[index + 1])}
          />
        </Fragment>
      ))}
    </CardsContext.Provider>
  );
}

/**
 * The turns' card placements, kept as the same map while they read the same, so a streamed token re-renders only its
 * own turn. A draft reads as what it holds, so the card grows as its call streams.
 */
function useSamePlacements(turns: readonly Turn[]): ReadonlyMap<string, Placement> {
  const placed = placements(turns);
  const key = [...placed].map(([call, each]) => (each.kind === "card" ? `${call}>${each.call}:${each.latest}${each.drafting ? JSON.stringify(each.ui) : ""}` : `${call}^`)).join(" ");
  const kept = useRef({ key, placed });

  if (kept.current.key !== key) kept.current = { key, placed };

  return kept.current.placed;
}

/**
 * Whether a turn is being worked on. A streaming turn nothing is working on was cut off and must not look live;
 * while booting, one that already has output is left from before the restart.
 */
function isLive(turn: Turn, mode: ThreadMode) {
  const cutOff = mode === "dormant" || (mode === "booting" && turn.items.length > 0);

  return turn.state === "streaming" && !cutOff;
}

/** The lasting changes a finished turn made, one quiet line each; a live turn shows them in its work. */
function TurnEvents({ items, live }: { items: readonly Item[]; live: boolean }) {
  const events: readonly ThreadEvent[] = live ? [] : eventsOf(items);

  return events.map((event) => (
    <p key={event.id} className="turn-event">
      <span className="quiet">{event.verb}</span>
      <Icon name={event.icon} size={13} />
      <span className="turn-event-name">{event.name}</span>
    </p>
  ));
}

/** A day stamp, a New divider, or both, above a turn. */
function TurnMark({ mark }: { mark: Mark | undefined }) {
  if (mark === undefined) return null;

  return (
    <>
      {mark.day === null ? null : <div className="day-stamp">{mark.day}</div>}
      {mark.isNew ? (
        <div className="new-divider" role="separator" aria-label="New since you last looked">
          <span>New</span>
        </div>
      ) : null}
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
  clips,
  from,
  task,
}: {
  text: string;
  images: readonly string[];
  clips: readonly MediaClip[];
  from: ReportFrom | null;
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
      {clips.length > 0 ? (
        <div className="user-clips">
          {clips.map((clip) => (
            <SentClip key={clip.file} clip={clip} />
          ))}
        </div>
      ) : null}
      {text ? <UserBubble text={text} /> : null}
    </>
  );
}

// What ky looked up before answering the message: "Recalled N" under it, and the lines when tapped.
function Recalled({ lines }: { lines: readonly string[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="recalled">
      <button type="button" className="recalled-chip" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="search" size={12} />
        <span>Recalled {lines.length}</span>
        <Icon name="chevronRight" size={12} className="chevron" />
      </button>
      <Reveal open={open}>
        <ul className="recalled-lines" aria-label="Recalled context">
          {lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      </Reveal>
    </div>
  );
}

// A report arrives as input; it reads as one quiet line, like a turn's events, and opens to what it said.
function Report({ text, from, task }: { text: string; from: ReportFrom; task: string | null }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="report">
        <button type="button" className="turn-event report-line" aria-expanded={open} disabled={text.trim() === ""} onClick={() => setOpen((value) => !value)}>
          <span className="quiet">{from.verb}</span>
          <Icon name={from.icon} size={13} />
          <span className="turn-event-name">{from.name}</span>
          {text.trim() === "" ? null : <Icon name="chevronRight" size={12} className="chevron" />}
        </button>
        <Reveal open={open}>
          <div className="report-body">
            <Markdown source={text} />
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
const TurnView = memo(function TurnView({
  turn,
  mode,
  arrived,
  next
}: {
  turn: Turn;
  mode: ThreadMode;
  arrived: boolean;
  /** The user's next message, which answers this turn's cards. */
  next: string | null;
}) {
  const live = isLive(turn, mode);
  const state = turn.state === "streaming" && !live ? "aborted" : turn.state;
  const now = useNow(live && mode === "live");
  // Specialists' replies are their own messages, under ky's part of the turn.
  const replies = turn.items.filter((item): item is Reply => item.kind === "specialist");
  const waiting = turn.to.filter((id) => !replies.some((reply) => reply.from === id));
  // Cards ky showed with the ui tool are part of its answer, not its work log; a living card's update is a quiet line.
  const { placed, busy } = useContext(CardsContext);

  const cards = turn.items.flatMap((item) => {
    const placement = placed.get(item.id);

    return placement === undefined ? [] : [{ id: item.id, placement }];
  });

  const answers = useContext(AnswersContext);
  // A card reads its answer from the record kept beside it; only a turn none of whose cards has one, from before
  // records, reads the next message's words back. A living card is newer than records, so it never does.
  const before = !cards.some(({ placement }) => placement.kind === "card" && answers[placement.call] !== undefined);
  const { log, answer } = split(turn.items.filter((item) => item.kind !== "specialist" && !(item.kind === "tool" && item.name === "ui")), live);
  const speaker = useContext(SpeakerContext);
  const [open, setOpen] = useState(false);
  const started = turn.startedAt === null ? undefined : Date.parse(turn.startedAt);
  // A cut-off turn has no end time, so it has no duration either.
  const ended = turn.endedAt !== null ? Date.parse(turn.endedAt) : live ? now : undefined;
  const took = started === undefined || ended === undefined ? undefined : duration(ended - started);
  const errors = log.filter((item) => item.kind === "notice" && item.tone === "error");
  const steps = log.filter((item) => item.kind === "tool").length;
  const openSteps = useContext(OpenStepsContext);
  const recalled = useContext(RecalledContext)[turn.id];

  // One layout for live and finished, so the work log and the answer keep their elements when the
  // turn ends: the log folds away behind "Worked" and the answer stays put.
  return (
    <article className="turn" data-arrived={arrived} data-sending={turn.id.startsWith(SENDING) || undefined}>
      <UserMessage text={turn.user} images={turn.images} clips={turn.clips} from={turn.from} task={turn.task} />
      {recalled && recalled.length > 0 && turn.from === null ? <Recalled lines={recalled} /> : null}
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
            <TurnEvents items={turn.items} live={live} />
            {cards.map(({ id, placement }) =>
              placement.kind === "updated" ? (
                <p key={id} className="turn-event">
                  <span className="quiet">Updated</span>
                  <Icon name="refresh" size={13} />
                  <span className="turn-event-name">{placement.name}</span>
                </p>
              ) : (
                <BlockCard
                  key={placement.call}
                  call={placement.call}
                  ui={placement.ui}
                  answer={answeredWith(placement.ui.blocks.filter(isQuestion), answers[placement.call], before && !placement.living ? next : null)}
                  open={placement.latest && !busy}
                  drafting={placement.drafting}
                />
              )
            )}
            {live ? (
              <button type="button" className="live" disabled={openSteps === null} aria-haspopup="dialog" onClick={openSteps ?? undefined}>
                <span className="live-avatar" aria-hidden="true">
                  <BotAvatar name={speaker.name} variantId={speaker.variantId} owner={speaker.variantId && KY_AVATAR} active size={20} />
                </span>
                <span className="shimmer">{speaker.name} is working</span>
                {took ? <span className="quiet tabular">{took}</span> : null}
                {steps > 0 && openSteps ? (
                  <span className="quiet live-steps">
                    {steps} {steps === 1 ? "step" : "steps"}
                    <Icon name="chevronRight" size={11} />
                  </span>
                ) : null}
              </button>
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
function Speaker({ id, active = false, failed = false, children }: { id: string; active?: boolean; failed?: boolean; children?: ReactNode }) {
  return (
    <div className="specialist-head">
      <BotAvatar name={`@${id}`} identity={id} owner={id} still={!active} active={active} failed={failed} size={22} />
      <span className="specialist-name">@{id}</span>
      {children}
    </div>
  );
}

function SpecialistReply({ reply }: { reply: Reply }) {
  return (
    <section className="specialist-reply" aria-label={`@${reply.from} replied`} data-failed={reply.failed}>
      <Speaker id={reply.from} failed={reply.failed}>
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
