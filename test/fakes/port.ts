import type { Server } from "node:net";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** The port a fake listening on TCP took. */
export function portOf(server: Server): number {
  const address = server.address();

  if (!Value.Check(Type.Object({ port: Type.Number() }), address)) throw new Error("The fake isn't listening on a port");

  return address.port;
}
