import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Sandboxes } from "../../../src/runners/wiring";
import { storageOf, T } from "./world";

const StoredRow = Schema.Record(Schema.String, Schema.NullOr(Schema.Union([Schema.String, Schema.Number])));

const AtB = Schema.fromJsonString(Schema.Struct({ schema: Schema.Array(Schema.String), tables: Schema.Record(Schema.String, Schema.Array(StoredRow)), reads: Schema.Unknown }));

const atB = Schema.decodeUnknownSync(AtB)(readFileSync(new URL("at-b.json", import.meta.url), "utf8"));

const IDS = ["cloud", "sb-00000001", "sb-00000002", "sb-00000003", "sb-lost", "sb-wreck", "sb-none"];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => "00000009-0000-4000-8000-000000000000");
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const reads = (sandboxes: Sandboxes) => ({
  all: sandboxes.all(),
  live: sandboxes.live(),
  kept: sandboxes.kept(),
  get: IDS.map((id) => sandboxes.get(id) ?? null),
  named: ["cloud", "web", "api", "lost", "wreck", "none"].map((name) => sandboxes.named(name) ?? null),
  owner: ["acme/api", " ACME/Web ", "acme/lost", "acme/none"].map((repo) => sandboxes.owner(repo) ?? null),
  reposFor: IDS.map((id) => sandboxes.reposFor(id))
});

function refusalOf(attempt: () => void): string | null {
  try {
    attempt();

    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("sandbox rows written at B", () => {
  it("open under the port, read as B read them, and take B's writes and refusals", () => {
    vi.setSystemTime(T + 70_000);
    const db = new DatabaseSync(":memory:");

    for (const statement of atB.schema) db.exec(statement);

    for (const [table, rows] of Object.entries(atB.tables)) {
      for (const row of rows) {
        const columns = Object.keys(row);
        const values: SQLInputValue[] = Object.values(row);
        db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
      }
    }

    const sandboxes = new Sandboxes(storageOf(db).storage());
    const before = reads(sandboxes);

    sandboxes.migrate();
    const back = sandboxes.create({ name: "older", repos: ["acme/older"], from: "sb-00000003" }, () => false);
    sandboxes.change("sb-00000001", { repos: ["acme/web"], idleMinutes: null });
    sandboxes.delete("sb-wreck");
    sandboxes.forget("sb-lost");

    const refusals = [
      () => sandboxes.create({ name: "api" }, () => false),
      () => sandboxes.create({ name: "x", repos: ["acme/api"] }, () => false),
      () => sandboxes.change("sb-lost", {}),
      () => sandboxes.forget("sb-00000002")
    ].map(refusalOf);

    const after = { back, ...reads(sandboxes), refusals, seeded: db.prepare("SELECT * FROM ky_sandboxes_seeded").all() };

    expect(JSON.stringify({ before, after }, null, 2)).toBe(JSON.stringify(atB.reads, null, 2));
    db.close();
  });
});
