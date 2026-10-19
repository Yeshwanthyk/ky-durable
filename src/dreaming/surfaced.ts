import Type from "typebox";
import { decodeOr } from "../core/decode";
import { shownItem, type ShownItem, SURFACED_OUTCOMES, type SurfacedOutcome } from "./contract";

/**
 * What ky put in front of the user unasked, and what became of it: one row per thing shown, with its outcome.
 * A thing is shown with no outcome; a recall block may be marked missed, and whatever is still unhandled when it
 * expires becomes expired, lazily, on the next read. Every outcome is final. The night dream prunes the settled rows.
 */

/**
 * What is surfaced: an event, an automation's report put in a chat between turns (src/automations/delivery.ts),
 * which has no outcome to tap yet, so it expires after a day; a look, a message a look posted in the main chat
 * (src/dreaming/looks.ts), which expires the same way and is how the next look knows what was said; a post, an
 * automation's report posted as written, which the next look reads the same way; or a recall,
 * the context recalled for a user's message (src/dreaming/recall.ts). Rows an older ky wrote for its brief and its
 * suggestions stay, unread.
 */
export type SurfacedKind = "event" | "look" | "post" | "recall";

/** A thing as it is shown: what it is, what it rests on, its key and text, when it goes. */
export type Shown = {
  readonly kind: SurfacedKind;
  /** What it rests on, like anticipation:12. */
  readonly ref: string;
  /** Which one it is, like a report's delivery id. */
  readonly item: string;
  readonly text: string;
  readonly expiresAt: number;
};

/** Settled rows are kept this long after their outcome, then pruned by the night dream. */
const KEEP_MS = 60 * 86_400_000;

/** A ref and when it was last shown. */
const RefShown = Type.Object({ ref: Type.String(), at: Type.Number() });

export class Surfaced {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    // loop named what made a row; nothing reads it, so a row now repeats its kind there.
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_surfaced (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      loop TEXT NOT NULL,
      ref TEXT NOT NULL,
      item TEXT NOT NULL,
      text TEXT NOT NULL,
      shown_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      outcome TEXT,
      outcome_at INTEGER,
      UNIQUE (kind, item))`);
    // expire() runs on most reads: it finds the unhandled rows past their expiry by this.
    sql.exec("CREATE INDEX IF NOT EXISTS ky_surfaced_open ON ky_surfaced (outcome, expires_at)");
  }

  /** Drop the rows settled more than KEEP_MS before `now`; an unhandled one stays until it settles. How many. */
  prune(now = Date.now()): number {
    return this.#sql.exec("DELETE FROM ky_surfaced WHERE outcome IS NOT NULL AND outcome_at < ? RETURNING id", now - KEEP_MS).toArray().length;
  }

  /** `entry` was shown at `now`; a second show of the same item is the first one. */
  shown(entry: Shown, now = Date.now()): void {
    this.#sql.exec(
      "INSERT INTO ky_surfaced (kind, loop, ref, item, text, shown_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kind, item) DO NOTHING",
      entry.kind,
      entry.kind,
      entry.ref,
      entry.item,
      entry.text,
      now,
      entry.expiresAt
    );
  }

  /** The item's outcome: undefined before it is shown, null while it has none. */
  outcomeOf(kind: SurfacedKind, item: string): SurfacedOutcome | null | undefined {
    const row = this.#sql.exec("SELECT outcome FROM ky_surfaced WHERE kind = ? AND item = ?", kind, item).toArray()[0];

    if (row === undefined) return undefined;

    return SURFACED_OUTCOMES.find((each) => each === row.outcome) ?? null;
  }

  /** Record what became of a shown item. Refused when it was never shown, and once it has an outcome. */
  outcome(kind: SurfacedKind, item: string, outcome: SurfacedOutcome, now = Date.now()): void {
    this.expire(now);
    const was = this.outcomeOf(kind, item);

    if (was === undefined) throw new Error(`Nothing shown as ${item}.`);

    if (was !== null) throw new Error(`${item} is ${was} already.`);

    this.#sql.exec("UPDATE ky_surfaced SET outcome = ?, outcome_at = ? WHERE kind = ? AND item = ?", outcome, now, kind, item);
  }

  /**
   * The `kind` shown since `from` whose item starts with `prefix`, newest first, at most `limit`: a chat's recall
   * blocks, by their `session#entry` items.
   */
  items(kind: SurfacedKind, prefix: string, from: number, limit: number): ShownItem[] {
    return this.#sql
      .exec(
        "SELECT item, text FROM ky_surfaced WHERE kind = ? AND item >= ? AND item < ? AND shown_at >= ? ORDER BY shown_at DESC, id DESC LIMIT ?",
        kind,
        prefix,
        // Every item with the prefix sorts before the prefix with its last character's successor.
        `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`,
        from,
        limit
      )
      .toArray()
      .flatMap((row) => shownItem(row) ?? []);
  }

  /** When each ref of `kind` was last shown, by ref. */
  lastShown(kind: SurfacedKind): Map<string, number> {
    const rows = this.#sql
      .exec("SELECT ref, max(shown_at) AS at FROM ky_surfaced WHERE kind = ? GROUP BY ref", kind)
      .toArray()
      .flatMap((row) => decodeOr(RefShown, row, undefined) ?? []);

    return new Map(rows.map((row) => [row.ref, row.at]));
  }

  /** Shown items still unhandled when they expired: expired, at their expiry. How many. */
  expire(now = Date.now()): number {
    return this.#sql.exec("UPDATE ky_surfaced SET outcome = 'expired', outcome_at = expires_at WHERE outcome IS NULL AND expires_at <= ? RETURNING id", now).toArray().length;
  }
}
