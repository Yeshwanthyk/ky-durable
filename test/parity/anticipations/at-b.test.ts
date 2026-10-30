import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Anticipations, anticipateTool } from "../../../src/dreaming/anticipations";
import { DreamNotes, Dreaming } from "../../../src/dreaming/dreaming";
import { Memory } from "../../../src/dreaming/memory";
import { Presence } from "../../../src/dreaming/presence";
import { Proactivity } from "../../../src/dreaming/proactivity";
import { Verdicts } from "../../../src/dreaming/verdicts";
import { Surfaced, type SurfacedKind } from "../../../src/dreaming/surfaced";
import { StoredRow } from "../skills/storage";
import { callTool, dreamOf, HOUR, refusalOf, storageFor } from "./world";

const AtB = Schema.Struct({ at: Schema.Number, schema: Schema.Array(Schema.String), tables: Schema.Record(Schema.String, Schema.Array(StoredRow)), reads: Schema.Unknown });

const atB = Schema.decodeUnknownSync(AtB)(JSON.parse(readFileSync(new URL("at-b.json", import.meta.url), "utf8")));

const said = async <A>(work: () => A) => {
  const outcome = await refusalOf(work);

  return "ok" in outcome ? { said: outcome.ok } : outcome;
};

const SHOWN: readonly (readonly [SurfacedKind, string])[] = [
  ["recall", "1#4"],
  ["recall", "1#9"],
  ["look", "look-a"],
  ["post", "p-1"],
  ["post", "none"]
];

describe("anticipations rows written at B", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("open under the port and read as B did", async () => {
    const now = atB.at;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const db = new DatabaseSync(":memory:");

    for (const statement of atB.schema) db.exec(statement);

    for (const [table, rows] of Object.entries(atB.tables)) {
      for (const row of rows) {
        const columns = Object.keys(row);
        const values: SQLInputValue[] = Object.values(row);
        db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
      }
    }

    const memory = new Memory(storageFor(db), () => Promise.reject(new Error("no compressor")));
    const anticipations = new Anticipations(storageFor(db), memory, (session) => session === "1" || session === "2");
    const surfaced = new Surfaced(storageFor(db));
    const proactivity = new Proactivity(storageFor(db));
    const presence = new Presence(storageFor(db));
    const notes = new DreamNotes(storageFor(db), (session) => session === "7");
    const world = { db, memory, seen: { closed: 0, changed: 0, later: [], cards: [], sessions: 0 }, said: [], answered: true, checkInsOn: false };
    const dreaming = new Dreaming(storageFor(db), { ...dreamOf(world), anticipations, presence, surfaced, verdicts: new Verdicts(storageFor(db)) });

    const tool = anticipateTool(
      anticipations,
      (session) => (session === "1" ? "user" : "dream"),
      () => undefined,
      () => false
    );

    const terms = ["lease", "lisbon", "tea"];

    const reads = {
      open: anticipations.open(),
      get: await Promise.all([1, 2, 3, 4, 5, 6, 7, 8, 9, 99].map((id) => said(() => anticipations.get(id)))),
      match: anticipations.match(terms, now, 5),
      recallable: anticipations.recallable(terms, now, 5),
      due: anticipations.due(now, now + 48 * HOUR),
      list: await callTool(tool, "7", { action: "list" }),
      listAbout: await callTool(tool, "7", { action: "list", about: "lisbon lease" }),
      listHours: await callTool(tool, "7", { action: "list", hours: 48 }),
      surfaced: {
        outcomes: SHOWN.map(([kind, item]) => surfaced.outcomeOf(kind, item) ?? "absent"),
        items: surfaced.items("recall", "1#", 0, 5),
        lastShown: [...surfaced.lastShown("recall")]
      },
      proactivity: proactivity.view(),
      presence: presence.last(),
      notes: await said(() => notes.check("7")),
      mark: dreaming.mark(),
      digest: dreaming.digest(dreaming.mark())
    };

    expect(JSON.stringify(reads, null, 2)).toBe(JSON.stringify(atB.reads, null, 2));
    db.close();
  });
});
