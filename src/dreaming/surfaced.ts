import { outcomeCount, shownItem, type ShownItem, summaryOf, SURFACED_OUTCOMES, type SurfacedOutcome } from "./contract";

/**
 * What ky put in front of the user unasked, and what they did with it: one row per thing shown (a brief line,
 * a turn-start recall block; a boundary line later), with its outcome. A line is shown with no outcome; the user acts on it (taps
 * its chip), pins or dismisses it; whatever is still unhandled when it expires (the brief's midnight) becomes
 * expired, lazily, on the next read. A pinned one may still be acted on or dismissed; every other outcome is final.
 *
 * The counts feed the dream ("What you surfaced last week") and Settings › Proactivity, and the brief's cap
 * lowers itself from 3 to 2 after two weeks in a row with acceptance (acted or pinned, of shown) below 25%.
 */

/** What is surfaced: a brief line, or the context recalled for a user's message (src/dreaming/recall.ts). */
export type SurfacedKind = "brief" | "recall";

/** A thing as it is shown: what it is, which loop made it, what it rests on, its key and text, when it goes. */
export type Shown = {
  readonly kind: SurfacedKind;
  readonly loop: string;
  /** What it rests on, like anticipation:12. */
  readonly ref: string;
  /** Which one it is, like the brief line 2026-10-16#0. */
  readonly item: string;
  readonly text: string;
  readonly expiresAt: number;
};

/** A week's shown things by outcome, `open` for the ones with none yet. */
export type Week = Readonly<Record<SurfacedOutcome | "open", number>> & { readonly shown: number };

const WEEK_MS = 7 * 86_400_000;

/** The brief's cap, and the lower one after two weak weeks. */
const BRIEF_CAP = 3;

const WEAK_CAP = 2;

/** Acceptance below this, two weeks in a row, lowers the cap. */
const WEAK_ACCEPTANCE = 0.25;

export class Surfaced {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
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
  }

  /** `entry` was shown at `now`; a second show of the same item is the first one. */
  shown(entry: Shown, now = Date.now()): void {
    this.#sql.exec(
      "INSERT INTO ky_surfaced (kind, loop, ref, item, text, shown_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kind, item) DO NOTHING",
      entry.kind,
      entry.loop,
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

  /**
   * Record what the user did with a shown item. Refused when it was never shown, and once its outcome is final:
   * only an unhandled one, or a pinned one becoming acted or dismissed, takes a new one.
   */
  outcome(kind: SurfacedKind, item: string, outcome: SurfacedOutcome, now = Date.now()): void {
    this.expire(now);
    const was = this.outcomeOf(kind, item);

    if (was === undefined) throw new Error(`Nothing shown as ${item}.`);

    if (was !== null && !(was === "pinned" && (outcome === "acted" || outcome === "dismissed"))) throw new Error(`${item} is ${was} already.`);

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

  /** Shown items still unhandled when they expired: expired, at their expiry. How many. */
  expire(now = Date.now()): number {
    return this.#sql.exec("UPDATE ky_surfaced SET outcome = 'expired', outcome_at = expires_at WHERE outcome IS NULL AND expires_at <= ? RETURNING id", now).toArray().length;
  }

  /** What became of the `kind` shown in [`from`, `to`). */
  week(kind: SurfacedKind, from: number, to: number): Week {
    const counts: Record<SurfacedOutcome | "open", number> = { acted: 0, pinned: 0, dismissed: 0, ignored: 0, expired: 0, missed: 0, open: 0 };

    for (const raw of this.#sql.exec("SELECT outcome, COUNT(*) AS n FROM ky_surfaced WHERE kind = ? AND shown_at >= ? AND shown_at < ? GROUP BY outcome", kind, from, to).toArray()) {
      const row = outcomeCount(raw);

      if (row !== undefined) counts[row.outcome ?? "open"] += row.n;
    }

    return { ...counts, shown: Object.values(counts).reduce((sum, n) => sum + n, 0) };
  }

  /** The week before `now`: what became of what was shown, after expiring what is due. */
  lastWeek(kind: SurfacedKind, now = Date.now()): Week {
    this.expire(now);

    return this.week(kind, now - WEEK_MS, now);
  }

  /** The texts of the `kind` dismissed in the week before `now`, newest first. */
  dismissed(kind: SurfacedKind, now = Date.now(), limit = 10): string[] {
    return this.#sql
      .exec("SELECT text FROM ky_surfaced WHERE kind = ? AND outcome = 'dismissed' AND shown_at >= ? ORDER BY shown_at DESC, id DESC LIMIT ?", kind, now - WEEK_MS, limit)
      .toArray()
      // A text row, as a summary's is.
      .flatMap((row) => summaryOf(row) ?? []);
  }

  /** How many brief lines the dream may write: 2 after two weeks in a row with acceptance below 25%, otherwise 3. */
  briefCap(now = Date.now()): number {
    this.expire(now);

    const weak = (from: number) => {
      const week = this.week("brief", from, from + WEEK_MS);

      return week.shown > 0 && (week.acted + week.pinned) / week.shown < WEAK_ACCEPTANCE;
    };

    return weak(now - WEEK_MS) && weak(now - 2 * WEEK_MS) ? WEAK_CAP : BRIEF_CAP;
  }
}
