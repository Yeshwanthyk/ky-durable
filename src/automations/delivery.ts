import { defineExtension, type Extension, GenerationTask, hook } from "@earendil-works/pi-durable";
import type { ChatList } from "../chats";
import type { Brief, Presence, Proactivity, Surfaced } from "../dreaming/wiring";
import { decodeOr } from "../core/decode";
import { type Delivery, DeliverySchema, SessionRow } from "./contract";

/**
 * How what an automation tells a chat reaches the user: a run's report (src/skills/subagents.ts) or its notice
 * that its gate paused it (src/automations/automations.ts). It enters a chat only between turns, never into a
 * run: an idle chat takes it at once, and a busy one when its turn is over, so it never steers the work the user
 * is watching. With Settings › Proactivity at boundary and the user away (no message sent for PRESENT_MS), it
 * goes to today's brief instead, as an event line, and its chat moves up in the sidebar. At off and brief, the
 * user turned nothing on, so reports go to the chat as they always have. When the brief will not take a line (it
 * holds its 3 event lines, or proactivity was turned off since), the report goes to the chat after all: a report
 * the user asked for is never lost.
 *
 * Each item has a row, keyed by its id. Handed over twice, it is delivered once. A queued one waits in its row,
 * so an eviction or a restart keeps it, and it is tried again when the chat's next turn ends, on the next
 * delivery to that chat, and when the object starts. Its id is also its request id with pi, so a submit a crash
 * cut off before its row was marked is taken once when tried again.
 */

/** A user who sent a message this recently is at the keyboard; longer (a meeting, lunch) and a chat line waits unseen. */
const PRESENT_MS = 10 * 60_000;

/** A line in a chat counts as unhandled for a day, then as expired, as a brief line does at midnight. */
const EVENT_EXPIRY_MS = 86_400_000;

/** Rows kept after their delivery, so a late second hand-over is still known. */
const KEEP_MS = 30 * 86_400_000;

/** The brief's limits on a line and on its chip (src/dreaming/brief.ts). */
const LINE_BYTES = 280;

const CHIP_CHARS = 500;

const encoder = new TextEncoder();

/** One line of at most LINE_BYTES bytes, cut with an ellipsis when longer. */
function fit(text: string): string {
  const line = text.replaceAll(/\s+/g, " ").trim();

  if (encoder.encode(line).length <= LINE_BYTES) return line;
  let cut = line.slice(0, LINE_BYTES);

  while (encoder.encode(`${cut}…`).length > LINE_BYTES) cut = cut.slice(0, -1);

  return `${cut}…`;
}

/** The chip sends what the chat would have been given, cut to fit. */
const chipOf = (content: string) => (content.length <= CHIP_CHARS ? content : `${content.slice(0, CHIP_CHARS - 1)}…`);

/** What delivery needs from the rest of ky, set up in src/server.ts. */
export type DeliveryParts = {
  readonly presence: Pick<Presence, "last">;
  readonly proactivity: Pick<Proactivity, "level">;
  readonly brief: Pick<Brief, "append">;
  readonly surfaced: Pick<Surfaced, "shown">;
  readonly chats: Pick<ChatList, "answered">;
  /** Put `content` in the chat by `requestId`: true once pi took it, false (writing nothing) while a run is going. */
  readonly submit: (session: string, content: string, requestId: string) => Promise<boolean>;
  /** Resolve once the chat has no run going. */
  readonly idle: (session: string) => Promise<void>;
  /** Work that outlives the call, as ctx.waitUntil. */
  readonly later: (work: Promise<void>) => void;
};

export class Deliveries {
  readonly #sql: SqlStorage;
  readonly #parts: DeliveryParts;

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
  }

  /** Deliver `item` by the rules above, once however often it is handed over. */
  async deliver(item: Delivery, now = Date.now()): Promise<void> {
    const known = this.#sql.exec("SELECT 1 FROM ky_deliveries WHERE id = ?", item.id).toArray().length > 0;

    // The brief's write and the row's go together, with nothing awaited between them.
    if (!known && !(this.#away(now) && this.#toBrief(item, now))) {
      this.#sql.exec(
        "INSERT INTO ky_deliveries (id, session, content, line, ref, state, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)",
        item.id,
        item.session,
        item.content,
        item.line,
        item.ref,
        now
      );
    }

    await this.#flush(item.session);
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

  /** Proactivity is at boundary and the user has sent nothing for PRESENT_MS. */
  #away(now: number): boolean {
    return this.#parts.proactivity.level() === "boundary" && now - this.#parts.presence.last() > PRESENT_MS;
  }

  /** Today's brief takes the line, and the chat moves up in the sidebar; false when the brief refuses it. */
  #toBrief(item: Delivery, now: number): boolean {
    try {
      this.#parts.brief.append({ text: fit(item.line), chip: chipOf(item.content) }, { loop: "event", ref: item.ref }, now);
    } catch {
      // Full, or proactivity turned off since: the chat gets it instead, as it would at off.
      return false;
    }

    this.#sql.exec(
      "INSERT INTO ky_deliveries (id, session, content, line, ref, state, created_at, delivered_at) VALUES (?, ?, ?, ?, ?, 'brief', ?, ?)",
      item.id,
      item.session,
      item.content,
      item.line,
      item.ref,
      now,
      now
    );
    this.#parts.chats.answered(item.session);

    return true;
  }

  async #afterRun(session: string): Promise<void> {
    await this.#parts.idle(session);
    await this.#flush(session);
  }

  #queued(session: string): Delivery[] {
    return this.#sql
      .exec("SELECT id, session, content, line, ref FROM ky_deliveries WHERE session = ? AND state = 'queued' ORDER BY created_at, id", session)
      .toArray()
      .flatMap((row) => decodeOr(DeliverySchema, row, undefined) ?? []);
  }

  /**
   * Put what waits for `session` in it, oldest first, while it is idle: the first starts a run, so the rest wait
   * for that run's end. Two flushes at once are safe: pi takes a request id once, and a row is marked once.
   */
  async #flush(session: string): Promise<void> {
    for (const item of this.#queued(session)) {
      if (!(await this.#parts.submit(session, item.content, item.id))) return;
      const now = Date.now();
      this.#sql.exec("UPDATE ky_deliveries SET state = 'chat', delivered_at = ? WHERE id = ? AND state = 'queued'", now, item.id);
      this.#parts.surfaced.shown({ kind: "event", loop: "event", ref: item.ref, item: item.id, text: fit(item.line), expiresAt: now + EVENT_EXPIRY_MS }, now);
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
