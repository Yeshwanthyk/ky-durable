import type { AgentEvent, UserInput } from "@earendil-works/pi-durable";
import { imagesOf } from "./files/media";
import { type PiMessage, projectMessage } from "./core/transcript";

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
  /**
   * Whether it is coming back. `taking`: the user is taking it back to edit or delete. `returned`:
   * pi withdrew it without the user asking, as Stop does, so it goes back to the composer.
   */
  readonly back: "taking" | "returned" | null;
  /** Written while ky was out of reach and never put on an open socket: it waits above the composer, and the page alone can take it back. */
  readonly waiting?: boolean;
  /** Clips recorded or attached offline, which go up before the message can. */
  readonly uploads?: readonly Upload[];
};

/** A clip that goes up before its message: its tag names `file`, a stand-in id, until the upload gives it its own. */
export type Upload = { readonly file: string; readonly body: Blob; readonly type: string };

/** A stand-in file id for a clip that has not gone up: the shape of a real one, so its tag reads as a clip. */
export const standInFile = () => crypto.randomUUID().replaceAll("-", "");

/** The message with each clip's stand-in id replaced by the id its upload got. */
export function withFiles(input: UserInput, files: ReadonlyMap<string, string>): UserInput {
  const swap = (text: string) => text.replace(/file="([0-9a-f]{32})"/g, (whole, file: string) => (files.has(file) ? `file="${files.get(file)}"` : whole));

  if (!Array.isArray(input)) return swap(String(input));

  return input.map((part) => (part.type === "text" ? { ...part, text: swap(part.text) } : part));
}

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
/** Written offline and not sent yet: it waits for the connection, above the composer. */
export const isWaiting = (item: Outgoing): boolean => item.waiting === true && item.back !== "returned";

export const isQueued = (item: Outgoing): boolean => !isWaiting(item) && item.back !== "returned" && (item.behind || item.submission !== null);

/** Given back by pi, for the composer to take in. */
export const isReturned = (item: Outgoing): boolean => item.back === "returned";

/**
 * Left behind: pi holds it queued, but no run is going to place it, as after a run that ended
 * without an answer. Nothing else will send it, so the page takes it back.
 */
export const isStranded = (item: Outgoing, running: boolean): boolean => !running && item.submission !== null && item.back === null;

/**
 * Follows pi's word on each outgoing message: queued, it waits in the queue;
 * placed or answered, the transcript has it. Withdrawn while queued, it is gone
 * if the user took it back, and otherwise returned for the composer: a message
 * the user sent is never just dropped. A snapshot or inbox update keeps only
 * the queued ones still in pi's inbox, and the returned ones.
 */
export function reduceOutbox(outbox: readonly Outgoing[], events: readonly AgentEvent[]): readonly Outgoing[] {
  let next = outbox;

  for (const event of events) {
    if (next.length === 0) return next;

    if (event.type === "snapshot" || event.type === "inbox_update") {
      const inbox = new Set<number>((event.type === "snapshot" ? event.inbox : event.items).map((item) => item.id));
      next = next.filter((item) => item.submission === null || item.back === "returned" || inbox.has(item.submission));
    } else if (event.type === "submission" && event.record.type === "input") {
      const record = event.record;

      next = next.flatMap((item): Outgoing[] => {
        if (item.operationId !== record.requestId) return [item];

        if (record.status === "queued") return [{ ...item, submission: record.id }];

        const dropped = record.status === "unanswered" && record.reason === "aborted" && item.submission !== null;

        return dropped && item.back !== "taking" ? [{ ...item, back: "returned" }] : [];
      });
    }
  }

  return next;
}

/** The server answered or refused the submit. One pi queued stays until pi places it; any other is in the transcript, or never will be. */
export function settleOutgoing(outbox: readonly Outgoing[], operationId: string, refused: boolean): readonly Outgoing[] {
  // A returned one waits for the composer, whatever the server answered.
  return outbox.filter((item) => item.operationId !== operationId || item.back === "returned" || (!refused && item.submission !== null));
}

/** Mark one as being taken back by the user, or, when pi had placed it already, not. */
export const markTaking = (outbox: readonly Outgoing[], operationId: string, taking: boolean): readonly Outgoing[] =>
  outbox.map((item) => (item.operationId === operationId && item.back !== "returned" ? { ...item, back: taking ? "taking" : null } : item));

/** Drop the returned ones the composer has taken in. */
export const dropReturned = (outbox: readonly Outgoing[], operationIds: ReadonlySet<string>): readonly Outgoing[] =>
  outbox.filter((item) => !(item.back === "returned" && operationIds.has(item.operationId)));
