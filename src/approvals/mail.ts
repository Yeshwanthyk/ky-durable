import Type from "typebox";
import { decodeOr } from "../core/decode";
import { type MailDesk, type MailRow, mailApprove, mailDiscard } from "../mail";
import type { Approvals } from "./approvals";
import type { ApprovalAction } from "./contract";

/**
 * A mail held for an address ky hasn't written to is an approval of kind
 * mail. The user still decides it in Settings › Mail, as before: it shows no
 * card in the chat and sends no push, and sending or discarding it does
 * exactly what it did (src/mail.ts); the store only makes that answer count
 * once, like every other approval's.
 */

const GONE = "That mail isn't waiting any more.";

const Payload = Type.Object({ mail: Type.String() });

/** Decide mail approvals by sending or discarding the held mail. */
export function handleMail(approvals: Approvals, desk: () => MailDesk): void {
  approvals.handle("mail", {
    card: false,
    gone: GONE,
    decide: async (approval, action) => {
      const id = decodeOr(Payload, approval.payload, undefined)?.mail;

      if (id === undefined) return { refused: GONE };

      return action === "accept" ? mailApprove(desk(), id) : mailDiscard(desk(), id);
    }
  });
}

/** Ask the user about a mail ky just held. */
export function mailHeld(approvals: Approvals, mail: MailRow): string {
  return approvals.requestApproval({ kind: "mail", subject: mail.party, summary: mail.subject, payload: { mail: mail.id }, conversation: mail.session });
}

/** The user's send or discard of held mail `id` from Settings › Mail, through its approval. */
export async function decideMail(approvals: Approvals, desk: MailDesk, id: string, action: ApprovalAction) {
  const waiting = approvals.pendingBy("mail", "mail", id);

  if (waiting) return approvals.onDecision(waiting.id, action);
  // A mail held before approvals were kept has none yet: it is asked now, so it is decided the same way.
  const held = desk.box.held().find((row) => row.id === id);

  if (!held) return { refused: GONE };

  return approvals.onDecision(mailHeld(approvals, held), action);
}
