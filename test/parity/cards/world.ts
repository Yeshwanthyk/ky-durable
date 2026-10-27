import type { Context, JsonValue } from "@earendil-works/chord";
import type { ConversationDocToken, ConversationId, JsonObject, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { uiExtension } from "../../../src/cards/wiring";

export type Where = "main" | "run" | "aside";

const IDS: Record<Where, number> = { main: 1, run: 2, aside: 3 };

type Docs = Partial<Record<Where, { run: boolean; cards: Array<{ call: string; card: string }> }>>;

export function world() {
  let docs: Docs = { run: { run: true, cards: [] } };
  const tool = uiExtension((session) => session === String(IDS.main)).tools?.[0];

  if (tool === undefined) throw new Error("the ui extension has no tool");

  const call = async (where: Where, callId: string, card: JsonValue) => {
    const next = structuredClone(docs);

    const api: Pick<ToolExecutionApi, "conversationId" | "callId" | "commit"> = {
      // SAFETY: the world's three conversations are numbered as pi numbers them.
      conversationId: IDS[where] as ConversationId,
      callId,
      commit: async <T>(change: (tx: Tx) => T | Promise<T>) => {
        // SAFETY: the ui tool's commit reads one doc, its RunCards, by conversation; a fresh one is not a run.
        const tx = { doc: async (_token: ConversationDocToken<JsonObject>, _conversation: ConversationId) => (next[where] ??= { run: false, cards: [] }) } as Tx;
        const result = await change(tx);

        docs = next;

        return result;
      }
    };

    // SAFETY: the ui tool reads conversationId and callId and calls commit; the harness checked the card against its parameters.
    return tool.execute(card as never, api as ToolExecutionApi, {} as Context);
  };

  return { docs: () => docs, call };
}
