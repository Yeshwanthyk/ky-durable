import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { DatabaseSync } from "node:sqlite";
import type { TaskRow } from "../../src/automations/contract";
import { Sql } from "../../src/core/sql";
import { CapRow, LedgerRow, SPEND_TABLES, type Usage } from "../../src/spend/contract";
import { Ledger, Zone } from "../../src/spend/spend";
import { attribution } from "../../src/spend/wiring";
import { storageOf } from "../parity/skills/storage";

const ZONE = "America/Los_Angeles";

function fresh(zone: string | null = ZONE) {
  const db = new DatabaseSync(":memory:");
  const layer = Ledger.layer.pipe(Layer.provide(Layer.mergeAll(Sql.layer(storageOf(db)), Layer.succeed(Zone)({ zone: () => zone }))));

  return { db, layer };
}

const use = (cost: number, over: Partial<Usage> = {}): Usage => ({
  purpose: "main",
  source: "chat",
  provider: "anthropic",
  model: "claude",
  tokensIn: 100,
  tokensOut: 10,
  costUsd: cost,
  ...over
});

const at = (iso: string) => TestClock.setTime(Date.parse(iso));

describe("the spend ledger", () => {
  it.effect("adds each call to the day it was made on in the user's zone, and the month to that day's", () => {
    const { layer } = fresh();

    return Effect.gen(function* () {
      const ledger = yield* Ledger;

      // 23:30 on the 29th in Los Angeles, though the 30th in UTC.
      yield* at("2026-10-30T06:30:00Z");
      yield* ledger.record(use(1));
      expect((yield* ledger.view).day).toBe("2026-10-29");

      // 00:30 on the 30th there: a new day, the same month.
      yield* at("2026-10-30T07:30:00Z");
      yield* ledger.record(use(2));
      yield* ledger.record(use(0.25, { provider: "openai", model: "gpt" }));
      yield* ledger.record(use(0.5, { purpose: "background", source: "look" }));

      const today = yield* ledger.view;

      expect(today.day).toBe("2026-10-30");
      expect(today.today).toEqual({ costUsd: 2.75, tokensIn: 300, tokensOut: 30, calls: 3 });
      expect(today.month.costUsd).toBe(3.75);
      expect(today.lines.map((line) => [line.purpose, line.source, line.costUsd, line.calls])).toEqual([
        ["main", "chat", 2.25, 2],
        ["background", "look", 0.5, 1]
      ]);

      // 00:30 on 1 November there, 07:30 UTC: a new month.
      yield* at("2026-11-01T07:30:00Z");
      yield* ledger.record(use(4));

      const november = yield* ledger.view;

      expect([november.day, november.today.costUsd, november.month.costUsd]).toEqual(["2026-11-01", 4, 4]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps days in UTC when ky has no zone yet", () => {
    const { layer } = fresh(null);

    return Effect.gen(function* () {
      const ledger = yield* Ledger;

      yield* at("2026-10-30T06:30:00Z");
      yield* ledger.record(use(1));
      expect((yield* ledger.view).day).toBe("2026-10-30");
    }).pipe(Effect.provide(layer));
  });
});

describe("the daily cap", () => {
  it.effect("is off by default, and over it holds unasked work, keeping why once a day for each kind", () => {
    const { db, layer } = fresh();

    return Effect.gen(function* () {
      const ledger = yield* Ledger;

      yield* at("2026-10-30T18:00:00Z");
      yield* ledger.record(use(50));
      expect(yield* ledger.allows("look")).toBe(true);
      expect((yield* ledger.view).capUsd).toBeNull();

      yield* ledger.setCap(60);
      expect(yield* ledger.allows("look")).toBe(true);
      expect(yield* ledger.notice).toBeUndefined();

      yield* ledger.record(use(10));
      expect((yield* ledger.view).capped).toBe(true);
      expect(yield* ledger.allows("look")).toBe(false);
      expect(yield* ledger.allows("look")).toBe(false);
      expect(yield* ledger.allows("dream")).toBe(false);
      expect(db.prepare(`SELECT work, why FROM ${SPEND_TABLES.held}`).all().map((row) => ({ ...row }))).toEqual([
        { work: "look", why: "Today's spend $60.00 reached the $60.00 daily cap." },
        { work: "dream", why: "Today's spend $60.00 reached the $60.00 daily cap." }
      ]);

      const notice = yield* ledger.notice;

      expect(notice?.text).toContain("$60.00 daily cap");
      expect(yield* ledger.notice).toBeUndefined();

      // The next morning in Los Angeles nothing is spent yet: work starts again.
      yield* at("2026-10-31T15:00:00Z");
      expect(yield* ledger.allows("look")).toBe(true);
      expect((yield* ledger.view).held).toEqual([]);

      yield* ledger.setCap(null);
      expect((yield* ledger.view).capUsd).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a cap that isn't dollars above 0", () => {
    const { layer } = fresh();

    return Effect.gen(function* () {
      const ledger = yield* Ledger;

      for (const usd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const exit = yield* Effect.exit(ledger.setCap(usd));

        expect(Exit.isFailure(exit) && Option.getOrUndefined(Exit.findErrorOption(exit))?.refusal).toBe("A daily cap is a number of dollars above 0.");
      }

      expect((yield* ledger.view).capUsd).toBeNull();
    }).pipe(Effect.provide(layer));
  });
});

describe("the stored rows", () => {
  it("decode as SQLite gives them, and a damaged one does not", () => {
    const db = new DatabaseSync(":memory:");

    Effect.runSync(Effect.provide(Ledger.use(() => Effect.void), Ledger.layer.pipe(Layer.provide(Layer.mergeAll(Sql.layer(storageOf(db)), Layer.succeed(Zone)({ zone: () => null }))))));
    db.prepare(`INSERT INTO ${SPEND_TABLES.ledger} (day, purpose, source, provider, model, tokens_in, tokens_out, cost_usd, calls) VALUES ('2026-10-30', 'main', 'chat', 'p', 'm', 3, 4, 0.5, 1)`).run();
    db.prepare(`INSERT INTO ${SPEND_TABLES.cap} (id, cap_usd) VALUES (1, 5)`).run();

    const [stored] = db.prepare(`SELECT * FROM ${SPEND_TABLES.ledger}`).all();

    expect(Schema.decodeUnknownSync(LedgerRow)(stored)).toEqual({ day: "2026-10-30", purpose: "main", source: "chat", provider: "p", model: "m", tokens_in: 3, tokens_out: 4, cost_usd: 0.5, calls: 1 });
    expect(Schema.decodeUnknownSync(CapRow)(db.prepare(`SELECT cap_usd, noticed_day FROM ${SPEND_TABLES.cap}`).get())).toEqual({ cap_usd: 5, noticed_day: null });
    expect(Option.isNone(Schema.decodeUnknownOption(LedgerRow)({ ...stored, cost_usd: "0.5" }))).toBe(true);
  });
});

describe("who a model's answer was for", () => {
  const tasks = new Map([
    ["routine", { source: "automation:a1", worker: "a1" }],
    ["triage", { source: "background", worker: "mail" }],
    ["sub", { source: "chat", worker: "w" }]
  ]);

  const whose = {
    chat: (session: string) => session === "chat",
    review: (session: string) => (session === "fork" ? ("episode" as const) : undefined),
    // SAFETY: attribution reads only a task's source and worker.
    task: (session: string) => tasks.get(session) as TaskRow | undefined
  };

  it("is the chat, a background review, an automation, a triage, a subagent, or other", () => {
    expect(["chat", "fork", "routine", "triage", "sub", "stray"].map((session) => attribution(whose, session))).toEqual([
      { purpose: "main", source: "chat" },
      { purpose: "background", source: "episode" },
      { purpose: "worker", source: "automation" },
      { purpose: "background", source: "mail" },
      { purpose: "worker", source: "subagent" },
      { purpose: "main", source: "other" }
    ]);
  });
});
