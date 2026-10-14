import { readFileSync } from "node:fs";
import path from "node:path";
import Type from "typebox";
import { expect, it } from "vitest";
import { parseAs } from "../../src/core/decode";

/**
 * Folders held to every lint rule with no allowance: the shared core, and each domain once it moves
 * into its folder. lint-baseline.json may carry old findings elsewhere while they are paid down,
 * never here, so no `any`, unchecked cast, `!` or raw parse enters a contract.
 */
const ZERO = ["src/core/", "src/dreaming/", "src/peers/", "src/skills/", "src/automations/", "src/machines/"];

const Baseline = Type.Record(Type.String(), Type.Record(Type.String(), Type.Integer()));

const baseline = parseAs(Baseline, readFileSync(path.join(import.meta.dirname, "../../lint-baseline.json"), "utf8"), "lint-baseline.json");

it.each(ZERO)("allows no lint findings in %s", (zone) => {
  expect(Object.keys(baseline).filter((file) => file.startsWith(zone))).toEqual([]);
});
