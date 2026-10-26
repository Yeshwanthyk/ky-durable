import { defineExtension, type Extension, GenerationTask, hook } from "@earendil-works/pi-durable";
import type { Surfaced } from "../dreaming/wiring";
import { decodeOr } from "../core/decode";
import { ColumnInfo, type Delivery, DeliverySchema, SessionRow } from "./contract";

const EVENT_EXPIRY_MS = 86_400_000;

const KEEP_MS = 30 * 86_400_000;

const LINE_BYTES = 280;

const encoder = new TextEncoder();

function fit(text: string): string {
  const line = text.replaceAll(/\s+/g, " ").trim();

  if (encoder.encode(line).length <= LINE_BYTES) return line;
  let cut = line.slice(0, LINE_BYTES);

  while (encoder.encode(`${cut}…`).length > LINE_BYTES) cut = cut.slice(0, -1);

  return `${cut}…`;
}

type DeliveryParts = {
  readonly surfaced: Pick<Surfaced, "shown">;
  readonly submit: (session: string, content: string, requestId: string) => Promise<boolean>;
  readonly post: (session: string, text: string, requestId: string, cards?: string) => Promise<boolean>;
  readonly notify: (session: string, text: string) => Promise<void>;
  readonly idle: (session: string) => Promise<void>;
  readonly later: (work: Promise<void>) => void;
};

export class Deliveries {
  readonly #sql: SqlStorage;
  readonly #parts: DeliveryParts;
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

    const columns = sql
      .exec("PRAGMA table_info(ky_deliveries)")
      .toArray()
      .flatMap((column) => decodeOr(ColumnInfo, column, undefined)?.name ?? []);

    if (!columns.includes("kind")) sql.exec("ALTER TABLE ky_deliveries ADD COLUMN kind TEXT NOT NULL DEFAULT 'event'");

    if (!columns.includes("cards")) sql.exec("ALTER TABLE ky_deliveries ADD COLUMN cards TEXT");
  }

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

  delivered(requestId: string): boolean {
    return this.#sql.exec("SELECT 1 FROM ky_deliveries WHERE id = ? AND kind = 'event'", requestId).toArray().length > 0;
  }

  atBoundary(session: string): void {
    if (this.#queued(session).length === 0) return;
    this.#parts.later(this.#afterRun(session));
  }

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

  async #flush(session: string): Promise<void> {
    for (const item of this.#queued(session)) {
      const kind = item.kind ?? "event";
      const put = kind === "look" || kind === "post" ? this.#parts.post : this.#parts.submit;
      const carded = !item.cards || (await this.#parts.post(session, "", `${item.id}:cards`, item.cards));

      if (!carded || ((!item.cards || item.content !== "") && !(await put(session, item.content, item.id)))) {
        this.#retry(session);

        return;
      }

      const now = Date.now();
      const marked = this.#sql.exec("UPDATE ky_deliveries SET state = 'chat', delivered_at = ? WHERE id = ? AND state = 'queued' RETURNING id", now, item.id).toArray().length > 0;

      if (kind === "chat") continue;
      this.#parts.surfaced.shown({ kind, ref: item.ref, item: item.id, text: fit(item.line), expiresAt: now + EVENT_EXPIRY_MS }, now);

      if (marked) this.#parts.later(this.#parts.notify(session, item.line));
    }
  }
}

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
