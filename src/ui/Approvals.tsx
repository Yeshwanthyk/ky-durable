import { createContext, useContext, useMemo, useState } from "react";
import { type ApprovalAction, APPROVAL_KINDS, type ApprovalView, NOBODY_ANSWERED } from "../approvals/contract";
import type { UiCard } from "../cards/contract";
import type { StoredAct } from "../outbox-store";
import { BlockCard, ReplyContext } from "./Blocks";
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
 * `waiting`: taps made offline, by approval, which go once ky is back. Provided around the chat.
 */
export const ApprovalsContext = createContext<{
  approvals: readonly ApprovalView[];
  onDecide: (approval: string, action: ApprovalAction) => Promise<string | undefined>;
  waiting: ReadonlyMap<string, ApprovalAction>;
}>({ approvals: [], onDecide: async () => undefined, waiting: new Map() });

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

/** The card an approval shows as: its blocks are the ui tool's own, so it looks and taps like any card. */
function cardOf(approval: ApprovalView): UiCard {
  // One nobody answered stays a day as expired, with nothing left to tap.
  const card: UiCard = approval.lapsedAt !== undefined ? {
    title: APPROVAL_KINDS[approval.kind].title,
    blocks: [{ type: "text", text: approval.summary }],
    note: `Expired · ${NOBODY_ANSWERED}, so nothing was done. Ask ky again if it still matters.`
  } : {
    title: APPROVAL_KINDS[approval.kind].title,
    blocks: [
      { type: "text", text: approval.summary },
      {
        type: "buttons",
        buttons: [
          { label: "Approve", reply: "accept", tone: "primary" },
          { label: "Decline", reply: "decline", tone: "danger" }
        ]
      }
    ],
    note: "Only your tap approves it: ky can't, and nobody else can."
  };

  return approval.subject ? { ...card, subtitle: approval.subject, icon: approval.subject } : card;
}

/** The approvals waiting in chat `chat`, after its thread. */
export function ApprovalCards({ chat }: { chat: string }) {
  const { approvals } = useContext(ApprovalsContext);
  const here = approvals.filter((approval) => approval.chat === chat);

  return here.map((approval) => <ApprovalCard key={approval.id} approval={approval} />);
}

function ApprovalCard({ approval }: { approval: ApprovalView }) {
  const { onDecide, waiting } = useContext(ApprovalsContext);
  const [refused, setRefused] = useState<string>();
  const decided = waiting.get(approval.id);
  const ui = useMemo(() => (decided === undefined ? cardOf(approval) : { ...cardOf(approval), note: WAITING_NOTE[decided] }), [approval, decided]);
  // A tap made offline shows as made, and the card takes no other until ky has it.
  const answer = useMemo(() => (decided === undefined ? null : { values: [], button: decided }), [decided]);

  // Each button replies with its answer; any other reply does nothing.
  const decide = (reply: string) => {
    if (reply === "accept" || reply === "decline") void onDecide(approval.id, reply).then(setRefused);
  };

  return (
    <div className="approval" data-approval={approval.id}>
      <ReplyContext.Provider value={decide}>
        <BlockCard call={`approval:${approval.id}`} ui={ui} answer={answer} open />
      </ReplyContext.Provider>
      <Problem text={refused} />
    </div>
  );
}
