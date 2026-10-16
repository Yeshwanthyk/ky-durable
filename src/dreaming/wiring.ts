import type { History } from "../history";
import type { Reviews } from "../skills/contract";
import { anticipateTool, type Anticipations } from "./anticipations";
import type { Brief } from "./brief";
import { memoryExtension, type Memory } from "./memory";
import { soulExtension, type Soul } from "./soul";

/** What the agent (src/server.ts) and other domains run: the dreaming domain's classes. */
export { Anticipations } from "./anticipations";

export { Brief } from "./brief";

export { dreamCron, Dreaming } from "./dreaming";

export { DreamLedger } from "./ledger";

export { Memory } from "./memory";

export { Presence } from "./presence";

export { Proactivity } from "./proactivity";

export { Soul, TEMPLATE } from "./soul";

export { Surfaced } from "./surfaced";

/** What the dreaming domain's tools are made from, on the agent (src/server.ts). */
export type DreamingWiring = {
  readonly soul: Soul;
  readonly memory: Memory;
  readonly anticipations: Anticipations;
  readonly brief: Brief;
  readonly history: History;
  readonly reviews: Reviews;
  /** The main chat or a side chat. */
  readonly chat: (session: string) => boolean;
};

/** SOUL.md's tool and sections, and memory's; the agent installs them, soul first. */
export function dreamingTools({ soul, memory, anticipations, brief, history, reviews, chat }: DreamingWiring) {
  // A dream's rows are the dream's to prune; anything else that may call it (the main chat, a side chat) acts for the user.
  const anticipate = anticipateTool(anticipations, brief, (session) => (reviews.kind(session) === "dream" ? "dream" : "user"));

  return {
    soul: soulExtension(soul),
    // Reviews and dreams remember too: a review fork keeps the memory its chat showed, and a dream wakes with it.
    memory: memoryExtension(memory, history, (session) => chat(session) || reviews.has(session), anticipate)
  };
}
