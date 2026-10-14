import type { TaskFeed } from "../automations/tasks";
import { machineExtension, MachineHub } from "./machines";

/** The hub, for src/server.ts to make: the one runtime export of machines.ts outside the domain. */
export { MachineHub };

/** What the machines domain's tools are made from, on the agent (src/server.ts). */
export type MachinesWiring = {
  readonly machines: MachineHub;
  readonly feed: TaskFeed;
};

/** The machine tool. */
export function machineTools({ machines, feed }: MachinesWiring) {
  return { machines: machineExtension(machines, feed) };
}
