import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { UiCardSchema } from "./ui-blocks";

/**
 * ui: ky shows the user a card in the chat, composed from blocks: text, a
 * choice to tap, a field to type in, buttons, a list, facts, an image, a status line.
 * The blocks are src/ui-blocks.ts's; the card (src/ui/Blocks.tsx) renders
 * from the call's arguments, block by block, and skips one it does not know.
 * What the user taps or types is sent as their next message, so the answer
 * reads in the history like any other. With `wait`, the turn ends at the call to wait for that answer.
 */

const UI = "ui";

const INTERACTIVE = new Set(["choice", "input", "buttons"]);

const reply = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], isError });

/** Only the main chat and side chats have a user to show; elsewhere the call is refused. */
export function uiExtension(chat: (session: string) => boolean): Extension {
  return defineExtension({
    name: "ui",
    tools: [
      defineTool({
        name: UI,
        description:
          "Show the user a card in the chat, composed from blocks, when it reads better than prose: a choice between a few known answers, " +
          "a short field to fill in, a button to authorize or confirm, a list or facts to look over, an image to see, a status. Compose what fits what was asked; " +
          "plain answers stay plain text. The user's taps arrive as their next message: a choice as its label (several joined by \", \"), " +
          "a field as its text, a button as its reply; with several questions, one line each as \"label: answer\". " +
          "With wait, call it last, alone: your turn ends there.",
        parameters: UiCardSchema,
        replay: "safe",
        execute: async (args, api) => {
          if (!chat(String(api.conversationId))) return reply("Not shown: only a chat with the user has someone to show.", true);
          const asks = args.blocks.some((block) => INTERACTIVE.has(block.type));


          if (!args.wait) return reply(asks ? "Shown to the user; their answer, if any, arrives as a later message." : "Shown to the user.");

          if (!asks) return reply("Not waiting: the card has nothing to answer. Add a choice, input or buttons, or leave out wait.", true);

          return { ...reply("Shown to the user. Your turn ends here; their answer arrives as their next message."), control: { terminate: true } };
        }
      })
    ]
  });
}
