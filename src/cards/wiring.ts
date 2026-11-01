import { defineDoc, defineExtension, defineTool, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEdge } from "../core/edge";
import { isRefusal } from "../core/refusal";
import { toolReply as reply } from "../core/reply";
import { NoOneToShow, NothingToAnswer, type UiCardArgs, UiCardInput } from "./contract";

const UI = "ui";

const INTERACTIVE = new Set(["choice", "input", "buttons"]);

type RunCardsDoc = { run: boolean; cards: Array<{ call: string; card: string }> };

export const RunCards = defineDoc<RunCardsDoc>({
  kind: "run-cards",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ run: false, cards: [] })
});

const asks = (card: UiCardArgs) => card.blocks.some((block) => INTERACTIVE.has(block.type));

function show(card: UiCardArgs): Effect.Effect<ToolExecutionResult, NothingToAnswer> {
  if (!card.wait) return Effect.succeed(reply(asks(card) ? "Shown to the user; their answer, if any, arrives as a later message." : "Shown to the user."));

  if (!asks(card)) return Effect.fail(new NothingToAnswer());

  return Effect.succeed({ ...reply("Shown to the user. Your turn ends here; their answer arrives as their next message."), control: { terminate: true } });
}

function keep(doc: RunCardsDoc, call: string, { wait, ...card }: UiCardArgs): Effect.Effect<ToolExecutionResult, NoOneToShow> {
  if (!doc.run) return Effect.fail(new NoOneToShow());

  if (!doc.cards.some((each) => each.call === call)) doc.cards.push({ call, card: JSON.stringify(card) });
  const answers = asks(card) ? " The user answers it in that chat, later, not to this run." : "";
  const waits = wait === true ? " wait does nothing in a run: your turn goes on; finish with your report." : "";

  return Effect.succeed(reply(`Kept: the card is posted to the user before your report once this run succeeds.${answers}${waits}`));
}

export function uiExtension(chat: (session: string) => boolean): Extension {
  const edge = makeEdge(Layer.empty);
  const replied = (result: ToolExecutionResult | { readonly refused: string }) => (isRefusal(result) ? reply(result.refused, true) : result);

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
        parameters: UiCardInput,
        replay: "safe",
        execute: async (args, api, context) => {
          if (chat(String(api.conversationId))) return replied(edge.run(show(args)));

          return replied(await api.commit(async (tx) => edge.run(keep(await tx.doc(RunCards, api.conversationId), api.callId, args)), context));
        }
      })
    ]
  });
}
