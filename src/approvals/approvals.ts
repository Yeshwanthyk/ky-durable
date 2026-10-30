import type { JsonValue } from "@earendil-works/pi-ai";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type Edge, makeEdge, type Refusable } from "../core/edge";
import { isRefusal, type Result } from "../core/refusal";
import { Sql } from "../core/sql";
import {
  type ApprovalAction,
  type ApprovalKind,
  type ApprovalStatus,
  type ApprovalView,
  APPROVAL_EXPIRE_MS,
  APPROVAL_REMIND_MS,
  APPROVAL_TABLES,
  GONE
} from "./contract";

export type ApprovalRequest = {
  readonly kind: ApprovalKind;
  readonly ref: string;
  readonly subject: string;
  readonly summary: string;
  readonly payload: JsonValue;
  readonly conversation: string;
};

export type Approval = ApprovalRequest & {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly chat: string;
};

export interface Asker {
  requestApproval(request: ApprovalRequest): string;
  withdraw(id: string, action: "decline" | "cancel"): boolean;
  get(id: string): Approval | undefined;
  byRef(kind: ApprovalKind, ref: string): Approval | undefined;
}

export type Settle = {
  readonly expire: () => void;
  readonly reopen: () => boolean;
};

export type ApprovalHandler = {
  readonly decide: (approval: Approval, action: ApprovalAction, settle: Settle) => Promise<void>;
  readonly lost: (approval: Approval, action: ApprovalAction) => Promise<void>;
  /** Nobody answered it within APPROVAL_EXPIRE_MS: it is expired, and the conversation that asked is told. */
  readonly lapsed: (approval: Approval) => Promise<void>;
};

export type ApprovalDeps = {
  readonly present: (session: string) => boolean;
  readonly home: (session: string) => string;
  readonly notify: (chat: string, text: string) => void;
  readonly defer: (work: Promise<unknown>) => void;
  /** Sweep again at `at`: an alarm, so nothing polls. */
  readonly later: (at: number) => void;
};

const TABLE = APPROVAL_TABLES.approvals;

const CARRY_MS = 60_000;

const STATUS: Record<ApprovalAction, ApprovalStatus> = { accept: "accepted", decline: "declined", cancel: "cancelled" };

const actionOf = (status: ApprovalStatus): ApprovalAction | undefined =>
  status === "accepted" ? "accept" : status === "declined" ? "decline" : status === "cancelled" ? "cancel" : undefined;

const Row = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["executor", "webhook-action", "secret-request", "browser-handoff"]),
  ref: Schema.String,
  subject: Schema.String,
  summary: Schema.String,
  payload: Schema.String,
  status: Schema.Literals(["pending", "accepted", "declined", "cancelled", "expired"]),
  conversation: Schema.String,
  chat: Schema.String,
  created_at: Schema.Number,
  reminded_at: Schema.NullOr(Schema.Number),
  lapsed_at: Schema.NullOr(Schema.Number)
});

type Row = typeof Row.Type;

const Id = Schema.Struct({ id: Schema.String });

const Column = Schema.Struct({ name: Schema.String });

const Due = Schema.Struct({ at: Schema.NullOr(Schema.Number) });

const COLUMNS = "id, kind, ref, subject, summary, payload, status, conversation, chat, created_at, reminded_at, lapsed_at";

