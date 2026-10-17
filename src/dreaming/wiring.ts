import type { History } from "../history";
import type { ReviewHost, Reviews } from "../skills/contract";
import { type Actor, anticipateTool, type Anticipations } from "./anticipations";
import { episodeExtension } from "./episodes";
import type { Brief } from "./brief";
import { memoryExtension, type Memory } from "./memory";
import type { Proactivity } from "./proactivity";
import type { Proposals } from "./proposals";
import { type Recall, recallExtension } from "./recall";
import { soulExtension, type Soul } from "./soul";

/** What the agent (src/server.ts) and other domains run: the dreaming domain's classes. */
export { Anticipations } from "./anticipations";

export { Brief } from "./brief";

export { dreamCron, Dreaming } from "./dreaming";

export { DreamLedger } from "./ledger";

export { Memory } from "./memory";

export { Presence } from "./presence";

export { Proactivity } from "./proactivity";

export { Proposals } from "./proposals";

export { Recall } from "./recall";

export { Soul, TEMPLATE } from "./soul";

export { Surfaced } from "./surfaced";

/** What the dreaming domain's tools are made from, on the agent (src/server.ts). */
export type DreamingWiring = {
  readonly soul: Soul;
  readonly memory: Memory;
  readonly anticipations: Anticipations;
  readonly brief: Brief;
  /** Automations the dream suggests, through the anticipate tool's propose action. */
  readonly proposals: Proposals;
  /** Turn-start recall: what is known about a user's message, appended to the request's copy of it. */
  readonly recall: Recall;
  readonly history: History;
  readonly reviews: Reviews;
  /** The main chat or a side chat. */
  readonly chat: (session: string) => boolean;
  /** Where episode reflections run and report, and the store their count reads (src/dreaming/episodes.ts). */
  readonly sql: SqlStorage;
  readonly background: ReviewHost;
  /** Tool calls that make a turn busy enough for a skill review, and so for an episode reflection. */
  readonly busyAfter: () => number;
  /** Settings › Proactivity: off starts no episode reflection. */
  readonly proactivity: Proactivity;
};

/** SOUL.md's tool and sections, memory's, the episode reflections after chat turns and turn-start recall; the agent installs them, soul first. */
export function dreamingTools({ soul, memory, anticipations, brief, proposals, recall, history, reviews, chat, sql, background, busyAfter, proactivity }: DreamingWiring) {
  // A dream's and an episode's rows are a machine's to prune; anything else that may call it (the main chat, a side chat) acts for the user.
  const actor = (session: string): Actor => {
    const kind = reviews.kind(session);

    return kind === "dream" || kind === "episode" ? kind : "user";
  };

  // An episode's evidence must come from the stretch of its chat its fork read.
  const anticipate = anticipateTool(anticipations, { brief, proposals }, actor, (session) => reviews.window(session));

  return {
    soul: soulExtension(soul),
    // Reviews, dreams and episodes remember too: a fork keeps the memory its chat showed, and a dream wakes with it.
    memory: memoryExtension(memory, history, (session) => chat(session) || reviews.has(session), anticipate),
    episodes: episodeExtension({ sql, reviews, host: background, chat, busyAfter, proactivity }),
    recall: recallExtension(recall)
  };
}
