import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Sql } from "../core/sql";
import {
  BadCap,
  type BackgroundWork,
  CapRow,
  capNotice,
  dayIn,
  HeldRow,
  LedgerRow,
  SPEND_TABLES,
  type SpendTotals,
  type SpendView,
  type Usage,
  usd
} from "./contract";

export class Zone extends Context.Service<Zone, { readonly zone: () => string | null }>()("ky/spend/Zone") {}

const { ledger: LEDGER, cap: CAP, held: HELD } = SPEND_TABLES;

const Total = Schema.Struct({ cost_usd: Schema.NullOr(Schema.Number), tokens_in: Schema.NullOr(Schema.Number), tokens_out: Schema.NullOr(Schema.Number), calls: Schema.NullOr(Schema.Number) });

const totalsOf = (row: typeof Total.Type | undefined): SpendTotals => ({
  costUsd: row?.cost_usd ?? 0,
  tokensIn: row?.tokens_in ?? 0,
  tokensOut: row?.tokens_out ?? 0,
  calls: row?.calls ?? 0
});

export type CapNotice = { readonly text: string; readonly day: string; readonly at: number };

const SUMS = "SUM(cost_usd) AS cost_usd, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(calls) AS calls";

export class Ledger extends Context.Service<
  Ledger,
  {
    record(usage: Usage): Effect.Effect<void>;
    readonly view: Effect.Effect<SpendView>;
    setCap(usd: number | null): Effect.Effect<SpendView, BadCap>;
    allows(work: BackgroundWork): Effect.Effect<boolean>;
    readonly notice: Effect.Effect<CapNotice | undefined>;
  }
>()("ky/spend/Ledger") {
  static readonly layer = Layer.effect(
    Ledger,
    Effect.gen(function* () {
      const sql = yield* Sql;
      const { zone } = yield* Zone;
      const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));
      const rows = <T>(row: Schema.Decoder<T>, query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.rows(row, query, ...params));

      yield* exec(`CREATE TABLE IF NOT EXISTS ${LEDGER} (
        day TEXT NOT NULL, purpose TEXT NOT NULL, source TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, purpose, source, provider, model))`);
      yield* exec(`CREATE TABLE IF NOT EXISTS ${CAP} (id INTEGER PRIMARY KEY CHECK (id = 1), cap_usd REAL, noticed_day TEXT)`);
      yield* exec(`CREATE TABLE IF NOT EXISTS ${HELD} (day TEXT NOT NULL, work TEXT NOT NULL, why TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (day, work))`);

      const today = Effect.map(Clock.currentTimeMillis, (at) => dayIn(zone(), at));

      const cap = Effect.map(rows(CapRow, `SELECT cap_usd, noticed_day FROM ${CAP} WHERE id = 1`), ([row]) => row);

      const spentOn = (day: string) => Effect.map(rows(Total, `SELECT ${SUMS} FROM ${LEDGER} WHERE day = ?`, day), ([row]) => totalsOf(row));

      const over = Effect.gen(function* () {
        const day = yield* today;
        const capUsd = (yield* cap)?.cap_usd ?? null;
        const spent = yield* spentOn(day);

        return { day, capUsd, spent, capped: capUsd !== null && spent.costUsd >= capUsd };
      });

      const view = Effect.gen(function* () {
        const { day, capUsd, spent, capped } = yield* over;
        const month = yield* Effect.map(rows(Total, `SELECT ${SUMS} FROM ${LEDGER} WHERE substr(day, 1, 7) = ?`, day.slice(0, 7)), ([row]) => totalsOf(row));

        const lines = yield* rows(
          LedgerRow,
          `SELECT day, purpose, source, '' AS provider, '' AS model, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out, SUM(cost_usd) AS cost_usd, SUM(calls) AS calls
             FROM ${LEDGER} WHERE day = ? GROUP BY purpose, source ORDER BY cost_usd DESC, purpose, source`,
          day
        );

        const held = yield* rows(HeldRow, `SELECT work, why, at FROM ${HELD} WHERE day = ? ORDER BY at`, day);

        return {
          day,
          today: spent,
          month,
          lines: lines.map((line) => ({ purpose: line.purpose, source: line.source, costUsd: line.cost_usd, tokensIn: line.tokens_in, tokensOut: line.tokens_out, calls: line.calls })),
          capUsd,
          capped,
          held
        } satisfies SpendView;
      });

      return Ledger.of({
        record: (usage) =>
          Effect.gen(function* () {
            const day = yield* today;

            yield* exec(
              `INSERT INTO ${LEDGER} (day, purpose, source, provider, model, tokens_in, tokens_out, cost_usd, calls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
                 ON CONFLICT (day, purpose, source, provider, model) DO UPDATE SET
                   tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out, cost_usd = cost_usd + excluded.cost_usd, calls = calls + 1`,
              day,
              usage.purpose,
              usage.source,
              usage.provider,
              usage.model,
              usage.tokensIn,
              usage.tokensOut,
              usage.costUsd
            );
          }),
        view,
        setCap: (capUsd) =>
          Effect.gen(function* () {
            if (capUsd !== null && !(Number.isFinite(capUsd) && capUsd > 0)) return yield* new BadCap({ usd: capUsd });
            yield* exec(`INSERT INTO ${CAP} (id, cap_usd) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET cap_usd = excluded.cap_usd`, capUsd);

            return yield* view;
          }),
        allows: (work) =>
          Effect.gen(function* () {
            const { day, capUsd, spent, capped } = yield* over;

            if (!capped || capUsd === null) return true;
            const why = `Today's spend ${usd(spent.costUsd)} reached the ${usd(capUsd)} daily cap.`;
            const at = yield* Clock.currentTimeMillis;
            const kept = yield* exec(`INSERT INTO ${HELD} (day, work, why, at) VALUES (?, ?, ?, ?) ON CONFLICT (day, work) DO NOTHING RETURNING work`, day, work, why, at);

            if (kept.length > 0) yield* Effect.logWarning(`${work} held: ${why}`);

            return false;
          }),
        notice: Effect.gen(function* () {
          const { day, capUsd, capped } = yield* over;

          if (!capped || capUsd === null || (yield* cap)?.noticed_day === day) return undefined;
          yield* exec(`INSERT INTO ${CAP} (id, noticed_day) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET noticed_day = excluded.noticed_day`, day);

          return { text: capNotice(capUsd), day, at: yield* Clock.currentTimeMillis };
        })
      });
    })
  );
}