const payloadOf = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const linkOf = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ link: Schema.String.check(Schema.isPattern(/^https:\/\//)) })));

const approvalOf = (row: Row): Approval => ({
  id: row.id,
  kind: row.kind,
  ref: row.ref,
  subject: row.subject,
  summary: row.summary,
  payload: Option.getOrNull(payloadOf(row.payload)),
  status: row.status,
  conversation: row.conversation,
  chat: row.chat
});

class Gone extends Schema.TaggedError<Gone>()("Gone", {}) implements Refusable {
  get refusal(): string {
    return GONE;
  }
}

type Claim<H> = { readonly approval: Approval; readonly decidedAt: number; readonly handler: H };

type Swept = { readonly reminded: ReadonlyArray<Approval>; readonly lapsed: ReadonlyArray<Approval> };

export class ApprovalStore extends Context.Service<
  ApprovalStore,
  {
    ask(request: ApprovalRequest, chat: string): Effect.Effect<{ readonly id: string; readonly asked: boolean }>;
    claim<H>(id: string, action: ApprovalAction, handlerOf: (kind: ApprovalKind) => H | undefined): Effect.Effect<Claim<H>, Gone>;
    move(id: string, from: ApprovalStatus, to: ApprovalStatus, carried: boolean): Effect.Effect<boolean>;
    carried(id: string, decidedAt: number): Effect.Effect<void>;
    readonly cut: Effect.Effect<ReadonlyArray<Approval>>;
    get(id: string): Effect.Effect<Approval | undefined>;
    byRef(kind: ApprovalKind, ref: string): Effect.Effect<Approval | undefined>;
    /** The pending rows and those that lapsed in the last APPROVAL_EXPIRE_MS, each shown as its card. */
    readonly cards: Effect.Effect<ReadonlyArray<Row>>;
    /** Lapses each approval asked APPROVAL_EXPIRE_MS ago or more, and marks reminded each asked APPROVAL_REMIND_MS ago or more. */
    readonly sweep: Effect.Effect<Swept>;
    /** When the next pending approval is due a reminder or its lapse; null with none pending. */
    readonly due: Effect.Effect<number | null>;
  }
>()("ky/approvals/Store") {
  static readonly layer = Layer.effect(
    ApprovalStore,
    Effect.gen(function* () {
      const sql = yield* Sql;
      const exec = (query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.exec(query, ...params));
      const rows = <T>(row: Schema.Decoder<T>, query: string, ...params: SqlStorageValue[]) => Effect.orDie(sql.rows(row, query, ...params));
      const select = (where: string, ...params: SqlStorageValue[]) => rows(Row, `SELECT ${COLUMNS} FROM ${TABLE} WHERE ${where}`, ...params);
      const one = (where: string, ...params: SqlStorageValue[]) => Effect.map(select(where, ...params), ([row]) => row && approvalOf(row));

      yield* exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        subject TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        conversation TEXT NOT NULL,
        chat TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        carried_at INTEGER,
        UNIQUE (kind, ref))`);
      const columns = yield* rows(Column, `PRAGMA table_info(${TABLE})`);

      if (!columns.some((column) => column.name === "reminded_at")) yield* exec(`ALTER TABLE ${TABLE} ADD COLUMN reminded_at INTEGER`);

      if (!columns.some((column) => column.name === "lapsed_at")) yield* exec(`ALTER TABLE ${TABLE} ADD COLUMN lapsed_at INTEGER`);
      yield* exec(`CREATE INDEX IF NOT EXISTS ${TABLE}_pending ON ${TABLE} (status, created_at)`);

      const byRef = (kind: ApprovalKind, ref: string) => one("kind = ? AND ref = ?", kind, ref);

      return ApprovalStore.of({
        ask: Effect.fnUntraced(function* (request, chat) {
          const now = yield* Clock.currentTimeMillis;

          const [inserted] = yield* rows(
            Id,
            `INSERT INTO ${TABLE} (id, kind, ref, subject, summary, payload, status, conversation, chat, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
             ON CONFLICT (kind, ref) DO UPDATE SET
               subject = excluded.subject, summary = excluded.summary, payload = excluded.payload, status = 'pending',
               conversation = excluded.conversation, chat = excluded.chat, created_at = excluded.created_at, decided_at = NULL, carried_at = NULL,
               reminded_at = NULL, lapsed_at = NULL
             WHERE ${TABLE}.status != 'pending' AND ${TABLE}.carried_at IS NOT NULL
             RETURNING id`,
            crypto.randomUUID(),
            request.kind,
            request.ref,
            request.subject,
            request.summary,
            JSON.stringify(request.payload),
            request.conversation,
            chat,
            now
          );

          if (inserted) return { id: inserted.id, asked: true };

          const there = yield* byRef(request.kind, request.ref);

          if (!there) return yield* Effect.die(new Error(`approval ${request.kind}:${request.ref} neither inserted nor there`));

          return { id: there.id, asked: false };
        }),
        claim: Effect.fnUntraced(function* <H>(id: string, action: ApprovalAction, handlerOf: (kind: ApprovalKind) => H | undefined) {
          const [asked] = yield* select("id = ?", id);
          const handler = asked && handlerOf(asked.kind);

          if (!asked || handler === undefined) return yield* new Gone();

          const decidedAt = yield* Clock.currentTimeMillis;

          const [claimed] = yield* rows(
            Row,
            `UPDATE ${TABLE} SET status = ?, decided_at = ?, carried_at = NULL WHERE id = ? AND status = 'pending' RETURNING ${COLUMNS}`,
            STATUS[action],
            decidedAt,
            id
          );

          if (!claimed) return yield* new Gone();

          return { approval: approvalOf(claimed), decidedAt, handler };
        }),
        move: Effect.fnUntraced(function* (id, from, to, carried) {
          const now = yield* Clock.currentTimeMillis;

          const moved = yield* exec(
            `UPDATE ${TABLE} SET status = ?, decided_at = ?, carried_at = ? WHERE id = ? AND status = ? RETURNING id`,
            to,
            to === "pending" ? null : now,
            carried ? now : null,
            id,
            from
          );

          return moved.length > 0;
        }),
        carried: Effect.fnUntraced(function* (id, decidedAt) {
          const now = yield* Clock.currentTimeMillis;
          yield* exec(`UPDATE ${TABLE} SET carried_at = ? WHERE id = ? AND decided_at = ? AND status != 'pending' AND carried_at IS NULL`, now, id, decidedAt);
        }),
        cut: Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const cut = yield* select("status IN ('accepted', 'declined', 'cancelled') AND carried_at IS NULL AND decided_at < ?", now - CARRY_MS);

          return cut.map(approvalOf);
        }),
        get: (id) => one("id = ?", id),
        byRef,
        cards: Effect.flatMap(Clock.currentTimeMillis, (now) =>
          select("status = 'pending' OR (status = 'expired' AND lapsed_at >= ?) ORDER BY created_at", now - APPROVAL_EXPIRE_MS)
        ),
        sweep: Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          const lapsed = yield* rows(
            Row,
            `UPDATE ${TABLE} SET status = 'expired', decided_at = ?, carried_at = ?, lapsed_at = ? WHERE status = 'pending' AND created_at <= ? RETURNING ${COLUMNS}`,
            now,
            now,
            now,
            now - APPROVAL_EXPIRE_MS
          );

          const reminded = yield* rows(
            Row,
            `UPDATE ${TABLE} SET reminded_at = ? WHERE status = 'pending' AND reminded_at IS NULL AND created_at <= ? RETURNING ${COLUMNS}`,
            now,
            now - APPROVAL_REMIND_MS
          );

          return { reminded: reminded.map(approvalOf), lapsed: lapsed.map(approvalOf) };
        }),
        due: Effect.map(
          rows(Due, `SELECT MIN(CASE WHEN reminded_at IS NULL THEN created_at + ? ELSE created_at + ? END) AS at FROM ${TABLE} WHERE status = 'pending'`, APPROVAL_REMIND_MS, APPROVAL_EXPIRE_MS),
          ([found]) => found?.at ?? null
        )
      });
    })
  );
}

export class Approvals implements Asker {
  readonly #edge: Edge<ApprovalStore>;
  readonly #deps: ApprovalDeps;
  readonly #handlers = new Map<ApprovalKind, ApprovalHandler>();
  readonly #listeners = new Set<() => void>();

  constructor(storage: DurableObjectStorage, deps: ApprovalDeps) {
    this.#edge = makeEdge(ApprovalStore.layer.pipe(Layer.provide(Sql.layer(storage))));
    this.#deps = deps;
    this.#edge.run(Effect.void);
  }

  handle(kind: ApprovalKind, handler: ApprovalHandler): void {
    this.#handlers.set(kind, handler);
  }

  onChange(listener: () => void): void {
    this.#listeners.add(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  #move(id: string, from: ApprovalStatus, to: ApprovalStatus, carried = false): boolean {
    const moved = this.#edge.run(ApprovalStore.use((store) => store.move(id, from, to, carried)));

    if (moved) this.#changed();

    return moved;
  }

  requestApproval(request: ApprovalRequest): string {
    const chat = this.#deps.home(request.conversation);
    const { id, asked } = this.#edge.run(ApprovalStore.use((store) => store.ask(request, chat)));

    if (!asked) return id;

    if (!this.#deps.present(request.conversation)) this.#deps.notify(chat, `Waiting for your OK: ${request.summary}`.slice(0, 200));
    this.#changed();
    this.#book();

    return id;
  }

  #book(): void {
    const due = this.#edge.run(ApprovalStore.use((store) => store.due));

    if (due !== null) this.#deps.later(due);
  }

  /** One push for each card nobody answered in APPROVAL_REMIND_MS; a card unanswered in APPROVAL_EXPIRE_MS lapses, and its conversation is told. */
  sweep(): void {
    const { reminded, lapsed } = this.#edge.run(ApprovalStore.use((store) => store.sweep));

    for (const approval of reminded) this.#deps.notify(approval.chat, `Still waiting for your OK: ${approval.summary}`.slice(0, 200));

    for (const approval of lapsed) {
      const handler = this.#handlers.get(approval.kind);

      if (handler) this.#deps.defer(handler.lapsed(approval).catch((error) => console.warn("approval lapse not told", approval.id, error)));
    }

    if (lapsed.length > 0) this.#changed();
    this.#book();
  }

  onDecision(id: string, action: ApprovalAction): Result<Record<string, never>> {
    const claim = this.#edge.run(ApprovalStore.use((store) => store.claim(id, action, (kind) => this.#handlers.get(kind))));

    if (isRefusal(claim)) return claim;
    this.#changed();
    const { approval, decidedAt, handler } = claim;

    const settle: Settle = {
      expire: () => void this.#move(id, approval.status, "expired", true),
      reopen: () => this.#move(id, approval.status, "pending")
    };

    this.#deps.defer(
      Promise.resolve()
        .then(() => handler.decide(approval, action, settle))
        .catch((error) => console.warn("approval not carried out", id, error))
        .finally(() => this.#edge.run(ApprovalStore.use((store) => store.carried(id, decidedAt))))
    );

    return {};
  }

  recover(): void {
    for (const approval of this.#edge.run(ApprovalStore.use((store) => store.cut))) {
      const handler = this.#handlers.get(approval.kind);
      const action = actionOf(approval.status);

      if (!handler || !action || !this.#move(approval.id, approval.status, "pending")) continue;
      this.#deps.defer(handler.lost({ ...approval, status: "pending" }, action).catch((error) => console.warn("approval not told", approval.id, error)));
    }

    this.sweep();
  }

  withdraw(id: string, action: "decline" | "cancel"): boolean {
    return this.#move(id, "pending", STATUS[action], true);
  }

  get(id: string): Approval | undefined {
    return this.#edge.run(ApprovalStore.use((store) => store.get(id)));
  }

  byRef(kind: ApprovalKind, ref: string): Approval | undefined {
    return this.#edge.run(ApprovalStore.use((store) => store.byRef(kind, ref)));
  }

  /** What the chats show: each pending card, and each that lapsed in the last day, as expired. */
  cards(): ApprovalView[] {
    return this.#viewed(this.#edge.run(ApprovalStore.use((store) => store.cards)));
  }

  #viewed(rows: ReadonlyArray<Row>): ApprovalView[] {
    return rows.flatMap((row) => {
      if (!this.#handlers.has(row.kind)) return [];
      const view = { id: row.id, kind: row.kind, subject: row.subject, summary: row.summary, chat: row.chat, createdAt: row.created_at };

      const linked = Option.match(linkOf(row.payload), { onNone: () => view, onSome: ({ link }) => ({ ...view, link }) });

      return [row.status === "expired" && row.lapsed_at !== null ? { ...linked, lapsedAt: row.lapsed_at } : linked];
    });
  }
}
