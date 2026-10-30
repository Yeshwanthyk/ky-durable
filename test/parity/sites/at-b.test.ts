import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicSiteRoute, siteExtension, siteRoute } from "../../../src/sites/wiring";
import { readsOf } from "./reads";
import { fakeBucket, fakeFiles, livingOf, requestOf, seededRandom, toolOf } from "./world";

const AtB = Schema.Struct({ objects: Schema.Record(Schema.String, Schema.String), reads: Schema.Unknown });

const atB = Schema.decodeUnknownSync(Schema.fromJsonString(AtB))(readFileSync(new URL("at-b.json", import.meta.url), "utf8"));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sites written at B", () => {
  it("open under the port, read as B read them, and change as B changed them", async () => {
    const bucket = fakeBucket(atB.objects);
    const tool = toolOf(siteExtension(() => true, livingOf(bucket), { fs: fakeFiles({}) }, () => "https://ky.test"));
    seededRandom().use();
    let now = Date.UTC(2025, 6, 1);
    vi.spyOn(Date, "now").mockImplementation(() => (now += 60_000));

    const reads = await readsOf(bucket, tool, requestOf({ siteRoute, publicSiteRoute }, bucket));

    expect(JSON.stringify(reads, null, 2)).toBe(JSON.stringify(atB.reads, null, 2));
  });
});
