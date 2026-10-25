import type { JsonValue } from "@earendil-works/pi-ai";
import Type, { type Static } from "typebox";
import { decode, parseOr } from "../core/decode";
import { must } from "../core/must";
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

/**
 * One store for everything ky asks the user before it acts for them
 * (src/approvals/contract.ts). A tool asks through an Asker; only the user's
 * tap, over their own socket, decides with onDecision, which hands the row to
 * its kind's handler. A row is in Durable Object SQLite, so a request outlives
 * hibernation and a deploy. Asking twice for the same thing (the kind's own
 * id, `ref`) finds the row already there. A row is decided at most once: the
 * tap claims it from pending in one statement, so a second tap, or a tap
 * racing another, finds nothing and does nothing. A crash after the claim
 * leaves it decided without its effect, never done twice.
 *
 * The tap is answered as soon as it is claimed; the handler carries it out
 * after, in the background, and tells the chat what came of it. When nothing
 * reached its target, the handler puts the row back to pending, so the user
 * can tap again.
 *
 * Who is there decides who hears of it. Its card waits in the chat the asking
 * conversation belongs to. When the user didn't start the turn that asked (a
 * report or a peer's question started it, or it is a routine, a peer's
 * conversation or a subagent), nobody who may approve is there, so a push
 * tells the user.
 */

/** What a tool asks the user to decide. `ref` is the kind's own id for it, as Executor's requestId; `conversation` is the session that asked. */
export type ApprovalRequest = {
  readonly kind: ApprovalKind;
  readonly ref: string;
  readonly subject: string;
  readonly summary: string;
  readonly payload: JsonValue;
  readonly conversation: string;
};

/** An approval as a store keeps it. */
export type Approval = ApprovalRequest & {
  readonly id: string;
  readonly status: ApprovalStatus;
  /** The chat its card shows in, and that hears what came of it. */
  readonly chat: string;
};

type Refused = { readonly refused: string };

/** What a kind's adapter holds: it asks, withdraws on the user's word, and reads. Only the user's socket decides (Approvals.onDecision). */
export interface Asker {
  /** Ask the user; the approval's id. Asked again for the same `ref`, the approval already there. */
  requestApproval(request: ApprovalRequest): string;
  /** Settle a pending approval without its handler, as the model declining one on the user's word; false when it was no longer pending. */
  withdraw(id: string, action: "decline" | "cancel"): boolean;
  get(id: string): Approval | undefined;
  /** The approval of `kind` asked for `ref`, whatever its status. */
  byRef(kind: ApprovalKind, ref: string): Approval | undefined;
}

/** What a handler may still do with the approval it was handed, from the status the tap gave it. */
export type Settle = {
  /** What it asked for is gone, as a request Executor no longer has. */
  readonly expire: () => void;
  /** Nothing reached its target: it waits on the user again, so they can tap again. False when it moved meanwhile. */
  readonly reopen: () => boolean;
};

/** What a kind does with the user's answer, after the tap was answered: it tells the chat what came of it, a failure included. */
export type ApprovalHandler = {
  readonly decide: (approval: Approval, action: ApprovalAction, settle: Settle) => Promise<void>;
};

export type ApprovalDeps = {
  /** Whether the user is in the turn running in `session`: they started it, in a chat of theirs. */
  readonly present: (session: string) => boolean;
  /** The chat an approval asked in `session` shows its card in. */
  readonly home: (session: string) => string;
  /** Tell the user's devices; it must not throw. */
  readonly notify: (chat: string, text: string) => void;
  /** Keep work going after the tap is answered. */
  readonly defer: (work: Promise<unknown>) => void;
};

const TABLE = APPROVAL_TABLES.approvals;

const STATUS: Record<ApprovalAction, ApprovalStatus> = { accept: "accepted", decline: "declined", cancel: "cancelled" };

const Row = Type.Object({
  id: Type.String(),
  kind: ApprovalKindSchema,
  ref: Type.String(),
  subject: Type.String(),
  summary: Type.String(),
  payload: Type.String(),
  status: ApprovalStatusSchema,
  conversation: Type.String(),
  chat: Type.String(),
  created_at: Type.Number()
});

type Row = Static<typeof Row>;

const Id = Type.Object({ id: Type.String() });

const COLUMNS = "id, kind, ref, subject, summary, payload, status, conversation, chat, created_at";

const Json = Type.Unsafe<JsonValue>(Type.Any());

const approvalOf = (row: Row): Approval => ({
  id: row.id,
  kind: row.kind,
  ref: row.ref,
  subject: row.subject,
  summary: row.summary,
  payload: parseOr(Json, row.payload, null),
  status: row.status,
  conversation: row.conversation,
  chat: row.chat
});

