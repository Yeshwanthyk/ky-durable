import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { PROTOCOL, WIRE } from "../../src/machines/contract";

/**
 * The runner ships through brew, apart from the worker, so an old runner meets a new worker. Each
 * PROTOCOL is pinned to the schemas it shipped with: a change to them needs a bump, and the bump
 * adds its hash here.
 */
const SHIPPED = {
  3: "11ecd029f0034a2f",
  4: "b7f956d8c29576f3"
} as const satisfies Record<number, string>;

it("changes the runner's wire only with a PROTOCOL bump", () => {
  const hash = createHash("sha256").update(JSON.stringify(WIRE)).digest("hex").slice(0, 16);

  expect(hash, `The runner's wire changed under PROTOCOL ${PROTOCOL}: bump it in src/machines/runner-protocol.ts and pin ${hash} to the new number here.`).toBe(SHIPPED[PROTOCOL]);
});
