import { readFileSync } from "node:fs";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { next, START, World } from "./world";

const Cell = Schema.NullOr(Schema.Union([Schema.String, Schema.Number]));

const Choice = Schema.Struct({ provider: Schema.String, modelId: Schema.String, thinkingLevel: Schema.String });

const Case = Schema.Struct({
  name: Schema.String,
  tunnel: Schema.Boolean,
  machines: Schema.Record(Schema.String, Schema.Struct({ online: Schema.Boolean, shares: Schema.Boolean })),
  tables: Schema.Struct({ ky_providers: Schema.Array(Schema.Record(Schema.String, Cell)), ky_purposes: Schema.Array(Schema.Record(Schema.String, Cell)) }),
  vault: Schema.Record(Schema.String, Schema.Struct({ apiKey: Schema.String })),
  reads: Schema.Struct({
    providers: Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String, name: Schema.String })),
    purposes: Schema.Record(Schema.String, Choice),
    worker: Choice
  })
});

const atB = Schema.decodeUnknownSync(Schema.Struct({ commit: Schema.Literal("b658a6e"), cases: Schema.Array(Case) }))(
  JSON.parse(readFileSync(new URL("at-b.json", import.meta.url), "utf8"))
);

function saved(recorded: (typeof atB.cases)[number]): World {
  const world = new World(next, { now: () => START });

  for (const [table, rows] of Object.entries(recorded.tables)) {
    world.db.exec(`DELETE FROM ${table}`);

    for (const row of rows) {
      const columns = Object.keys(row);

      world.db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
    }
  }

  for (const [name, state] of Object.entries(recorded.machines)) world.machines.set(name, { ...state });

  for (const [id, key] of Object.entries(recorded.vault)) world.keys.set(id, key);
  world.tunnel = recorded.tunnel;
  world.models = world.boot();

  return world;
}

describe("providers saved at B", () => {
  it.each(atB.cases.map((recorded) => [recorded.name, recorded] as const))("%s: reads as B read it", async (_, recorded) => {
    const world = saved(recorded);
    const { models } = world;

    expect({
      providers: models.catalog().map(({ id, kind, name }) => ({ id, kind, name })),
      purposes: Object.fromEntries((["main", "worker", "background", "fallback"] as const).map((purpose) => [purpose, models.resolve(purpose).choice])),
      worker: models.worker(null)
    }).toEqual(recorded.reads);
    expect(world.tables()).toEqual({ ...recorded.tables, ky_purposes: [...recorded.tables.ky_purposes].sort((a, b) => String(a.purpose).localeCompare(String(b.purpose))) });
  });

  it("keeps a key saved at B working: its provider answers with B's key", async () => {
    const recorded = atB.cases.find((each) => each.name === "one key");
    const world = saved(recorded!);
    const answer = await world.apply({ kind: "ask", purpose: "main", text: "hello", maxTokens: 16 });

    expect(answer).toMatchObject({ provider: "anthropic", text: "hi" });
    expect(world.calls.at(-1)?.headers["x-api-key"]).toBe(recorded?.vault.anthropic?.apiKey);
  });
});
