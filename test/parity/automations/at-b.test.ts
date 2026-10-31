import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import type { SQLInputValue } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Json } from "../kit";
import { port, schedulerOf, World } from "./world";

const Booking = Schema.Union([
  Schema.Struct({ id: Schema.String, callback: Schema.String, payload: Schema.optionalKey(Schema.Unknown), type: Schema.Literal("scheduled"), time: Schema.Number }),
  Schema.Struct({ id: Schema.String, callback: Schema.String, payload: Schema.optionalKey(Schema.Unknown), type: Schema.Literal("cron"), time: Schema.Number, cron: Schema.String })
]);

const StoredRow = Schema.Record(Schema.String, Schema.NullOr(Schema.Union([Schema.String, Schema.Number])));

const AtB = Schema.Struct({
  at: Schema.Number,
  schema: Schema.Array(Schema.String),
  tables: Schema.Record(Schema.String, Schema.Array(StoredRow)),
  bookings: Schema.Array(Booking),
  reads: Schema.Unknown
});

const atB = Schema.decodeUnknownSync(AtB)(JSON.parse(readFileSync(new URL("at-b.json", import.meta.url), "utf8")));

function normalize(observed: Json): Json {
  if (Array.isArray(observed)) return observed.map(normalize);

  if (!(observed instanceof Object)) return observed;

  return Object.fromEntries(
    Object.entries(observed)
      .filter(([key]) => key !== "gate_found" && key !== "gate_found_by" && key !== "owner")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, value === undefined ? value : normalize(value)])
  );
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
});

describe("automation rows written at B", () => {
  it("open under the port and read as B read them", async () => {
    const world = new World({ now: () => atB.at });

    for (const { name } of world.rows("SELECT name FROM sqlite_master WHERE type = 'table'")) world.db.exec(`DROP TABLE ${String(name)}`);

    for (const statement of atB.schema.filter((each) => !each.includes("sqlite_sequence"))) world.db.exec(statement);

    for (const [table, rows] of Object.entries(atB.tables)) {
      for (const row of rows) {
        const columns = Object.keys(row);
        const values: SQLInputValue[] = Object.values(row);
        world.db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
      }
    }

    const automations = port(world, world.deps());
    schedulerOf(automations).restore(atB.bookings.map((booking) => ({ ...booking, payload: booking.payload })));
    const ids = world.rows("SELECT id FROM ky_automations ORDER BY id").map((row) => String(row.id));
    const tasks = world.rows("SELECT id FROM ky_tasks ORDER BY id").map((row) => String(row.id));

    const reads = await world.in(async () => ({
      list: await automations.list(true),
      listActive: await automations.list(false),
      get: ids.map((id) => automations.get(id) ?? null),
      watches: automations.watches(),
      checkIns: automations.checkIns(),
      chatLabel: ["1", "5"].map((chat) => automations.chatLabel(chat)),
      checkInRun: automations.checkInRun("77"),
      wanted: tasks.map((task) => ({ task, wanted: automations.wanted(task) }))
    }));

    // B had no owners: every automation it stored is ky's.
    expect([...reads.list, ...reads.get].map((row) => row?.owner)).toEqual([...reads.list, ...reads.get].map(() => "ky"));
    // SAFETY: the reads are rows of JSON values, and so are B's.
    expect(normalize(JSON.parse(JSON.stringify(reads)) as Json)).toEqual(normalize(atB.reads as Json));
    world.db.close();
  });
});
