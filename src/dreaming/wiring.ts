import type { History } from "../history/wiring";
import type { ReviewHost, Reviews } from "../skills/contract";
import { type Actor, anticipateTool, type Anticipations } from "./anticipations";
import { DreamNotes } from "./dreaming";
import { episodeExtension } from "./episodes";
import { memoryExtension, type Memory } from "./memory";
import type { Proactivity } from "./proactivity";
import { type Recall, recallExtension } from "./recall";
import { soulExtension, type Soul } from "./soul";

/** What the agent (src/server.ts) and other domains run: the dreaming domain's classes. */
export { Anticipations } from "./anticipations";

export { dreamCron, Dreaming } from "./dreaming";

export { DreamLedger } from "./ledger";

export { Looks } from "./looks";

export { Memory } from "./memory";

export { Presence } from "./presence";

export { Proactivity } from "./proactivity";

export { Recall } from "./recall";

export { Soul, TEMPLATE } from "./soul";

export { Surfaced } from "./surfaced";

export { Verdicts } from "./verdicts";

export { Versioned, versionLine, Versions } from "./versioned";

/** What the dreaming domain's tools are made from, on the agent (src/server.ts). */
export type DreamingWiring = {
  readonly soul: Soul;
  readonly memory: Memory;
  readonly anticipations: Anticipations;
  /** Turn-start recall: what is known about a user's message, appended to the request's copy of it. */
  readonly recall: Recall;
  readonly history: History;
  readonly reviews: Reviews;
  /** The main chat or a side chat. */
  readonly chat: (session: string) => boolean;
  /** Where episode reflections run and report, and the store their count reads (src/dreaming/episodes.ts). */
  readonly storage: DurableObjectStorage;
  readonly background: ReviewHost;
  /** Tool calls that make a turn busy enough for a skill review, and so for an episode reflection. */
  readonly busyAfter: () => number;
  /** Settings › Proactivity: off starts no episode reflection. */
  readonly proactivity: Proactivity;
};

/** SOUL.md's tool and sections, memory's, the episode reflections after chat turns and turn-start recall; the agent installs them, soul first. */
export function dreamingTools({ soul, memory, anticipations, recall, history, reviews, chat, storage, background, busyAfter, proactivity }: DreamingWiring) {
  // A dream's and an episode's rows are a machine's to prune; anything else that may call it (the main chat, a side chat) acts for the user.
  const actor = (session: string): Actor => {
    const kind = reviews.kind(session);

    return kind === "dream" || kind === "episode" ? kind : "user";
  };

  // An episode's evidence must come from the stretch of its chat its fork read.
  const anticipate = anticipateTool(
    anticipations,
    actor,
    (session) => reviews.window(session),
    (session) => reviews.kind(session) === "look"
  );

  return {
    soul: soulExtension(soul),
    // Reviews, dreams and episodes remember too: a fork keeps the memory its chat showed, and a dream wakes with it.
    memory: memoryExtension(
      memory,
      history,
      (session) => chat(session) || reviews.has(session),
      anticipate,
      new DreamNotes(storage, (session) => reviews.kind(session) === "dream")
    ),
    episodes: episodeExtension({ sql: storage.sql, reviews, host: background, chat, busyAfter, proactivity }),
    recall: recallExtension(recall)
  };
}
