import type { MachineInfo, TaskRow } from "../protocol";
import { duration } from "./duration";

/** How long a working task may go without a step before the card says it has gone quiet. */
const QUIET_AFTER_MS = 3 * 60_000;

export const isLive = (task: TaskRow) => task.status === "queued" || task.status === "working";

/** What the task is doing now: its newest step, while it is live. */
export const currentStep = (task: TaskRow) => (isLive(task) ? task.steps.at(-1)?.text : undefined);

/** How long it has run: to now while it is live, to its finish once it is over. */
export function elapsed(task: TaskRow, now: number): string | null {
  if (task.started_at === null) return null;

  return duration((task.finished_at ?? now) - task.started_at);
}

/** Its machine is offline, so it cannot report until it comes back. */
function offline(task: TaskRow, machines: readonly MachineInfo[]): boolean {
  return task.kind === "machine" && machines.some((machine) => machine.name === task.worker && !machine.online);
}

/** When the task last said anything: its newest step, else when it started. */
const heardAt = (task: TaskRow) => task.steps.at(-1)?.at ?? task.started_at ?? task.updated_at;

/** "Quiet for 4m" once a task has said nothing for a while. */
function quietFor(task: TaskRow, now: number): string | null {
  const silent = now - heardAt(task);

  return silent >= QUIET_AFTER_MS ? `Quiet for ${Math.floor(silent / 60_000)}m` : null;
}

/** A warning for a working task that has stopped saying anything: its machine is gone, or it has been quiet a while. */
export function quietNote(task: TaskRow, machines: readonly MachineInfo[], now: number): string | null {
  if (task.status !== "working") return null;

  return offline(task, machines) ? "Machine offline" : quietFor(task, now);
}

const turnsOf = (turns: number | null) => (turns === null ? null : `${turns} ${turns === 1 ? "turn" : "turns"}`);

/** Dollars, to the cent, or to a tenth of one below a cent. */
const dollars = (cost: number | null) => (cost ? `$${cost.toFixed(cost < 0.01 ? 3 : 2)}` : null);

/** What a finished task cost, quietly: how long, how many model turns, and how much. */
export function spendLine(task: TaskRow, now: number): string {
  return [elapsed(task, now), turnsOf(task.turns), dollars(task.cost_usd)].filter((part) => part !== null).join(" · ");
}

/** The newest step of the work going on in the background, for the topbar: "webmac: Editing x.ts". */
export function backgroundLine(tasks: readonly TaskRow[]): string | null {
  const live = tasks.filter((task) => task.status === "working" && task.steps.length > 0);
  const newest = live.toSorted((a, b) => b.steps.at(-1)!.at - a.steps.at(-1)!.at)[0];

  if (newest === undefined) return null;

  const others = tasks.filter((task) => task.status === "working").length - 1;

  return `${newest.worker}: ${newest.steps.at(-1)!.text}${others > 0 ? ` · ${others} more` : ""}`;
}
