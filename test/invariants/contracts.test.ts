import { it } from "vitest";

/**
 * The rest of the gate, each made real by the change that builds what it checks. A todo here is a
 * promise with an owner, not a pass.
 */
const PROMISED = [
  // The socket edge: sockets.ts, protocol.ts, use-pi-session.ts.
  "gives every client message type a schema and a handler",
  "answers a message type it doesn't know with an error frame, not a close",
  "handles every server message type in the client",
  "settles every ask on its answer, an error frame, the socket closing or a timeout",
  // Storage: backup.ts and each domain's contract.ts.
  "decodes a corrupt JSON column from a restore to its default",
  "restores only tables a contract names, round-tripping a corrupt cell",
  "migrates idempotently and never drops a table on start",
  // Domains.
  "allows only registered tools in each allowlist",
  "crosses domains only through contract.ts"
];

for (const promise of PROMISED) it.todo(promise);
