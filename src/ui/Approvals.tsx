import { createContext, useContext, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type ApprovalAction, APPROVAL_KINDS, type ApprovalView, NOBODY_ANSWERED } from "../approvals/contract";
import type { UiCard } from "../cards/contract";
import type { StoredAct } from "../outbox-store";
import { BlockCard, ReplyContext } from "./Blocks";
import { Button } from "./kit/Button";
import { StatusGlyph } from "./kit/StatusGlyph";
import { Sheet } from "./Sheet";
import { Problem } from "./Subscriptions";

/**
 * An approval ky asked of the user (src/approvals/approvals.ts) shows as a
 * card in its chat, made of the same blocks as a card ky composes: what will
 * happen, and Approve or Decline. A tap goes over the user's own socket as an
 * approval-decide, never as a chat message, so nothing the model writes can
 * stand in for it; the card goes once the server claims it, and the chat
 * hears what came of it.
 */

/**
 * The approvals waiting on the user, and what a tap does: it resolves with why the tap was refused, if it was.
 * `waiting`: taps made offline, by approval, which go once ky is back. `onOpenDesk`: where the approvals of every
 * chat are, if anywhere. Provided around the chat.
 */
export const ApprovalsContext = createContext<{
  approvals: readonly ApprovalView[];
  onDecide: (approval: string, action: ApprovalAction) => Promise<string | undefined>;
  waiting: ReadonlyMap<string, ApprovalAction>;
  onOpenDesk?: () => void;
}>({ approvals: [], onDecide: async () => undefined, waiting: new Map() });

/**
 * One ask of an approval. The server keeps an approval's id when the same request asks again, as a new ask with a
 * later `createdAt`; what this tab put off or answered is the ask, so a new one shows again.
 */
export const askOf = (approval: ApprovalView) => `${approval.id}:${approval.createdAt}`;

// The asks put off with Later, in this tab only: they come back on reload, and the server never hears of it.
let snoozed: ReadonlySet<string> = new Set();

const snoozeListeners = new Set<() => void>();

/** Puts an approval off until the page reloads: its chat and the Desk stop showing it. */
export function snooze(approval: ApprovalView): void {
  snoozed = new Set([...snoozed, askOf(approval)]);

  for (const listener of snoozeListeners) listener();
}

function onSnooze(listener: () => void): () => void {
  snoozeListeners.add(listener);

  return () => snoozeListeners.delete(listener);
}

/** The approvals put off with Later; shared by every chat and the Desk. */
export function useSnoozed(): ReadonlySet<string> {
  return useSyncExternalStore(onSnooze, () => snoozed, () => snoozed);
}

// The approvals answered on the Desk, gone from what waits before the server's next list says so; a refusal puts one
// back. In this tab only, shared by the Desk's deck and the sidebar's count.
let answered: ReadonlySet<string> = new Set();

const answeredListeners = new Set<() => void>();

/** Marks an approval answered on the page (`gone`), or puts it back when its answer was refused. */
export function markAnswered(approval: ApprovalView, gone: boolean): void {
  const ask = askOf(approval);

  answered = gone ? new Set([...answered, ask]) : new Set([...answered].filter((each) => each !== ask));

  for (const listener of answeredListeners) listener();
}

function onAnswered(listener: () => void): () => void {
  answeredListeners.add(listener);

  return () => answeredListeners.delete(listener);
}

/** The approvals answered on the page whose answer the server's list doesn't show yet. */
export function useAnswered(): ReadonlySet<string> {
  return useSyncExternalStore(onAnswered, () => answered, () => answered);
}

/** The approvals still waiting on the user's tap, in the order they came: not expired, not put off. */
export const stillWaiting = (approvals: readonly ApprovalView[], put: ReadonlySet<string>) =>
  approvals.filter((approval) => approval.lapsedAt === undefined && !put.has(askOf(approval)));

/**
 * What needs the user, as every count of it says: the chat's "x of y" and "more in other chats", the Desk's deck and
 * greeting, and the sidebar's badge. Not one expired or put off, not one tapped offline or just answered on the page,
 * and not a hand-off of ky's browser, which takes the user to the live page from its own chat.
 */
