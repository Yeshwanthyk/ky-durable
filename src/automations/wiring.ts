import type { Models } from "../models";
import type { Reviews } from "../skills/contract";
import { automationExtension, type Automations, checkInGuardExtension } from "./automations";

/** The domain's classes, for server.ts to make: the contract carries only their types. */
export { Automations } from "./automations";

export { Deliveries, deliveryExtension } from "./delivery";

export { TaskFeed } from "./tasks";

/** What the automations domain's tools are made from, on the agent (src/server.ts). */
export type AutomationsWiring = {
  readonly automations: Automations;
  readonly models: Models;
  readonly reviews: Reviews;
};

/** The automation tool, and the guard that keeps a check-in to its tools. */
export function automationTools({ automations, models, reviews }: AutomationsWiring) {
  return {
    automations: automationExtension(
      automations,
      () => models.resolve("worker").choice,
      (session) => reviews.kind(session) === "dream"
    ),
    checkInGuard: checkInGuardExtension(automations)
  };
}
