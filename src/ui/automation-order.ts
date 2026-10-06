import type { AutomationInfo } from "../protocol";

type Ordered = Pick<AutomationInfo, "status" | "next_run">;

/** When it runs next, or Infinity when it will not: paused, finished or not booked. */
const nextOf = (automation: Ordered) =>
  automation.status === "active" && automation.next_run !== null ? automation.next_run : Number.POSITIVE_INFINITY;

/** Soonest next run first; paused and finished ones last, in the order they came. */
export function byNextRun<T extends Ordered>(automations: readonly T[]): T[] {
  return automations.toSorted((a, b) => {
    const [x, y] = [nextOf(a), nextOf(b)];

    return x === y ? 0 : x < y ? -1 : 1;
  });
}
