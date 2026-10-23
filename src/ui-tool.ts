import type { Context } from "@earendil-works/chord";
import { defineDoc, defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { type UiCard, UiCardSchema } from "./ui-blocks";

/**
 * ui: ky shows the user a card in the chat, composed from blocks: text, a
 * choice to tap, a field to type in, buttons, a list, facts, an image, a site's page, a status line,
 * headline numbers, a chart, a table, and tabs and columns that lay those out; and a routine, which the
 * model only names: the page fills it from the automations it holds, kept current.
 * The blocks are src/ui-blocks.ts's; the card (src/ui/Blocks.tsx) renders
 * from the call's arguments, block by block, and skips one it does not know.
 * What the user taps or types is sent as their next message, so the answer
 * reads in the history like any other. With `wait`, the turn ends at the call to wait for that answer.
 *
 * An automation's run has no user to answer it as it goes: its cards are kept here and posted in the chat it reports
 * to, before its report, once it succeeds (src/skills/subagents.ts, src/automations/delivery.ts). A posted card may
 * still ask: the user's answer is their next message in that chat, for the chat's agent, which sees the card.
 */

const UI = "ui";

const INTERACTIVE = new Set(["choice", "input", "buttons"]);

const reply = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], isError });

/**
 * The cards an automation's run showed, each as its call's id and the card's JSON, kept for its report. `run` is set
 * when the run is spawned; a conversation without it is no run, and its ui calls are refused as before.
 */
export const RunCards = defineDoc<{ run: boolean; cards: Array<{ call: string; card: string }> }>({
  kind: "ky.run-cards",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ run: false, cards: [] })
});


/** Only the main chat and side chats have a user to show, and an automation's run a report to post with; elsewhere the call is refused. */
export function uiExtension(chat: (session: string) => boolean): Extension {
  return defineExtension({
    name: "ui",
    tools: [
      defineTool({
        name: UI,
        description:
          "Show the user a card in the chat, composed from blocks, when it reads better than prose: a choice between a few known answers, " +
          "a short field to fill in, a button to authorize or confirm, a list or facts to look over, an image to see, a page you published with the site tool, a status. " +
          "To show a routine you made or changed, name it in a routine block by its id: the card shows it as it is now, kept current, so write no status for it. " +
          "For data, give the numbers and the card draws them in the chat's own style: stats for a few headline numbers, a chart (bar, line or donut), a table; " +
          "lay them out with columns (side by side, folding on a phone) and tabs. Prefer these to a page: they cost a fraction of the tokens and match light and dark. Compose what fits what was asked; " +
          "plain answers stay plain text. The user's taps arrive as their next message: a choice as its label (several joined by \", \"), " +
          "a field as its text, a button as its reply; with several questions, one line each as \"label: answer\". " +
          "To update a card you showed, such as a status that moves on or a list that fills in, give it an id and show it again with the same id: " +
          "the new card replaces the old where it first showed, and the thread notes the update. " +
          "With wait, call it last, alone: your turn ends there. " +
          "In an automation's run the card is posted before your report once the run succeeds, and wait does nothing: your run goes on. " +
          "It may still ask (a choice, a field, buttons): the user's answer arrives later in that chat, for the chat's agent, not for your run.",
        parameters: UiCardSchema,
        replay: "safe",
        execute: async (args, api, context) => {
          if (!chat(String(api.conversationId))) return keep(args, api, context);
          const asks = args.blocks.some((block) => INTERACTIVE.has(block.type));

          if (!args.wait) return reply(asks ? "Shown to the user; their answer, if any, arrives as a later message." : "Shown to the user.");

          if (!asks) return reply("Not waiting: the card has nothing to answer. Add a choice, input or buttons, or leave out wait.", true);

          return { ...reply("Shown to the user. Your turn ends here; their answer arrives as their next message."), control: { terminate: true } };
        }
      })
    ]
  });
}

/** A run keeps its card for its report, without wait, once a call however often it is replayed; anywhere else the call is refused. */
async function keep({ wait, ...card }: UiCard, api: ToolExecutionApi, context: Context) {
  const kept = await api.commit(async (tx) => {
    const doc = await tx.doc(RunCards, api.conversationId);

    if (!doc.run) return "refused";

    if (!doc.cards.some((each) => each.call === api.callId)) doc.cards.push({ call: api.callId, card: JSON.stringify(card) });

    return "kept";
  }, context);

  if (kept === "refused") return reply("Not shown: only a chat with the user has someone to show.", true);

  const asks = card.blocks.some((block) => INTERACTIVE.has(block.type)) ? " The user answers it in that chat, later, not to this run." : "";
  const waits = wait === true ? " wait does nothing in a run: your turn goes on; finish with your report." : "";

  return reply(`Kept: the card is posted to the user before your report once this run succeeds.${asks}${waits}`);
}
