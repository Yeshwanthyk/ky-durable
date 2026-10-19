import { defineExtension, type Extension, GenerationTask, hook } from "@earendil-works/pi-durable";
import type { Surfaced } from "../dreaming/wiring";
import { decodeOr } from "../core/decode";
import { ColumnInfo, type Delivery, DeliverySchema, SessionRow } from "./contract";

/**
 * How what ky tells a chat unasked reaches the user: an automation run's report (src/skills/subagents.ts), its
 * notice that its gate paused it (src/automations/automations.ts), or a look's message (src/dreaming/looks.ts).
 * It always goes to that chat, in full, whether or not the user is around. It enters only between turns, never
 * into a run: an idle chat takes it at once, and a busy one when its turn is over, so it never steers the work the
 * user is watching. An event is given to the chat's agent, which answers it; a look's message, or a post automation's
 * report, is posted as ky's own, as written, and starts nothing. Each, once it is in the chat, is pushed to the user's devices (src/push.ts).
 * A run's cards (src/ui-tool.ts) are posted as ky's own just before its report, so the card reads first and the report
 * after it, whether the report is posted or the agent tells it.
 *
 * Each item has a row, keyed by its id. Handed over twice, it is delivered once. A queued one waits in its row,
 * so an eviction or a restart keeps it, and it is tried again when the chat's run is over however it ended (an
 * answer, a stop, a failure), on the next delivery to that chat, and when the object starts. Its id is also its request id with pi, so a submit a crash
 * cut off before its row was marked is taken once when tried again. Rows an older ky marked 'brief' (sent to the
 * brief instead) were delivered there; they only keep their id known until they age out.
 */

/** A line in a chat counts as unhandled for a day, then as expired. */
const EVENT_EXPIRY_MS = 86_400_000;

/** Rows kept after their delivery, so a late second hand-over is still known. */
const KEEP_MS = 30 * 86_400_000;

/** The limit on an event line's text, as what ky surfaced keeps it. */
const LINE_BYTES = 280;

const encoder = new TextEncoder();

/** One line of at most LINE_BYTES bytes, cut with an ellipsis when longer. */
function fit(text: string): string {
  const line = text.replaceAll(/\s+/g, " ").trim();

  if (encoder.encode(line).length <= LINE_BYTES) return line;
  let cut = line.slice(0, LINE_BYTES);

  while (encoder.encode(`${cut}…`).length > LINE_BYTES) cut = cut.slice(0, -1);

  return `${cut}…`;
}

/** What delivery needs from the rest of ky, set up in src/server.ts. */
export type DeliveryParts = {
  readonly surfaced: Pick<Surfaced, "shown">;
  /** Put `content` in the chat by `requestId`: true once pi took it, false (writing nothing) while a run is going. */
  readonly submit: (session: string, content: string, requestId: string) => Promise<boolean>;
  /**
   * Post `text`, or with `cards` (a JSON array) those cards, in the chat as ky's own message by `requestId`, starting
   * nothing: true once pi took it, false (writing nothing) while a run is going.
   */
  readonly post: (session: string, text: string, requestId: string, cards?: string) => Promise<boolean>;
  /** Push `text`, posted in `session`, to the user's devices; never throws. */
  readonly notify: (session: string, text: string) => Promise<void>;
  /** Resolve once the chat has no run going. */
  readonly idle: (session: string) => Promise<void>;
  /** Work that outlives the call, as ctx.waitUntil. */
  readonly later: (work: Promise<void>) => void;
};

export class Deliveries {
  readonly #sql: SqlStorage;
  readonly #parts: DeliveryParts;
  /** Chats a flush found busy, waiting for their run to be over; one wait a chat. */
  readonly #waiting = new Set<string>();

