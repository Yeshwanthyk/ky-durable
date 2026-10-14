import type { History } from "../history";
import type { Reviews } from "../skills/skills";
import { memoryExtension, type Memory } from "./memory";
import { soulExtension, type Soul } from "./soul";

/** What the dreaming domain's tools are made from, on the agent (src/server.ts). */
export type DreamingWiring = {
  readonly soul: Soul;
  readonly memory: Memory;
  readonly history: History;
  readonly reviews: Reviews;
  /** The main chat or a side chat. */
  readonly chat: (session: string) => boolean;
};

/** SOUL.md's tool and sections, and memory's; the agent installs them, soul first. */
export function dreamingTools({ soul, memory, history, reviews, chat }: DreamingWiring) {
  return {
    soul: soulExtension(soul),
    // Reviews and dreams remember too: a review fork keeps the memory its chat showed, and a dream wakes with it.
    memory: memoryExtension(memory, history, (session) => chat(session) || reviews.has(session))
  };
}
