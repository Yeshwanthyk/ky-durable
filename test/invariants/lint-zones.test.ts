import { readFileSync } from "node:fs";
import path from "node:path";
import Type from "typebox";
import { expect, it } from "vitest";
import { parseAs } from "../../src/core/decode";

/**
 * Folders and files held to every lint rule with no allowance: the shared core, each domain, and the
 * edges that read what comes from outside (the socket's two ends, settings, images, GitHub's answers,
 * a backup). lint-baseline.json may carry old findings elsewhere while they are paid down, never here,
 * so no `any`, unchecked cast, `!` or raw parse enters a contract or an edge.
 */
const ZERO = [
  "src/core/",
  "src/dreaming/",
  "src/peers/",
  "src/skills/",
  "src/automations/",
  "src/machines/",
  "src/asks.ts",
  "src/backup.ts",
  "src/chats-tool.ts",
  "src/client-messages.ts",
  "src/github-tools.ts",
  "src/images.ts",
  "src/protocol.ts",
  "src/server-frames.ts",
  "src/settings.ts",
  "src/sockets.ts",
  "src/tables.ts"
];

const Baseline = Type.Record(Type.String(), Type.Record(Type.String(), Type.Integer()));

const baseline = parseAs(Baseline, readFileSync(path.join(import.meta.dirname, "../../lint-baseline.json"), "utf8"), "lint-baseline.json");

it.each(ZERO)("allows no lint findings in %s", (zone) => {
  expect(Object.keys(baseline).filter((file) => file.startsWith(zone))).toEqual([]);
});
