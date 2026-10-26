import type { Context, JsonValue } from "@earendil-works/chord";
import type { ConversationDocToken, ConversationId, Extension, JsonObject, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import type { Instance, Json } from "../kit";

export type Where = "main" | "run" | "aside";

export type Action =
  | { readonly kind: "draw"; readonly input: string }
  | { readonly kind: "call"; readonly where: Where; readonly call: string; readonly card: JsonValue }
  | { readonly kind: "answer"; readonly data: JsonValue };

export type Side = {
  readonly ui: (chat: (session: string) => boolean) => Extension;
  readonly card: (input: string) => object | null;
  readonly answerOf: (data: JsonValue | undefined) => object | null;
};

const IDS: Record<Where, number> = { main: 1, run: 2, aside: 3 };

type Docs = Partial<Record<Where, { run: boolean; cards: Array<{ call: string; card: string }> }>>;

const json = <T>(value: T): Json => {
  const text = JSON.stringify(value);

  // SAFETY: what the sides answer is plain data; a missing value reads as null.
  return text === undefined ? null : (JSON.parse(text) as Json);
};

export function world(side: Side) {
  let docs: Docs = { run: { run: true, cards: [] } };
  const tool = side.ui((session) => session === String(IDS.main)).tools?.[0];

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

  const instance: Instance<Action> = {
    apply: async (action) => {
      if (action.kind === "draw") return json(side.card(action.input));

      if (action.kind === "answer") return json(side.answerOf(action.data));

      return json(await call(action.where, action.call, action.card));
    },
    tables: async () => json(docs),
    effects: async () => [],
    dispose: async () => {}
  };

  return { instance, docs: () => docs, call };
}
