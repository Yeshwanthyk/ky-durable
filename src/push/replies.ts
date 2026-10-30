import { defineExtension, type Extension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { textOf } from "../skills/contract";

/** What a reply's push says when its answer has no text, such as one that only showed a card. */
export const NO_TEXT = "Your answer is ready.";

export type ReplyParts = {
  /** Whether the run in `session` answers the user: their own message started it, in one of their chats. */
  readonly asked: (session: string) => boolean;
  /** Whether the user is looking at ky now, on any device (src/sockets.ts watching). */
  readonly watched: () => boolean;
  /** Push `text` as `session`'s answer to the user's devices. */
  readonly notify: (session: string, text: string) => void;
};

/**
 * A reply to the user's own message pushes to their devices when its run ends and nobody is looking at ky: they
 * sent it and left. One push a run, for its final answer, never for its steps; a page that is open and in front of
 * them shows the answer instead. What ky posts unasked pushes on its own (src/automations/delivery.ts).
 */
export function replyPushExtension(parts: ReplyParts): Extension {
  return defineExtension({
    name: "reply-push",
    hooks: [
      hook(GenerationTask, {
        onYield(answer, api) {
          const session = String(api.conversationId);

          if (parts.asked(session) && !parts.watched()) parts.notify(session, textOf(answer).trim() || NO_TEXT);

          return undefined;
        }
      })
    ]
  });
}
