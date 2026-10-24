import type { JsonValue } from "@earendil-works/pi-ai";
import Type, { type Static } from "typebox";
import { decode, parseOr } from "../core/decode";
import type { ApprovalAction, ApprovalKind, ApprovalStatus, ApprovalView } from "./contract";

/**
 * One store for everything ky asks the user before it acts for them
 * (src/approvals/contract.ts). A tool asks with requestApproval; only the
 * user's tap, over their own socket, decides with onDecision, which hands the
 * row to its kind's handler. A row is in Durable Object SQLite, so a request
 * outlives hibernation and a deploy, and it is decided at most once: the
 * decision claims it from pending in one statement, so a second tap, or a
 * tap racing another, finds nothing and does nothing. A crash after the claim
 * leaves it decided without its effect, never done twice.
 *
 * Who is there decides where it shows. Asked from a chat, the user is there,
 * and its card waits in that chat. Asked from anywhere else (a peer's
 * conversation, a routine, a subagent), nobody who may approve is: its card
 * waits in the chat that conversation works for, and a push tells the user.
 */

/** What a tool asks the user to decide. `conversation` is the session that asked. */
export type ApprovalRequest = {
  readonly kind: ApprovalKind;
  readonly subject: string;
  readonly summary: string;
  readonly payload: JsonValue;
  readonly conversation: string;
};

/** An approval as its kind's handler gets it, once the user decided it. */
export type Approval = ApprovalRequest & {
  readonly id: string;
  readonly status: ApprovalStatus;
  /** The chat its card shows in, and that hears what came of it. */
  readonly chat: string;
};

type Refused = { readonly refused: string };

/** What a kind does with the user's answer, and whether its approvals show as cards in their chat. */
export type ApprovalHandler = {
  readonly decide: (approval: Approval, action: ApprovalAction) => Promise<Refused | Record<string, never>>;
  /** What a tap on one no longer waiting is told. */
  readonly gone?: string;
  /** False for a kind the user decides elsewhere, as mail is in Settings › Mail. */
  readonly card?: boolean;
};

export type ApprovalDeps = {
  /** Whether a session is a chat the user is in: the main chat or a side chat. */
  readonly chat: (session: string) => boolean;
  /** The chat a conversation with no user works for; the main chat when it works for none. */
  readonly owner: (session: string) => string;
  /** Tell the user's devices; it must not throw. */
  readonly notify: (chat: string, text: string) => void;
};

const GONE = "That approval isn't waiting any more.";

const STATUS: Record<ApprovalAction, ApprovalStatus> = { accept: "accepted", decline: "declined", cancel: "cancelled" };

const Row = Type.Object({
  id: Type.String(),
  kind: Type.Union([Type.Literal("executor"), Type.Literal("mail"), Type.Literal("webhook-action"), Type.Literal("secret-request")]),
  subject: Type.String(),
  summary: Type.String(),
  payload: Type.String(),
  status: Type.Union([Type.Literal("pending"), Type.Literal("accepted"), Type.Literal("declined"), Type.Literal("cancelled"), Type.Literal("expired")]),
  conversation: Type.String(),
  chat: Type.String(),
  created_at: Type.Number()
});

type Row = Static<typeof Row>;

const Subject = Type.Object({ subject: Type.String() });

const COLUMNS = "id, kind, subject, summary, payload, status, conversation, chat, created_at";

const Json = Type.Unsafe<JsonValue>(Type.Any());

const approvalOf = (row: Row): Approval => ({
  id: row.id,
  kind: row.kind,
  subject: row.subject,
  summary: row.summary,
  payload: parseOr(Json, row.payload, null),
  status: row.status,
  conversation: row.conversation,
  chat: row.chat
});

export class Approvals {
  readonly #sql: SqlStorage;
  readonly #deps: ApprovalDeps;
  readonly #handlers = new Map<ApprovalKind, ApprovalHandler>();
  readonly #listeners = new Set<() => void>();

