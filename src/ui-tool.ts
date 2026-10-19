import type { Context } from "@earendil-works/chord";
import { defineDoc, defineExtension, defineTool, type Extension, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { type UiBlock, type UiCard, UiCardSchema } from "./ui-blocks";

/**
 * ui: ky shows the user a card in the chat, composed from blocks: text, a
 * choice to tap, a field to type in, buttons, a list, facts, an image, a site's page, a status line,
 * headline numbers, a chart, a table, and tabs and columns that lay those out.
 * The blocks are src/ui-blocks.ts's; the card (src/ui/Blocks.tsx) renders
 * from the call's arguments, block by block, and skips one it does not know.
 * What the user taps or types is sent as their next message, so the answer
 * reads in the history like any other. With `wait`, the turn ends at the call to wait for that answer.
 *
 * An automation's run has no user to answer it: its cards are kept here, display only, and posted in the chat it
 * reports to, before its report, once it succeeds (src/skills/subagents.ts, src/automations/delivery.ts).
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

/** A run's card as it is posted: no wait, and no block that asks for an answer, link buttons aside; null when nothing is left. */
export function runCard({ wait: _wait, ...card }: UiCard): UiCard | null {
  const blocks = card.blocks.flatMap((block): UiBlock[] => {
    if (block.type !== "buttons") return INTERACTIVE.has(block.type) ? [] : [block];
    const links = block.buttons.filter((button) => button.url !== undefined);

    return links.length > 0 ? [{ ...block, buttons: links }] : [];
  });

  return blocks.length > 0 ? { ...card, blocks } : null;
}

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
          "For data, give the numbers and the card draws them in the chat's own style: stats for a few headline numbers, a chart (bar, line or donut), a table; " +
          "lay them out with columns (side by side, folding on a phone) and tabs. Prefer these to a page: they cost a fraction of the tokens and match light and dark. Compose what fits what was asked; " +
          "plain answers stay plain text. The user's taps arrive as their next message: a choice as its label (several joined by \", \"), " +
          "a field as its text, a button as its reply; with several questions, one line each as \"label: answer\". " +
          "With wait, call it last, alone: your turn ends there. " +
          "In an automation's run the card is display only: it is posted before your report once the run succeeds, without wait or anything to answer (link buttons stay).",
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

/** A run keeps its card for its report, once a call however often it is replayed; anywhere else the call is refused. */
async function keep(args: UiCard, api: ToolExecutionApi, context: Context) {
  const card = runCard(args);

  const kept = await api.commit(async (tx) => {
    const doc = await tx.doc(RunCards, api.conversationId);

    if (!doc.run) return "refused";

    if (card === null) return "empty";

    if (!doc.cards.some((each) => each.call === api.callId)) doc.cards.push({ call: api.callId, card: JSON.stringify(card) });

    return "kept";
  }, context);

  if (kept === "refused") return reply("Not shown: only a chat with the user has someone to show.", true);

  if (kept === "empty") return reply("Not kept: a run's card is display only, and every block in this one asks for an answer.", true);

  const notes = [
    JSON.stringify(card?.blocks) !== JSON.stringify(args.blocks) ? " What asks for an answer was left out: no one can answer a run." : "",
    args.wait ? " wait does nothing in a run: your turn goes on; finish with your report." : ""
  ].join("");

  return reply(`Kept: the card is posted to the user before your report once this run succeeds.${notes}`);
}
