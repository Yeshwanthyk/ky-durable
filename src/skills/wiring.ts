import type { Extension } from "@earendil-works/pi-durable";
import type { Automations, Delivery, TaskFeed } from "../automations/contract";
import type { Models } from "../models";
import type { ReviewHost } from "./contract";
import { type Reviews, type Skills, skillsExtension } from "./skills";
import { type Specialists, specialistExtension } from "./specialists";
import { subagentExtension, subagentProgressExtension } from "./subagents";

export { Reviews, Skills } from "./skills";

export { Specialists } from "./specialists";

/** What the skills domain's tools are made from, on the agent (src/server.ts). */
export type SkillsWiring = {
  readonly skills: Skills;
  readonly reviews: Reviews;
  readonly specialists: Specialists;
  readonly feed: TaskFeed;
  readonly models: Models;
  readonly automations: Automations;
  /** Where skill reviews and dreams run and report. */
  readonly background: ReviewHost;
  /** The main chat or a side chat. */
  readonly chat: (session: string) => boolean;
  /** How an automation run's report reaches the user (src/automations/delivery.ts). */
  readonly deliver: (item: Delivery) => Promise<void>;
};

/** The skill tools, with the reviews of busy turns. */
export function skillTools({ skills, reviews, background, chat }: SkillsWiring): Extension {
  return skillsExtension(skills, reviews, background, chat);
}

/** The main agent's own extensions, which subagents and specialists may be given or not. */
export type MainTools = { readonly soul: Extension; readonly memory: Extension; readonly machines: Extension; readonly automations: Extension; readonly ui: Extension; readonly chats: Extension; readonly site: Extension };

/** Specialists, subagents and their progress steps; `spawn` starts a subagent from outside a tool call. */
export function delegationTools(
  { specialists: store, feed, models, automations, chat, deliver }: SkillsWiring,
  { soul, memory, machines, automations: automationTool, ui, chats, site }: MainTools
) {
  const specialists = specialistExtension(store, feed, chat, (feedId) => automations.wanted(feedId));

  const subagents = subagentExtension(
    feed,
    [soul, memory, machines, automationTool, specialists.manage, ui, chats, site],
    // A run's cards are posted with its report (src/ui-tool.ts).
    [ui],
    () => models.resolve("worker").choice,
    models,
    (feedId) => automations.wanted(feedId),
    {
      store,
      tools: specialists,
      // Specialists keep memory (to search it), machines, and the subagent tool (to ask a peer).
      remove: [soul, automationTool, specialists.manage, ui, chats, site],
      model: (own) => models.worker(own)
    },
    deliver
  );

  return { specialists, subagents: subagents.extension, spawn: subagents.spawn, progress: subagentProgressExtension(feed) };
}