export const needingYou = (approvals: readonly ApprovalView[], put: ReadonlySet<string>, waiting: ReadonlyMap<string, ApprovalAction>, done: ReadonlySet<string>) =>
  stillWaiting(approvals, put).filter((approval) => approval.kind !== "browser-handoff" && !waiting.has(approval.id) && !done.has(askOf(approval)));

/** {@link needingYou} for these approvals, with what this tab put off and answered. */
export function useNeedingYou(approvals: readonly ApprovalView[], waiting: ReadonlyMap<string, ApprovalAction>): readonly ApprovalView[] {
  const put = useSnoozed();
  const done = useAnswered();

  return useMemo(() => needingYou(approvals, put, waiting, done), [approvals, put, waiting, done]);
}

/** The approval taps among the changes made offline, by approval. */
export function decisionsWaiting(acts: readonly StoredAct[]): ReadonlyMap<string, ApprovalAction> {
  return new Map(acts.flatMap(({ message }) => (message.type === "approval-decide" ? [[message.approval, message.action] as const] : [])));
}

/** What a card says under a tap made offline. */
const WAITING_NOTE: Record<ApprovalAction, string> = {
  accept: "Approved offline · goes to ky when it reconnects.",
  decline: "Declined offline · goes to ky when it reconnects.",
  cancel: "Cancelled offline · goes to ky when it reconnects."
};

const TAKE_OVER = "take-over";

/** A hand-off of ky's browser or a specialist's: take the live page over, then say how it went. */
function handoffCard(approval: ApprovalView): UiCard {
  return {
    title: APPROVAL_KINDS[approval.kind].title,
    subtitle: approval.subject,
    icon: "globe",
    blocks: [
      { type: "text", text: approval.summary },
      {
        type: "buttons",
        buttons: [
          ...(approval.link ? [{ label: "Take over", reply: TAKE_OVER, tone: "primary" as const }] : []),
          { label: "I'm done", reply: "accept" },
          { label: "I couldn't", reply: "decline", tone: "danger" }
        ]
      }
    ],
    note: "What you do there stays in the cloud browser. Once you're done, ky keeps this site's login in its Vault for whoever asked; Settings › Webhooks lists it to move or remove."
  };
}

// One nobody answered stays a day as expired, with nothing left to tap.
const lapsedCard = (approval: ApprovalView): UiCard => ({
  title: APPROVAL_KINDS[approval.kind].title,
  blocks: [{ type: "text", text: approval.summary }],
  note: `Expired · ${NOBODY_ANSWERED}, so nothing was done. Ask ky again if it still matters.`
});

const titled = (approval: ApprovalView, card: UiCard): UiCard => (approval.subject ? { ...card, subtitle: approval.subject, icon: approval.subject } : card);

/** The card a hand-off or an expired approval shows as: its blocks are the ui tool's own, so it looks and taps like any card. */
function cardOf(approval: ApprovalView): UiCard {
  return approval.lapsedAt === undefined ? handoffCard(approval) : titled(approval, lapsedCard(approval));
}

/** Where a card stands among all that wait: "1 of 4". */
export type Position = { readonly index: number; readonly of: number };

/**
 * What ky wants to do, waiting on the user: its plain summary, Approve, a quieter Decline, and Later to put it off.
 * `waiting`: a tap made offline, which the card shows as made, taking no other.
 */
export function DecisionCard({
  approval,
  onDecide,
  onLater,
  position,
  waiting,
  pending = false
}: {
  approval: ApprovalView;
  onDecide: (action: "accept" | "decline") => void;
  onLater?: () => void;
  position?: Position;
  waiting?: ApprovalAction;
  /** A tap on its way: the buttons take no other until it lands or is refused. */
  pending?: boolean;
}) {
  const title = APPROVAL_KINDS[approval.kind].title;
  const done = waiting !== undefined;
  const off = done || pending;

  return (
    <section className="decision-card" aria-label={title}>
      <header className="decision-head">
        <StatusGlyph status="needs" />
        <b className="decision-title">{title}</b>
        {approval.subject ? <span className="decision-subject">{approval.subject}</span> : null}
        {position && position.of > 1 ? <span className="decision-position">{`${position.index + 1} of ${position.of}`}</span> : null}
      </header>
      <div className="decision-inner">
        <p className="decision-summary">{approval.summary}</p>
        <p className="decision-note">{done ? WAITING_NOTE[waiting] : "Only your tap approves it: ky can't, and nobody else can."}</p>
        <div className="decision-actions">
          {onLater && !done ? (
            <Button variant="quiet" disabled={pending} onClick={onLater}>
              Later
            </Button>
          ) : null}
          <Button variant="quiet" className="decision-decline" disabled={off} onClick={() => onDecide("decline")}>
            Decline
          </Button>
          <Button variant="primary" disabled={off} onClick={() => onDecide("accept")}>
            Approve
          </Button>
        </div>
      </div>
    </section>
  );
}