  constructor(sql: SqlStorage, parts: DeliveryParts) {
    this.#sql = sql;
    this.#parts = parts;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_deliveries (
      id TEXT PRIMARY KEY,
      session TEXT NOT NULL,
      content TEXT NOT NULL,
      line TEXT NOT NULL,
      ref TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered_at INTEGER)`);

    // Looks came after events: a table from before has every row an event.
    if (!sql.exec("PRAGMA table_info(ky_deliveries)").toArray().some((column) => decodeOr(ColumnInfo, column, undefined)?.name === "kind")) {
      sql.exec("ALTER TABLE ky_deliveries ADD COLUMN kind TEXT NOT NULL DEFAULT 'event'");
    }

    // So did a run's cards: a row from before has none.
    if (!sql.exec("PRAGMA table_info(ky_deliveries)").toArray().some((column) => decodeOr(ColumnInfo, column, undefined)?.name === "cards")) {
      sql.exec("ALTER TABLE ky_deliveries ADD COLUMN cards TEXT");
    }
  }

  /** Deliver `item` by the rules above, once however often it is handed over. */
  async deliver(item: Delivery, now = Date.now()): Promise<void> {
    const known = this.#sql.exec("SELECT 1 FROM ky_deliveries WHERE id = ?", item.id).toArray().length > 0;

    if (!known) {
      this.#sql.exec(
        "INSERT INTO ky_deliveries (id, session, content, line, ref, kind, cards, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)",
        item.id,
        item.session,
        item.content,
        item.line,
        item.ref,
        item.kind ?? "event",
        item.cards ?? null,
        now
      );
    }

    await this.#flush(item.session);
  }

  /** Whether pi's request `requestId` is an event handed to this: a report, whose turn recalls as a user's message does (src/dreaming/recall.ts). */
  delivered(requestId: string): boolean {
    return this.#sql.exec("SELECT 1 FROM ky_deliveries WHERE id = ? AND kind = 'event'", requestId).toArray().length > 0;
  }

  /** A turn in `session` is ending: once it is over, what waits for that chat goes in. */
  atBoundary(session: string): void {
    if (this.#queued(session).length === 0) return;
    this.#parts.later(this.#afterRun(session));
  }

  /** On start: drop rows past keeping, and try again what a restart left queued. */
  recover(now = Date.now()): void {
    this.#sql.exec("DELETE FROM ky_deliveries WHERE created_at < ?", now - KEEP_MS);

    const sessions = this.#sql
      .exec("SELECT DISTINCT session FROM ky_deliveries WHERE state = 'queued'")
      .toArray()
      .flatMap((row) => decodeOr(SessionRow, row, undefined)?.session ?? []);

    for (const session of sessions) this.#parts.later(this.#afterRun(session));
  }

  async #afterRun(session: string): Promise<void> {
    await this.#parts.idle(session);
    await this.#flush(session);
  }

  /**
   * A flush found `session` busy: try again once its run is over, whatever ends it. A turn the user stops or that
   * fails yields no answer, so the turn's end alone would leave the item waiting for the chat's next turn.
   */
  #retry(session: string): void {
    if (this.#waiting.has(session)) return;
    this.#waiting.add(session);

    const wait = async () => {
      try {
        await this.#parts.idle(session);
      } finally {
        this.#waiting.delete(session);
      }

      await this.#flush(session);
    };

    this.#parts.later(wait());
  }

  #queued(session: string): Delivery[] {
    return this.#sql
      .exec("SELECT id, session, content, line, ref, kind, cards FROM ky_deliveries WHERE session = ? AND state = 'queued' ORDER BY created_at, id", session)
      .toArray()
      .flatMap((row) => decodeOr(DeliverySchema, row, undefined) ?? []);
  }

  /**
   * Put what waits for `session` in it, oldest first, while it is idle: an event starts a run, so what follows
   * waits for that run's end, as does all of it when the chat is busy; a look's message starts none. Two flushes
   * at once are safe: pi takes a request id once, and a row is marked once.
   */
  async #flush(session: string): Promise<void> {
    for (const item of this.#queued(session)) {
      const kind = item.kind ?? "event";
      // An event or another chat's message is answered by the chat's agent; a look's message or a post is posted as written.
      const put = kind === "look" || kind === "post" ? this.#parts.post : this.#parts.submit;
      // Its cards first, by their own request id, so a flush that finds the chat busy after them posts them once.
      const carded = !item.cards || (await this.#parts.post(session, "", `${item.id}:cards`, item.cards));

      // A post that is only cards has no text to post after them.
      if (!carded || ((!item.cards || item.content !== "") && !(await put(session, item.content, item.id)))) {
        this.#retry(session);

        return;
      }

      const now = Date.now();
      const marked = this.#sql.exec("UPDATE ky_deliveries SET state = 'chat', delivered_at = ? WHERE id = ? AND state = 'queued' RETURNING id", now, item.id).toArray().length > 0;

      // ky talking to itself is nothing to show the user.
      if (kind === "chat") continue;
      this.#parts.surfaced.shown({ kind, ref: item.ref, item: item.id, text: fit(item.line), expiresAt: now + EVENT_EXPIRY_MS }, now);

      // Only the flush that marked it pushes it; the push neither holds up the next item nor fails this one.
      if (marked) this.#parts.later(this.#parts.notify(session, item.line));
    }
  }
}

/** At each turn's end, what waits for that chat goes in once the turn is over. */
export function deliveryExtension(deliveries: Deliveries): Extension {
  return defineExtension({
    name: "deliveries",
    hooks: [
      hook(GenerationTask, {
        onYield(_answer, api) {
          deliveries.atBoundary(String(api.conversationId));

          return undefined;
        }
      })
    ]
  });
}
