import type { TaskFeed } from "../automations/tasks";
import { machineExtension, type MachineHub } from "./machines";

/** What the machines domain's tools are made from, on the agent (src/server.ts). */
export type MachinesWiring = {
  readonly machines: MachineHub;
  readonly feed: TaskFeed;
};

/** The machine tool. */
export function machineTools({ machines, feed }: MachinesWiring) {
  return { machines: machineExtension(machines, feed) };
}
