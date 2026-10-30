import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { DatabaseSync } from "node:sqlite";
import { ApprovalStore } from "../../src/approvals/approvals";
import { APPROVAL_EXPIRE_MS, APPROVAL_REMIND_MS } from "../../src/approvals/contract";
import { Sql } from "../../src/core/sql";
import { storageOf } from "../parity/skills/storage";

const storeOn = () => ApprovalStore.layer.pipe(Layer.provide(Sql.layer(storageOf(new DatabaseSync(":memory:")))));

const ASK = { kind: "executor", ref: "q1", subject: "gmail.send", summary: "Send it", payload: null, conversation: "here" } as const;

const refs = (swept: { readonly reminded: ReadonlyArray<{ readonly ref: string }>; readonly lapsed: ReadonlyArray<{ readonly ref: string }> }) => ({
  reminded: swept.reminded.map((each) => each.ref),
  lapsed: swept.lapsed.map((each) => each.ref)
});

describe("a card's clock", () => {
  it.effect("reminds just at APPROVAL_REMIND_MS, once, and lapses just at APPROVAL_EXPIRE_MS", () =>
    Effect.gen(function* () {
      const store = yield* ApprovalStore;
      yield* store.ask(ASK, "here");
      expect(yield* store.due).toBe(APPROVAL_REMIND_MS);

      yield* TestClock.adjust(APPROVAL_REMIND_MS - 1);
      expect(refs(yield* store.sweep)).toEqual({ reminded: [], lapsed: [] });

      yield* TestClock.adjust(1);
      expect(refs(yield* store.sweep)).toEqual({ reminded: ["q1"], lapsed: [] });
      expect(yield* store.due).toBe(APPROVAL_EXPIRE_MS);

      yield* TestClock.adjust(1);
      expect(refs(yield* store.sweep)).toEqual({ reminded: [], lapsed: [] });

      yield* TestClock.setTime(APPROVAL_EXPIRE_MS - 1);
      expect(refs(yield* store.sweep)).toEqual({ reminded: [], lapsed: [] });
      expect((yield* store.byRef("executor", "q1"))?.status).toBe("pending");

      yield* TestClock.adjust(1);
      expect(refs(yield* store.sweep)).toEqual({ reminded: [], lapsed: ["q1"] });
      expect((yield* store.byRef("executor", "q1"))?.status).toBe("expired");
      expect(yield* store.due).toBeNull();

      yield* TestClock.adjust(1);
      expect(refs(yield* store.sweep)).toEqual({ reminded: [], lapsed: [] });
    }).pipe(Effect.provide(storeOn()))
  );

  it.effect("lapses one asked over a day ago without reminding it first", () =>
    Effect.gen(function* () {
      const store = yield* ApprovalStore;
      yield* store.ask(ASK, "here");

      yield* TestClock.adjust(APPROVAL_EXPIRE_MS + 1);
      expect(refs(yield* store.sweep)).toEqual({ reminded: [], lapsed: ["q1"] });
    }).pipe(Effect.provide(storeOn()))
  );

  it.effect("shows a lapsed card for a day after, then drops it; asked again, it is pending and reminded afresh", () =>
    Effect.gen(function* () {
      const store = yield* ApprovalStore;
      yield* store.ask(ASK, "here");
      yield* TestClock.adjust(APPROVAL_REMIND_MS);
      yield* store.sweep;
      yield* TestClock.setTime(APPROVAL_EXPIRE_MS);
      yield* store.sweep;

      yield* TestClock.adjust(APPROVAL_EXPIRE_MS);
      expect((yield* store.cards).map((row) => [row.status, row.lapsed_at])).toEqual([["expired", APPROVAL_EXPIRE_MS]]);

      yield* TestClock.adjust(1);
      expect(yield* store.cards).toEqual([]);

      expect((yield* store.ask(ASK, "here")).asked).toBe(true);
      const now = 2 * APPROVAL_EXPIRE_MS + 1;
      expect(yield* store.due).toBe(now + APPROVAL_REMIND_MS);
      yield* TestClock.adjust(APPROVAL_REMIND_MS);
      expect(refs(yield* store.sweep)).toEqual({ reminded: ["q1"], lapsed: [] });
    }).pipe(Effect.provide(storeOn()))
  );
});
