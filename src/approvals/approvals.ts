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
  ApprovalKindSchema,
  type ApprovalStatus,
  ApprovalStatusSchema,
  type ApprovalView,
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
};

export type ApprovalDeps = {
  readonly present: (session: string) => boolean;
  readonly home: (session: string) => string;
  readonly notify: (chat: string, text: string) => void;
  readonly defer: (work: Promise<unknown>) => void;
};

const TABLE = APPROVAL_TABLES.approvals;

const CARRY_MS = 60_000;

const STATUS: Record<ApprovalAction, ApprovalStatus> = { accept: "accepted", decline: "declined", cancel: "cancelled" };

const actionOf = (status: ApprovalStatus): ApprovalAction | undefined =>
  status === "accepted" ? "accept" : status === "declined" ? "decline" : status === "cancelled" ? "cancel" : undefined;

export const literals = <const L extends string>(union: { readonly anyOf: ReadonlyArray<{ readonly const: L }> }) => Schema.Literals(union.anyOf.map((each) => each.const));

const Row = Schema.Struct({
  id: Schema.String,
  kind: literals(ApprovalKindSchema),
  ref: Schema.String,
  subject: Schema.String,
  summary: Schema.String,
  payload: Schema.String,
  status: literals(ApprovalStatusSchema),
  conversation: Schema.String,
  chat: Schema.String,
  created_at: Schema.Number
});

type Row = typeof Row.Type;

const Id = Schema.Struct({ id: Schema.String });

const COLUMNS = "id, kind, ref, subject, summary, payload, status, conversation, chat, created_at";

const payloadOf = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

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

type Claim = { readonly approval: Approval; readonly decidedAt: number };

class Store extends Context.Service<
  Store,
  {
    ask(request: ApprovalRequest, chat: string): Effect.Effect<{ readonly id: string; readonly asked: boolean }>;
    claim(id: string, action: ApprovalAction, decidable: (kind: ApprovalKind) => boolean): Effect.Effect<Claim, Gone>;
    move(id: string, from: ApprovalStatus, to: ApprovalStatus, carried: boolean): Effect.Effect<boolean>;
    carried(id: string, decidedAt: number): Effect.Effect<void>;
    readonly cut: Effect.Effect<ReadonlyArray<Approval>>;
    get(id: string): Effect.Effect<Approval | undefined>;
    byRef(kind: ApprovalKind, ref: string): Effect.Effect<Approval | undefined>;
    readonly pending: Effect.Effect<ReadonlyArray<Row>>;
  }
>()("ky/approvals/Store") {
  static readonly layer = Layer.effect(
    Store,
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
      yield* exec(`CREATE INDEX IF NOT EXISTS ${TABLE}_pending ON ${TABLE} (status, created_at)`);

      const byRef = (kind: ApprovalKind, ref: string) => one("kind = ? AND ref = ?", kind, ref);

      return Store.of({
        ask: Effect.fnUntraced(function* (request, chat) {
          const now = yield* Clock.currentTimeMillis;

          const [inserted] = yield* rows(
            Id,
            `INSERT INTO ${TABLE} (id, kind, ref, subject, summary, payload, status, conversation, chat, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
             ON CONFLICT (kind, ref) DO UPDATE SET
               subject = excluded.subject, summary = excluded.summary, payload = excluded.payload, status = 'pending',
               conversation = excluded.conversation, chat = excluded.chat, created_at = excluded.created_at, decided_at = NULL, carried_at = NULL
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
        claim: Effect.fnUntraced(function* (id, action, decidable) {
          const [asked] = yield* select("id = ?", id);

          if (!asked || !decidable(asked.kind)) return yield* new Gone();

          const decidedAt = yield* Clock.currentTimeMillis;

          const [claimed] = yield* rows(
            Row,
            `UPDATE ${TABLE} SET status = ?, decided_at = ?, carried_at = NULL WHERE id = ? AND status = 'pending' RETURNING ${COLUMNS}`,
            STATUS[action],
            decidedAt,
            id
          );

          if (!claimed) return yield* new Gone();

          return { approval: approvalOf(claimed), decidedAt };
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
        pending: select("status = 'pending' ORDER BY created_at")
      });
    })
  );
}

export class Approvals implements Asker {
  readonly #edge: Edge<Store>;
  readonly #deps: ApprovalDeps;
  readonly #handlers = new Map<ApprovalKind, ApprovalHandler>();
  readonly #listeners = new Set<() => void>();

  constructor(storage: DurableObjectStorage, deps: ApprovalDeps) {
    this.#edge = makeEdge(Store.layer.pipe(Layer.provide(Sql.layer(storage))));
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
    const moved = this.#edge.run(Store.use((store) => store.move(id, from, to, carried)));

    if (moved) this.#changed();

    return moved;
  }

  requestApproval(request: ApprovalRequest): string {
    const chat = this.#deps.home(request.conversation);
    const { id, asked } = this.#edge.run(Store.use((store) => store.ask(request, chat)));

    if (!asked) return id;

    if (!this.#deps.present(request.conversation)) this.#deps.notify(chat, `Waiting for your OK: ${request.summary}`.slice(0, 200));
    this.#changed();

    return id;
  }

  onDecision(id: string, action: ApprovalAction): Result<Record<string, never>> {
    const claim = this.#edge.run(Store.use((store) => store.claim(id, action, (kind) => this.#handlers.has(kind))));

    if (isRefusal(claim)) return claim;
    this.#changed();
    const { approval, decidedAt } = claim;
    const handler = this.#handlers.get(approval.kind);

    if (!handler) return {};

    const settle: Settle = {
      expire: () => void this.#move(id, approval.status, "expired", true),
      reopen: () => this.#move(id, approval.status, "pending")
    };

    this.#deps.defer(
      Promise.resolve()
        .then(() => handler.decide(approval, action, settle))
        .catch((error) => console.warn("approval not carried out", id, error))
        .finally(() => this.#edge.run(Store.use((store) => store.carried(id, decidedAt))))
    );

    return {};
  }

  recover(): void {
    for (const approval of this.#edge.run(Store.use((store) => store.cut))) {
      const handler = this.#handlers.get(approval.kind);
      const action = actionOf(approval.status);

      if (!handler || !action || !this.#move(approval.id, approval.status, "pending")) continue;
      this.#deps.defer(handler.lost({ ...approval, status: "pending" }, action).catch((error) => console.warn("approval not told", approval.id, error)));
    }
  }

  withdraw(id: string, action: "decline" | "cancel"): boolean {
    return this.#move(id, "pending", STATUS[action], true);
  }

  get(id: string): Approval | undefined {
    return this.#edge.run(Store.use((store) => store.get(id)));
  }

  byRef(kind: ApprovalKind, ref: string): Approval | undefined {
    return this.#edge.run(Store.use((store) => store.byRef(kind, ref)));
  }

  pending(): ApprovalView[] {
    return this.#edge
      .run(Store.use((store) => store.pending))
      .filter((row) => this.#handlers.has(row.kind))
      .map((row) => ({ id: row.id, kind: row.kind, subject: row.subject, summary: row.summary, chat: row.chat, createdAt: row.created_at }));
  }
}
