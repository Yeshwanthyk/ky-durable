import { readFileSync } from "node:fs";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { FakeExecutor } from "../../../src/tests/fake-executor";
import { AGENT, FakeVault, next, TOKEN } from "./world";

const Reads = Schema.Struct({
  config: Schema.NullOr(Schema.Struct({ url: Schema.String, token: Schema.String, fetch: Schema.Boolean })),
  view: Schema.Struct({ url: Schema.NullOr(Schema.String) })
});

const Case = Schema.Struct({
  name: Schema.String,
  rows: Schema.Record(Schema.String, Schema.Struct({ value: Schema.MutableJson, meta: Schema.MutableJson })),
  reads: Reads
});

const atB = Schema.decodeUnknownSync(Schema.Struct({ commit: Schema.Literal("b658a6e"), cases: Schema.Array(Case) }))(
  JSON.parse(readFileSync(new URL("at-b.json", import.meta.url), "utf8"))
);

describe("executor connections saved at B", () => {
  it.each(atB.cases.map((recorded) => [recorded.name, recorded] as const))("%s: reads as B read it", async (_, recorded) => {
    const vault = new FakeVault();

    vault.rows.clear();

    for (const [key, row] of Object.entries(recorded.rows)) vault.rows.set(key, row);
    const reach = new FakeExecutor(TOKEN).fetch;
    const link = next.link(vault.vault, AGENT, reach);
    const config = await link.config();

    expect({ config: config === null ? null : { url: config.url, token: config.token, fetch: config.fetch === reach }, view: await link.view() }).toEqual(recorded.reads);
  });

  it("keeps a connection saved at B working: the port retargets it with B's token", async () => {
    const saved = atB.cases.find((recorded) => recorded.name === "connected");
    const vault = new FakeVault();

    vault.rows.clear();

    for (const [key, row] of Object.entries(saved?.rows ?? {})) vault.rows.set(key, row);
    const link = next.link(vault.vault, AGENT, new FakeExecutor(TOKEN).fetch);

    expect(await link.retarget("https://executor.test/v2/mcp")).toEqual({});
    expect(vault.writes).toEqual([{ put: "executor", id: AGENT, value: { url: "https://executor.test/v2/mcp", token: TOKEN }, meta: { url: "https://executor.test/v2/mcp" } }]);
  });
});
