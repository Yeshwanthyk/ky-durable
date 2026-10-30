import type { AssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Conversation, defineExtension, type Extension, GenerationTask, hook } from "@earendil-works/pi-durable";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AUTOMATION_SOURCE, type TaskRow } from "../automations/contract";
import { type Edge, makeEdge } from "../core/edge";
import type { Result } from "../core/refusal";
import { lookPost } from "../core/transcript";
import { Sql } from "../core/sql";
import type { Purpose } from "../settings/contract";
import { BACKGROUND_SOURCE, type ReviewKind } from "../skills/contract";
import type { BackgroundWork, SpendSource, SpendView, Usage } from "./contract";
import { type CapNotice, Ledger, Zone } from "./spend";

export type Attribution = { readonly purpose: Purpose; readonly source: SpendSource };

export type Whose = {
  readonly chat: (session: string) => boolean;
  readonly review: (session: string) => ReviewKind | undefined;
  readonly task: (session: string) => TaskRow | undefined;
};

const REVIEWS: Readonly<Record<ReviewKind, SpendSource>> = { review: "skill-review", dream: "dream", episode: "episode", look: "look" };


export function attribution(whose: Whose, session: string): Attribution {
  if (whose.chat(session)) return { purpose: "main", source: "chat" };
  const review = whose.review(session);

  if (review !== undefined) return { purpose: "background", source: REVIEWS[review] };
  const task = whose.task(session);

  if (task === undefined) return { purpose: "main", source: "other" };

  if (task.source.startsWith(AUTOMATION_SOURCE)) return { purpose: "worker", source: "automation" };

  if (task.source === BACKGROUND_SOURCE) return { purpose: "background", source: task.worker === "mail" ? "mail" : "peer" };

  return { purpose: "worker", source: "subagent" };
}

const usageOf = (message: AssistantMessage, { purpose, source }: Attribution): Usage => ({
  purpose,
  source,
  provider: message.provider,
  model: message.model,
  tokensIn: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
  tokensOut: message.usage.output,
  costUsd: message.usage.cost.total
});

export class Spend {
  readonly #edge: Edge<Ledger>;

  constructor(storage: DurableObjectStorage, zone: () => string | null, clock?: Clock.Clock) {
    const layer = Ledger.layer.pipe(Layer.provide(Layer.mergeAll(Sql.layer(storage), Layer.succeed(Zone)({ zone }))));

    this.#edge = makeEdge(clock ? layer.pipe(Layer.provide(Layer.succeed(Clock.Clock)(clock))) : layer);
    this.#edge.run(Effect.void);
  }

  record(usage: Usage): void {
    this.#edge.run(Ledger.use((ledger) => ledger.record(usage)));
  }

  view(): SpendView {
    return this.#edge.run(Ledger.use((ledger) => ledger.view));
  }

  setCap(usd: number | null): Result<SpendView> {
    return this.#edge.run(Ledger.use((ledger) => ledger.setCap(usd)));
  }

  /** Whether unasked work may start now; over the daily cap it may not, and why is kept once a day for each kind. */
  allows(work: BackgroundWork): boolean {
    return this.#edge.run(Ledger.use((ledger) => ledger.allows(work)));
  }

  /** The cap's notice for the user's chat, once a day while over it. */
  notice(): CapNotice | undefined {
    return this.#edge.run(Ledger.use((ledger) => ledger.notice));
  }
}

/** Over the cap, the user's chat says so once a day, above their message; their chat itself keeps working. */
export async function noticeIn(spend: Spend, conversation: Pick<Conversation, "submit">): Promise<void> {
  const notice = spend.notice();

  if (notice) await conversation.submit({ type: "write", entry: lookPost(notice.text, notice.at), requestId: `spend-cap:${notice.day}` }, BACKGROUND_CONTEXT);
}

type Meters = {
  readonly answers: (listener: (purpose: Purpose, answer: AssistantMessage) => void) => () => void;
  readonly spent: (listener: (task: TaskRow, costUsd: number) => void) => () => void;
};

/** A direct ask's answer, and what a machine reports a task cost, into the ledger; pi's own answers come through spendExtension. */
export function meter(spend: Spend, { answers, spent }: Meters): void {
  answers((purpose, answer) => spend.record(usageOf(answer, { purpose, source: "call" })));
  spent((task, costUsd) => {
    if (task.kind !== "machine") return;
    const source = task.source.startsWith(AUTOMATION_SOURCE) ? "automation" : "machine-task";

    spend.record({ purpose: "worker", source, provider: task.agent ?? "machine", model: "", tokensIn: 0, tokensOut: 0, costUsd });
  });
}

/** Every model answer pi gets, in any conversation, goes into the ledger by who it was for. */
export function spendExtension(spend: Spend, whose: Whose): Extension {
  return defineExtension({
    name: "spend",
    hooks: [
      hook(GenerationTask, {
        afterResponse(message, api) {
          spend.record(usageOf(message, attribution(whose, String(api.conversationId))));
        }
      })
    ]
  });
}
