import { createContext, useContext, useMemo, useState } from "react";
import type { ApprovalAction, ApprovalView, ToolPolicy, ToolPolicyView } from "../approvals/contract";
import type { UiCard } from "../ui-blocks";
import { BlockCard, ReplyContext } from "./Blocks";
import { Problem } from "./Subscriptions";

/**
 * An approval ky asked of the user (src/approvals/approvals.ts) shows as a
 * card in its chat, made of the same blocks as a card ky composes: what will
 * happen, and Approve or Decline. A tap goes over the user's own socket as an
 * approval-decide, never as a chat message, so nothing the model writes can
 * stand in for it; the card goes once the server settles it.
 */

type ApprovalActions = {
  /** Resolves with why the tap was refused, if it was. */
  readonly onDecide: (approval: string, action: ApprovalAction) => Promise<string | undefined>;
  readonly onPolicy: (tool: string, policy: ToolPolicy) => Promise<string | undefined>;
};

/** The approvals waiting on the user and each Executor tool's policy, with what a tap does; provided around the chat and Settings. */
export const ApprovalsContext = createContext<{ approvals: readonly ApprovalView[]; policies: readonly ToolPolicyView[]; actions: ApprovalActions }>({
  approvals: [],
  policies: [],
  actions: { onDecide: async () => undefined, onPolicy: async () => undefined }
});

const APPROVE = "Approve";

const DECLINE = "Decline";

/** The card an approval shows as: its blocks are the ui tool's own, so it looks and taps like any card. */
function cardOf(approval: ApprovalView): UiCard {
  const card: UiCard = {
    title: approval.kind === "executor" ? "Approve this app action?" : "Approve this?",
    blocks: [
      { type: "text", text: approval.summary },
      {
        type: "buttons",
        buttons: [
          { label: APPROVE, tone: "primary" },
          { label: DECLINE, tone: "danger" }
        ]
      }
    ],
    note: "Only your tap approves it: ky can't, and nobody else can."
  };

  if (approval.subject) {
    card.subtitle = approval.subject;
    card.icon = approval.subject;
  }

  return card;
}

/** The approvals waiting in chat `chat`, after its thread. */
export function ApprovalCards({ chat }: { chat: string }) {
  const { approvals } = useContext(ApprovalsContext);
  const here = approvals.filter((approval) => approval.chat === chat);

  return here.map((approval) => <ApprovalCard key={approval.id} approval={approval} />);
}

function ApprovalCard({ approval }: { approval: ApprovalView }) {
  const { actions } = useContext(ApprovalsContext);
  const [refused, setRefused] = useState<string>();
  const ui = useMemo(() => cardOf(approval), [approval]);

  const decide = (text: string) => {
    void actions.onDecide(approval.id, text === APPROVE ? "accept" : "decline").then(setRefused);
  };

  return (
    <div className="approval" data-approval={approval.id}>
      <ReplyContext.Provider value={decide}>
        <BlockCard call={`approval:${approval.id}`} ui={ui} answer={null} open />
      </ReplyContext.Provider>
      <Problem text={refused} />
    </div>
  );
}
