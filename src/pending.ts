import type { Outgoing } from "./outbox";
import { messageStore, outboxChannel, type StoredMessage } from "./outbox-store";

/**
 * The messages ky has not answered, by operation id, with the chat each went to: in memory for the page, and on
 * the device (src/outbox-store.ts) for the next launch. A socket that drops may or may not have delivered one, so
 * each is sent again when its chat's socket opens; pi drops the copy whose operation id it already has. One the
 * page never put on an open socket waits for the connection, and only the page can take it back.
 */
export class Pending {
  readonly #messages = new Map<string, StoredMessage & { readonly restored?: boolean }>();
  readonly #channel: ReturnType<typeof outboxChannel>;

  /** `onGone` hears of one another tab saw answered or taken back. */
  constructor(onGone: (operationId: string) => void) {
    this.#channel = outboxChannel((operationId) => {
      if (this.#messages.delete(operationId)) onGone(operationId);
    });
  }

  add(message: StoredMessage): void {
    this.#messages.set(message.operationId, message);
    void messageStore.put(message);
  }

  get(operationId: string) {
    return this.#messages.get(operationId);
  }

  /** The chat's, oldest first. */
  of(session: string): StoredMessage[] {
    return [...this.#messages.values()].filter((each) => each.session === session);
  }

  /** Change one kept: it went on a socket, or its clips went up. */
  update(operationId: string, change: Partial<Pick<StoredMessage, "message" | "uploads" | "written">>): void {
    const current = this.#messages.get(operationId);

    if (current === undefined) return;
    const next = { ...current, ...change };
    this.#messages.set(operationId, next);
    const { restored: _, ...kept } = next;
    void messageStore.put(kept);
  }

  /** ky answered or refused it: it is ky's now, here and in every tab. */
  answered(operationId: string): void {
    if (!this.#messages.delete(operationId)) return;
    void messageStore.remove(operationId);
    this.#channel.gone(operationId);
  }

  /** Take back one the page never sent, as the user deletes or edits it offline; undefined once it went on a socket. */
  takeBack(operationId: string): StoredMessage | undefined {
    const message = this.#messages.get(operationId);

    if (message === undefined || message.written) return undefined;
    this.answered(operationId);

    return message;
  }

  /** Forget one another tab answered or took back while this one was away. */
  forget(operationId: string): void {
    this.#messages.delete(operationId);
  }

  /**
   * Whether another tab may have answered or taken this one back: it came from the device at launch, so another
   * tab knew it too. Asked before sending it, since the device then says.
   */
  shared(operationId: string): boolean {
    return this.#messages.get(operationId)?.restored === true;
  }

  /** What the device kept from before this launch; resolves with the ones this page didn't know. */
  async restore(): Promise<StoredMessage[]> {
    const kept = await messageStore.all();
    const fresh = kept.filter((each) => !this.#messages.has(each.operationId));

    for (const each of fresh) this.#messages.set(each.operationId, { ...each, restored: true });

    return fresh;
  }

  close(): void {
    this.#channel.close();
  }
}

/** A kept message as the page shows it: waiting above the composer until it goes on a socket, then in the thread. */
export const outgoingOf = (message: StoredMessage): Outgoing => ({
  operationId: message.operationId,
  input: message.message.input,
  at: message.at,
  behind: message.behind,
  submission: null,
  back: null,
  waiting: !message.written,
  uploads: message.uploads
});