/** The approvals waiting in chat `chat`, after its thread, and how many more wait in other chats. */
export function ApprovalCards({ chat }: { chat: string }) {
  const { approvals, onOpenDesk, waiting } = useContext(ApprovalsContext);
  const put = useSnoozed();
  const all = useNeedingYou(approvals, waiting);
  const here = approvals.filter((approval) => approval.chat === chat && !put.has(askOf(approval)));
  const elsewhere = all.filter((approval) => approval.chat !== chat).length;

  const at = (approval: ApprovalView): Position | undefined => {
    const index = all.indexOf(approval);

    return index < 0 ? undefined : { index, of: all.length };
  };

  return (
    <>
      {here.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} position={at(approval)} />
      ))}
      {here.length > 0 && elsewhere > 0 ? (
        <p className="decision-more">
          <span>{`${elsewhere} more waiting in other chats`}</span>
          {onOpenDesk ? (
            <Button variant="quiet" size={28} onClick={onOpenDesk}>
              Open Desk
            </Button>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

function ApprovalCard({ approval, position }: { approval: ApprovalView; position: Position | undefined }) {
  const { onDecide, waiting } = useContext(ApprovalsContext);
  const [refused, setRefused] = useState<string>();
  const [live, setLive] = useState(false);
  // A tap on its way: a second one, from a double tap, does nothing.
  const [pending, setPending] = useState(false);
  const decided = waiting.get(approval.id);
  const asking = approval.lapsedAt === undefined && approval.kind !== "browser-handoff";
  const ui = useMemo(() => (decided === undefined ? cardOf(approval) : { ...cardOf(approval), note: WAITING_NOTE[decided] }), [approval, decided]);
  // A tap made offline shows as made, and the card takes no other until ky has it.
  const answer = useMemo(() => (decided === undefined ? null : { values: [], button: decided }), [decided]);

  // Each button replies with its answer; any other reply does nothing.
  const decide = (reply: string) => {
    if (reply === TAKE_OVER) setLive(true);

    if ((reply === "accept" || reply === "decline") && !pending) {
      setLive(false);
      setPending(true);
      setRefused(undefined);
      void onDecide(approval.id, reply).then((reason) => {
        setRefused(reason);

        if (reason !== undefined) setPending(false);
      });
    }
  };

  return (
    <div className="approval" data-approval={approval.id}>
      {asking ? (
        <DecisionCard approval={approval} onDecide={decide} onLater={() => snooze(approval)} position={position} waiting={decided} pending={pending} />
      ) : (
        <ReplyContext.Provider value={decide}>
          <BlockCard call={`approval:${approval.id}`} ui={ui} answer={answer} open />
        </ReplyContext.Provider>
      )}
      <Problem text={refused} />
      {live && approval.link ? <LiveView link={approval.link} site={approval.subject} onDone={decide} onClose={() => setLive(false)} /> : null}
    </div>
  );
}

/** ky's browser, live, over the chat: the user works the page there, then says how it went. */
function LiveView({ link, site, onDone, onClose }: { link: string; site: string; onDone: (reply: string) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  const tools = (
    <div className="handoff-tools">
      <button type="button" className="pill primary pressable" onClick={() => onDone("accept")}>
        I'm done
      </button>
      <button type="button" className="pill pressable" onClick={() => onDone("decline")}>
        I couldn't
      </button>
    </div>
  );

  return (
    <Sheet dialog={dialog} label={site} className="handoff-sheet" onClose={onClose} tools={tools}>
      <iframe
        className="handoff-view"
        src={link}
        title={`ky's browser on ${site}`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        allow="clipboard-read; clipboard-write"
        referrerPolicy="no-referrer"
      />
    </Sheet>
  );
}