  constructor(sql: SqlStorage, deps: ApprovalDeps) {
    this.#sql = sql;
    this.#deps = deps;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_approvals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      conversation TEXT NOT NULL,
      chat TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      decided_at INTEGER)`);
    sql.exec("CREATE INDEX IF NOT EXISTS ky_approvals_pending ON ky_approvals (status, created_at)");
  }

  /** Who decides each kind; a kind with no handler can't be decided, so it stays pending. */
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
      .exec(`SELECT ${COLUMNS} FROM ky_approvals WHERE ${where}`, ...values)
      .toArray()
      .map((row) => decode(Row, row, "A stored approval"));
  }

  /** Ask the user; the approval's id. Its card waits in the chat, and the user hears of it when they aren't there. */
  requestApproval(request: ApprovalRequest): string {
    const id = crypto.randomUUID();
    const present = this.#deps.chat(request.conversation);
    const chat = present ? request.conversation : this.#deps.owner(request.conversation);

    this.#insert(id, request, "pending", chat);

    // A kind the user decides elsewhere, as mail in Settings › Mail, has its own way of reaching them.
    if (!present && this.#handlers.get(request.kind)?.card !== false) this.#deps.notify(chat, `Waiting for your OK: ${request.summary}`.slice(0, 200));
    this.#changed();

    return id;
  }

  /** Keep an approval the user's own setting already decided, so it is on record like one they tapped. */
  recordDecided(request: ApprovalRequest, action: ApprovalAction): string {
    const id = crypto.randomUUID();

    this.#insert(id, request, STATUS[action], request.conversation, Date.now());
    this.#changed();

    return id;
  }

  #insert(id: string, request: ApprovalRequest, status: ApprovalStatus, chat: string, decidedAt: number | null = null): void {
    this.#sql.exec(
      "INSERT INTO ky_approvals (id, kind, subject, summary, payload, status, conversation, chat, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      request.kind,
      request.subject,
      request.summary,
      JSON.stringify(request.payload),
      status,
      request.conversation,
      chat,
      Date.now(),
      decidedAt
    );
  }

  /**
   * The user's answer to approval `id`, from their tap. It claims the row from pending first, so only one answer ever
   * reaches its kind's handler; any other is refused and changes nothing.
   */
  async onDecision(id: string, action: ApprovalAction): Promise<Refused | Record<string, never>> {
    const [asked] = this.#rows("id = ?", id);
    const handler = asked ? this.#handlers.get(asked.kind) : undefined;

    if (!asked || !handler) return { refused: GONE };

    const [claimed] = this.#sql
      .exec(`UPDATE ky_approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending' RETURNING ${COLUMNS}`, STATUS[action], Date.now(), id)
      .toArray()
      .map((row) => decode(Row, row, "A stored approval"));

    if (!claimed) return { refused: handler.gone ?? GONE };
    this.#changed();

    return handler.decide(approvalOf(claimed), action);
  }

  /** Settle a pending approval without its handler, as the model declining one on the user's word; false when it was no longer pending. */
  withdraw(id: string, action: "decline" | "cancel"): boolean {
    const claimed = this.#sql.exec("UPDATE ky_approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending' RETURNING id", STATUS[action], Date.now(), id).toArray();

    if (claimed.length > 0) this.#changed();

    return claimed.length > 0;
  }

  /** Mark an approval expired: what it asked for is gone, as a request Executor no longer has. */
  expire(id: string): void {
    this.#sql.exec("UPDATE ky_approvals SET status = 'expired', decided_at = ? WHERE id = ?", Date.now(), id);
    this.#changed();
  }

  get(id: string): Approval | undefined {
    const [row] = this.#rows("id = ?", id);

    return row ? approvalOf(row) : undefined;
  }

  /** The pending approval of `kind` whose payload has `value` at `field`, as a held mail's by its id. */
  pendingBy(kind: ApprovalKind, field: string, value: string): Approval | undefined {
    const [row] = this.#rows("kind = ? AND status = 'pending' AND json_extract(payload, ?) = ?", kind, `$.${field}`, value);

    return row ? approvalOf(row) : undefined;
  }

  /** The subjects approvals of `kind` were asked about, newest first, as Settings lists Executor's tools. */
  subjects(kind: ApprovalKind): string[] {
    return this.#sql
      .exec("SELECT subject FROM ky_approvals WHERE kind = ? AND subject != '' GROUP BY subject ORDER BY MAX(created_at) DESC LIMIT 50", kind)
      .toArray()
      .map((row) => decode(Subject, row, "A stored approval's subject").subject);
  }

  /** The approvals waiting on the user with a card, oldest first. */
  pending(): ApprovalView[] {
    return this.#rows("status = 'pending' ORDER BY created_at")
      .filter((row) => this.#handlers.get(row.kind)?.card !== false)
      .map((row) => ({ id: row.id, kind: row.kind, subject: row.subject, summary: row.summary, chat: row.chat, createdAt: row.created_at }));
  }
}
