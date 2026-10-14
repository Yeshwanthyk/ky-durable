import type { AgentEvent, UserInput } from "@earendil-works/pi-durable";
import { imagesOf } from "./images";
import { type PiMessage, projectMessage } from "./transcript";

/**
 * A message the user sent that pi has not placed in the transcript yet. The
 * page shows it at once: in the thread while it is on its way to an idle
 * chat, or in the queue above the composer while it waits behind a run.
 */
export type Outgoing = {
  /** The submit's operation id; pi's submission carries it as its request id. */
  readonly operationId: string;
  readonly input: UserInput;
  /** When it was sent, for the thread's clock. */
  readonly at: number;
  /** Sent while a run was going, so it waits for that run, not for the thread. */
  readonly behind: boolean;
  /** pi's submission id, once pi has queued it in the inbox. */
  readonly submission: number | null;
};

/** The id the thread gives a message still on its way, until pi's own entry takes its place. */
export const SENDING = "sending:";

/** A message still on its way, as the thread shows a user's message. */
export const sendingMessage = (item: Outgoing): PiMessage =>
  projectMessage({ role: "user", content: item.input, timestamp: item.at }, `${SENDING}${item.operationId}`);

/** The words of a message, without its images. */
export function outgoingText(input: UserInput): string {
  if (!Array.isArray(input)) return String(input);

  return input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

export const outgoingImages = (input: UserInput): number => imagesOf(input).length;

/** Whether it waits in the queue above the composer, rather than showing in the thread. */
export const isQueued = (item: Outgoing): boolean => item.behind || item.submission !== null;

/**
 * Follows pi's word on each outgoing message: queued, it waits in the queue;
 * placed, answered or withdrawn, the transcript has it or it is gone. A
 * snapshot or inbox update keeps only the queued ones still in pi's inbox.
 */
export function reduceOutbox(outbox: readonly Outgoing[], events: readonly AgentEvent[]): readonly Outgoing[] {
  let next = outbox;

  for (const event of events) {
    if (next.length === 0) return next;

    if (event.type === "snapshot" || event.type === "inbox_update") {
      const inbox = new Set<number>((event.type === "snapshot" ? event.inbox : event.items).map((item) => item.id));
      next = next.filter((item) => item.submission === null || inbox.has(item.submission));
    } else if (event.type === "submission" && event.record.type === "input") {
      const { requestId, status, id } = event.record;

      next =
        status === "queued"
          ? next.map((item) => (item.operationId === requestId ? { ...item, submission: id } : item))
          : next.filter((item) => item.operationId !== requestId);
    }
  }

  return next;
}

/** The server answered or refused the submit. One pi queued stays until pi places it; any other is in the transcript, or never will be. */
export function settleOutgoing(outbox: readonly Outgoing[], operationId: string, refused: boolean): readonly Outgoing[] {
  return outbox.filter((item) => item.operationId !== operationId || (!refused && item.submission !== null));
}
