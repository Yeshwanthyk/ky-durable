import type { JsonValue } from "@earendil-works/pi-ai";

/**
 * A STAND-IN for the approvals PR's src/approvals/approvals.ts and contract.ts, until inbound is rebased onto it.
 * The names and shapes here are that module's, with "secret-request" added to ApprovalKind, so the rebase replaces
 * this file's body with a re-export of the real one and touches nothing that imports it.
 *
 * Until then it keeps nothing and asks nobody: there is no card for the user to decide on, so requestApproval
 * refuses, and whatever was going to wait for an approval is not done.
 */

/** What an approval is for: an Executor app action, a mail held for its address, a webhook's action, or a call with a credential. */
export type ApprovalKind = "executor" | "mail" | "webhook-action" | "secret-request";

/** Where an approval stands: waiting on the user, decided by them, or gone before they could. */
export type ApprovalStatus = "pending" | "accepted" | "declined" | "cancelled" | "expired";

/** The user's answer: accept, decline this one, or cancel what asked altogether. */
export type ApprovalAction = "accept" | "decline" | "cancel";

/** What a tool asks the user to decide. `conversation` is the session that asked. */
export type ApprovalRequest = {
  readonly kind: ApprovalKind;
  readonly subject: string;
  readonly summary: string;
  readonly payload: JsonValue;
  readonly conversation: string;
};

/** An approval as its kind's handler gets it, once the user decided it. */
export type Approval = ApprovalRequest & {
  readonly id: string;
  readonly status: ApprovalStatus;
  /** The chat its card shows in, and that hears what came of it. */
  readonly chat: string;
};

type Refused = { readonly refused: string };

/** What a kind does with the user's answer, and whether its approvals show as cards in their chat. */
export type ApprovalHandler = {
  readonly decide: (approval: Approval, action: ApprovalAction) => Promise<Refused | Record<string, never>>;
  /** What a tap on one no longer waiting is told. */
  readonly gone?: string;
  /** False for a kind the user decides elsewhere, as mail is in Settings › Mail. */
  readonly card?: boolean;
};

export type ApprovalDeps = {
  /** Whether a session is a chat the user is in: the main chat or a side chat. */
  readonly chat: (session: string) => boolean;
  /** The chat a conversation with no user works for; the main chat when it works for none. */
  readonly owner: (session: string) => string;
  /** Tell the user's devices; it must not throw. */
  readonly notify: (chat: string, text: string) => void;
};

/** Why the stand-in asks nobody. */
export const WAITING_ON_APPROVALS = "Waiting on approvals: ky can't ask for the user's OK yet, so this isn't done.";

const GONE = "That approval isn't waiting any more.";

export class Approvals {
  readonly #handlers = new Map<ApprovalKind, ApprovalHandler>();

  // The real one keeps approvals in `sql` and reaches the user through `deps`; the stand-in needs neither.
  constructor(_sql: SqlStorage, _deps: ApprovalDeps) {}

  /** Who decides each kind; a kind with no handler can't be decided, so it stays pending. */
  handle(kind: ApprovalKind, handler: ApprovalHandler): void {
    this.#handlers.set(kind, handler);
  }

  /** Ask the user; the approval's id. The stand-in has no card to ask with, so it throws WAITING_ON_APPROVALS. */
  requestApproval(request: ApprovalRequest): string {
    throw new Error(`${WAITING_ON_APPROVALS} (${request.summary})`);
  }

  /** The user's answer to approval `id`. The stand-in asked nothing, so there is nothing to decide. */
  // The approvals PR's card calls it; the stand-in has no card, so nothing does until the rebase.
  // fallow-ignore-next-line unused-class-member
  async onDecision(_id: string, _action: ApprovalAction): Promise<Refused | Record<string, never>> {
    return { refused: GONE };
  }
}
