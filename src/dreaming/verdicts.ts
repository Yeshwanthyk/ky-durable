import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Edge, makeEdge, type Refusable } from "../core/edge";
import type { Result } from "../core/refusal";
import { Sql } from "../core/sql";
import { PostVerdict, type PostVerdicts, VERDICT_REASON_CHARS, type VerdictInput } from "./contract";
import { SurfacedStore } from "./surfaced";

/** What the page and the rate count: the last 30 days. */
export const VERDICTS_MS = 30 * 86_400_000;

const KEEP_MS = 90 * 86_400_000;

const VerdictRow = Schema.Struct({
  item: Schema.String,
  kind: Schema.String,
  ref: Schema.String,
  text: Schema.String,
  verdict: PostVerdict,
  reason: Schema.NullOr(Schema.String),
  at: Schema.Number
});

/** A post the user judged: what ky said, on what ref, and their verdict. */
export type Judged = typeof VerdictRow.Type;

const decodeRow = Schema.decodeUnknownOption(VerdictRow);


class NotAPost
  extends Schema.TaggedError<NotAPost>()("NotAPost", {
    item: Schema.String
  })
  implements Refusable
{
  get refusal(): string {
    return `ky posted nothing as ${this.item}.`;
  }
}

class BadVerdict extends Schema.TaggedError<BadVerdict>()("BadVerdict", {}) implements Refusable {
  get refusal(): string {
    return `A verdict is useful or not-useful on a post, with a reason of at most ${VERDICT_REASON_CHARS} characters.`;
  }
}

const nowOr = (now: number | undefined) => (now === undefined ? Clock.currentTimeMillis : Effect.succeed(now));

export class VerdictStore extends Context.Service<
  VerdictStore,
  {
    readonly judge: (input: Option.Option<VerdictInput>, now: number | undefined) => Effect.Effect<PostVerdicts, NotAPost | BadVerdict>;
    readonly view: (now: number | undefined) => Effect.Effect<PostVerdicts>;
    readonly recent: (limit: number) => Effect.Effect<Judged[]>;
    readonly since: (from: number, verdict: PostVerdict, limit: number) => Effect.Effect<Judged[]>;
    readonly unwanted: (from: number) => Effect.Effect<Map<string, number>>;
    readonly prune: (now: number | undefined) => Effect.Effect<number>;
  }
>()("ky/dreaming/Verdicts") {
  static readonly layer = Layer.effect(
    VerdictStore,
    Effect.gen(function* () {
      const sql = yield* Sql;
      const surfaced = yield* SurfacedStore;
      const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));
      const rows = (query: string, ...params: SqlStorageValue[]) => Effect.map(exec(query, ...params), (found) => found.flatMap((row) => Option.toArray(decodeRow(row))));

      yield* exec(`CREATE TABLE IF NOT EXISTS ky_post_verdicts (
        item TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        text TEXT NOT NULL,
        verdict TEXT NOT NULL,
        reason TEXT,
        at INTEGER NOT NULL)`);
      yield* exec("CREATE INDEX IF NOT EXISTS ky_post_verdicts_at ON ky_post_verdicts (at)");

      const view = Effect.fn("Verdicts.view")(function* (at: number | undefined) {
        const now = yield* nowOr(at);
        const judged = yield* rows("SELECT * FROM ky_post_verdicts WHERE at >= ? ORDER BY at DESC, item", now - VERDICTS_MS);

        return {
          verdicts: judged.map(({ item, verdict, reason }) => ({ item, verdict, reason })),
          useful: judged.filter((row) => row.verdict === "useful").length,
          judged: judged.length
        } satisfies PostVerdicts;
      });

      return VerdictStore.of({
        judge: Effect.fn("Verdicts.judge")(function* (decoded, at) {
          const input = yield* Option.match(decoded, { onNone: () => Effect.fail(new BadVerdict()), onSome: Effect.succeed });
          const post = yield* surfaced.post(input.item);

          if (Option.isNone(post)) return yield* new NotAPost({ item: input.item });
          const now = yield* nowOr(at);
          const reason = input.verdict === "useful" ? null : (input.reason ?? "").replace(/\s+/g, " ").trim() || null;
          yield* exec(
            "INSERT INTO ky_post_verdicts (item, kind, ref, text, verdict, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (item) DO UPDATE SET verdict = excluded.verdict, reason = excluded.reason, at = excluded.at",
            input.item,
            post.value.kind,
            post.value.ref,
            post.value.text,
            input.verdict,
            reason,
            now
          );

          return yield* view(now);
        }),
        view,
        recent: (limit) => rows("SELECT * FROM ky_post_verdicts ORDER BY at DESC, item LIMIT ?", limit),
        since: (from, verdict, limit) => rows("SELECT * FROM ky_post_verdicts WHERE verdict = ? AND at >= ? ORDER BY at DESC, item LIMIT ?", verdict, from, limit),
        // A ref's latest verdict stands: a 👍 after a 👎 takes the 👎 back.
        unwanted: (from) =>
          Effect.map(
            rows("SELECT * FROM ky_post_verdicts WHERE at >= ? ORDER BY at, item", from),
            (judged) => new Map([...new Map(judged.map((row) => [row.ref, row])).values()].flatMap((row) => (row.verdict === "not-useful" ? [[row.ref, row.at] as const] : [])))
          ),
        prune: Effect.fn("Verdicts.prune")(function* (at) {
          const now = yield* nowOr(at);

          return (yield* exec("DELETE FROM ky_post_verdicts WHERE at < ? RETURNING item", now - KEEP_MS)).length;
        })
      });
    })
  );
}

export class Verdicts {
  readonly #edge: Edge<VerdictStore>;

  constructor(storage: DurableObjectStorage) {
    this.#edge = makeEdge(VerdictStore.layer.pipe(Layer.provide(SurfacedStore.layer), Layer.provide(Sql.layer(storage))));
    this.#edge.run(Effect.void);
  }

  /** The user's verdict on a post, as the page sent it: every verdict of the last 30 days after it, or why not. */
  judge(input: Option.Option<VerdictInput>, now?: number): Result<PostVerdicts> {
    return this.#edge.run(VerdictStore.use((store) => store.judge(input, now)));
  }

  view(now?: number): PostVerdicts {
    return this.#edge.run(VerdictStore.use((store) => store.view(now)));
  }

  recent(limit: number): Judged[] {
    return this.#edge.run(VerdictStore.use((store) => store.recent(limit)));
  }

  since(from: number, verdict: PostVerdict, limit: number): Judged[] {
    return this.#edge.run(VerdictStore.use((store) => store.since(from, verdict, limit)));
  }

  /** Each ref whose latest verdict since `from` is 👎, and when. */
  unwanted(from: number): Map<string, number> {
    return this.#edge.run(VerdictStore.use((store) => store.unwanted(from)));
  }

  prune(now?: number): number {
    return this.#edge.run(VerdictStore.use((store) => store.prune(now)));
  }
}

const POST_CHARS = 120;

const abbreviated = (text: string) => (text.length <= POST_CHARS ? text : `${text.slice(0, POST_CHARS - 1)}…`);

/** A judged post as a prompt reads it: the verdict, what was said, its ref and the reason. */
export const verdictLine = (row: Judged) =>
  `- ${row.verdict === "useful" ? "👍 useful" : "👎 not useful"}: "${abbreviated(row.text)}" (${row.ref}, ${new Date(row.at).toISOString().slice(0, 10)})${row.reason === null ? "" : `: ${row.reason}`}`;