export class Approvals implements Asker {
  readonly #sql: SqlStorage;
  readonly #deps: ApprovalDeps;
  readonly #handlers = new Map<ApprovalKind, ApprovalHandler>();
  readonly #listeners = new Set<() => void>();

  constructor(sql: SqlStorage, deps: ApprovalDeps) {
    this.#sql = sql;
    this.#deps = deps;
    sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
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
      UNIQUE (kind, ref))`);
    sql.exec(`CREATE INDEX IF NOT EXISTS ${TABLE}_pending ON ${TABLE} (status, created_at)`);
  }

  /** Who decides each kind; a kind with no handler can't be decided, so it stays pending and shows no card. */
  handle(kind: ApprovalKind, handler: ApprovalHandler): void {
    this.#handlers.set(kind, handler);
  }

  /** Called whenever an approval is asked or decided. */
  onChange(listener: () => void): void {
    this.#listeners.add(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  #rows(where: string, ...values: Array<string | number>): Row[] {
    return this.#sql
      .exec(`SELECT ${COLUMNS} FROM ${TABLE} WHERE ${where}`, ...values)
      .toArray()
      .map((row) => decode(Row, row, "A stored approval"));
  }

  /** Move approval `id` from status `from` to `to`; false when it wasn't in `from` any more. */
  #move(id: string, from: ApprovalStatus, to: ApprovalStatus): boolean {
    const decidedAt = to === "pending" ? null : Date.now();
    const moved = this.#sql.exec(`UPDATE ${TABLE} SET status = ?, decided_at = ? WHERE id = ? AND status = ? RETURNING id`, to, decidedAt, id, from).toArray().length > 0;

    if (moved) this.#changed();

    return moved;
  }

  requestApproval(request: ApprovalRequest): string {
    const chat = this.#deps.home(request.conversation);

    const [inserted] = this.#sql
      .exec(
        `INSERT INTO ${TABLE} (id, kind, ref, subject, summary, payload, status, conversation, chat, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT (kind, ref) DO NOTHING RETURNING id`,
        crypto.randomUUID(),
        request.kind,
        request.ref,
        request.subject,
        request.summary,
        JSON.stringify(request.payload),
        request.conversation,
        chat,
        Date.now()
      )
      .toArray()
      .map((row) => decode(Id, row, "A new approval's id").id);

    // Asked again for the same thing: the approval already there, and nobody is told twice.
    if (inserted === undefined) return must(this.byRef(request.kind, request.ref), "The approval asked for this is gone.").id;

    if (!this.#deps.present(request.conversation)) this.#deps.notify(chat, `Waiting for your OK: ${request.summary}`.slice(0, 200));
    this.#changed();

    return inserted;
  }

  /**
   * The user's answer to approval `id`, from their tap: claimed from pending first, so only one answer ever reaches its
   * kind's handler, and answered then; the handler carries it out after. Any other answer is refused and changes nothing.
   */
  onDecision(id: string, action: ApprovalAction): Refused | Record<string, never> {
    const [asked] = this.#rows("id = ?", id);
    const handler = asked ? this.#handlers.get(asked.kind) : undefined;

    if (!asked || !handler) return { refused: GONE };

    const [claimed] = this.#sql
      .exec(`UPDATE ${TABLE} SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending' RETURNING ${COLUMNS}`, STATUS[action], Date.now(), id)
      .toArray()
      .map((row) => decode(Row, row, "A stored approval"));

    if (!claimed) return { refused: GONE };
    this.#changed();
    const approval = approvalOf(claimed);

    const settle: Settle = {
      expire: () => void this.#move(id, approval.status, "expired"),
      reopen: () => this.#move(id, approval.status, "pending")
    };

    // The handler tells the chat what came of it; a throw it let through is only logged, as the tap was answered.
    this.#deps.defer(
      Promise.resolve()
        .then(() => handler.decide(approval, action, settle))
        .catch((error) => console.warn("approval not carried out", id, error))
    );

    return {};
  }

  withdraw(id: string, action: "decline" | "cancel"): boolean {
    return this.#move(id, "pending", STATUS[action]);
  }

  get(id: string): Approval | undefined {
    const [row] = this.#rows("id = ?", id);

    return row ? approvalOf(row) : undefined;
  }

  byRef(kind: ApprovalKind, ref: string): Approval | undefined {
    const [row] = this.#rows("kind = ? AND ref = ?", kind, ref);

    return row ? approvalOf(row) : undefined;
  }

  /** The approvals waiting on the user, oldest first, of the kinds that can be decided. */
  pending(): ApprovalView[] {
    return this.#rows("status = 'pending' ORDER BY created_at")
      .filter((row) => this.#handlers.has(row.kind))
      .map((row) => ({ id: row.id, kind: row.kind, subject: row.subject, summary: row.summary, chat: row.chat, createdAt: row.created_at }));
  }
}
