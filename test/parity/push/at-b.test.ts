import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pushes } from "../../../src/push/wiring";
import { storageOf, StoredRow } from "../skills/storage";
import { answering, readsOf, ROWS } from "./reads";

const Device = Schema.Struct({ endpoint: Schema.String, p256dh: Schema.String, auth: Schema.String });

const AtB = Schema.Struct({ now: Schema.Number, again: Device, schema: Schema.Array(Schema.String), tables: Schema.Record(Schema.String, Schema.Array(StoredRow)), reads: Schema.Unknown });

const atB = Schema.decodeUnknownSync(AtB)(JSON.parse(readFileSync(new URL("at-b.json", import.meta.url), "utf8")));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("push rows written at B", () => {
  it("open under the port and push, count and keep as B did", async () => {
    vi.spyOn(Date, "now").mockImplementation(() => atB.now);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = new DatabaseSync(":memory:");

    for (const statement of atB.schema) db.exec(statement);

    for (const [table, rows] of Object.entries(atB.tables)) {
      for (const row of rows) {
        const columns = Object.keys(row);
        const values: SQLInputValue[] = Object.values(row);
        db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
      }
    }

    const answers = answering();

    const pushes = new Pushes(storageOf(db), {
      vault: () => ({ vapidKey: async () => "k", vapidAuth: async (audience, subject) => `vapid ${audience} ${subject}` }),
      zone: () => "America/Los_Angeles",
      most: () => 5,
      title: () => "ky",
      origin: () => "https://ky.example.com"
    });

    pushes.fetch = async (input) => {
      answers.tried.push(String(input));

      return new Response(null, { status: answers.status(String(input)) });
    };

    const reads = await readsOf(pushes, answers, () => ROWS.map((query) => db.prepare(query).all()), atB.again);

    expect(JSON.stringify(reads, null, 2)).toBe(JSON.stringify(atB.reads, null, 2));
    db.close();
  });
});
