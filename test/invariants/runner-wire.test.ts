import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { PROTOCOL, WIRE } from "../../src/machines/contract";

/**
 * Each PROTOCOL's wires, oldest first. A change either side of a runner that hasn't been upgraded can't
 * read takes a bump; a field added as an optional key, which an older side drops unread and a newer
 * one goes without, may join its PROTOCOL's list instead, when a fact the runner reports in its hello
 * says whether it has the field (`models` says a runner pins a run's model).
 */
const SHIPPED = {
  3: ["11ecd029f0034a2f"],
  4: ["ec835234f6de543c", "60548f3de57e990b"]
} as const satisfies Record<number, readonly string[]>;

it("changes the runner's wire only with a PROTOCOL bump", () => {
  const hash = createHash("sha256").update(JSON.stringify(Object.entries(WIRE).map(([name, schema]) => [name, Schema.toRepresentation(schema)]))).digest("hex").slice(0, 16);

  expect(hash, `The runner's wire changed under PROTOCOL ${PROTOCOL}: bump it in src/machines/runner-protocol.ts and pin ${hash} to the new number here.`).toBe(SHIPPED[PROTOCOL].at(-1));
});
