import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Settings } from "../../../src/settings/wiring";
import { storageOf } from "../skills/storage";
import { nearestAtB, readsOf, validOf } from "./reads";

const AtB = Schema.Struct({
  schema: Schema.Array(Schema.String),
  cases: Schema.Array(
    Schema.Struct({
      rows: Schema.Array(Schema.Struct({ purpose: Schema.String, value: Schema.String })),
      reads: Schema.Unknown
    })
  )
});

const atB = Schema.decodeUnknownSync(Schema.fromJsonString(AtB))(readFileSync(new URL("at-b.json", import.meta.url), "utf8"));

const schemaOf = (db: DatabaseSync) =>
  db
    .prepare("SELECT sql FROM sqlite_master WHERE name LIKE 'ky_%' ORDER BY name")
    .all()
    .map((row) => String(row.sql));

describe("purpose rows written at B", () => {
  it("make the table B made", () => {
    const db = new DatabaseSync(":memory:");

    new Settings(storageOf(db), () => undefined);
    expect(schemaOf(db)).toEqual(atB.schema);
    db.close();
  });

  it.each(atB.cases.map((each, index) => [index, each] as const))("open under the port and read as B read them, case %i", (_, { rows, reads }) => {
    const db = new DatabaseSync(":memory:");

    for (const statement of atB.schema) db.exec(statement);

    for (const row of rows) db.prepare("INSERT INTO ky_purposes (purpose, value) VALUES (?, ?)").run(row.purpose, row.value);

    let connected: ReadonlySet<string> = new Set();
    const settings = new Settings(storageOf(db), (choice) => validOf(nearestAtB, connected)(choice));

    expect(
      readsOf((now, purpose) => {
        connected = now;

        return settings.get(purpose);
      })
    ).toEqual(reads);
    db.close();
  });
});
