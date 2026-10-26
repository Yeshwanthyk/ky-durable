import * as Schema from "effect/Schema";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { PROTOCOL, WIRE } from "../../src/machines/contract";

const SHIPPED = {
  3: "11ecd029f0034a2f",
  4: "ec835234f6de543c"
} as const satisfies Record<number, string>;

it("changes the runner's wire only with a PROTOCOL bump", () => {
  const hash = createHash("sha256").update(JSON.stringify(Object.entries(WIRE).map(([name, schema]) => [name, Schema.toRepresentation(schema)]))).digest("hex").slice(0, 16);

  expect(hash, `The runner's wire changed under PROTOCOL ${PROTOCOL}: bump it in src/machines/runner-protocol.ts and pin ${hash} to the new number here.`).toBe(SHIPPED[PROTOCOL]);
});
