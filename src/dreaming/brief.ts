import type { Anticipations } from "./anticipations";
import { type BriefLine, briefRow, type BriefSource, type BriefView } from "./contract";
import { localDay, nextMidnight } from "./local-day";
import type { Proactivity } from "./proactivity";
import type { Surfaced } from "./surfaced";

/**
 * The brief: a few lines ky has ready for the user's day, shown once as a card above the chat when they first
 * come back that day (src/sockets.ts, on hello), never as a chat message, so it starts no run. One row per local
 * day; each line cites where it came from (an anticipation, or the message or memory it rests on) and may carry
 * a chip: an ask the user can send with a tap. It goes at the user's midnight.
 *
 * Who writes it: the nightly dream, through the `anticipate` tool's brief action (at most 3 lines, 2 after two
 * weak weeks: Surfaced.briefCap), and events while the user is away, through `append` with loop "event".
 * Nothing is written, and no card shown, while Settings › Proactivity is off.
 *
 * Each line shown becomes a ky_surfaced row (src/dreaming/surfaced.ts), and the card's taps its outcome: a chip
 * is acted, pin keeps the line on the card for the day (and pins its anticipation), dismiss drops it (and closes
 * its anticipation as dismissed for the user); dismissing the whole card drops every line but closes nothing.
 */

const TEXT_BYTES = 280;

const CHIP_CHARS = 500;

/** Lines events may add in a day, besides the dream's. */
const EVENT_CAP = 3;

/** Days a past brief is kept before it is pruned. */
const KEEP_MS = 30 * 86_400_000;

/** A line as its writer states it: one line of text, and the ask its chip sends. */
export type BriefDraft = { readonly text: string; readonly chip?: string | undefined };

const encoder = new TextEncoder();

/** One line of at most TEXT_BYTES bytes, or an error saying what is wrong. */
function checkLine(text: string): string {
  const line = text.trim();

  if (line === "" || /[\r\n]/.test(line)) throw new Error("A brief line is one line of text.");
  const bytes = encoder.encode(line).length;

  if (bytes > TEXT_BYTES) throw new Error(`Too long: ${bytes} bytes, limit ${TEXT_BYTES}.`);

  return line;
}

/** The anticipation a line rests on, from its ref; undefined for a message, memory or event. */
const anticipationOf = (line: BriefLine) => {
  const match = /^anticipation:(\d+)$/.exec(line.source.ref);

  return match === null ? undefined : Number(match[1]);
};

const keyOf = (day: string, index: number) => `${day}#${index}`;

export class Brief {
  readonly #sql: SqlStorage;
  /** The user's time zone, or null while ky has not seen it. */
  readonly #zone: () => string | null;
  readonly #surfaced: Surfaced;
  readonly #proactivity: Proactivity;
  readonly #anticipations: Anticipations;

  constructor(
    sql: SqlStorage,
    parts: { readonly zone: () => string | null; readonly surfaced: Surfaced; readonly proactivity: Proactivity; readonly anticipations: Anticipations }
  ) {
    this.#sql = sql;
    this.#zone = parts.zone;
    this.#surfaced = parts.surfaced;
    this.#proactivity = parts.proactivity;
    this.#anticipations = parts.anticipations;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_brief (
      day TEXT PRIMARY KEY,
      lines TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL)`);
  }

  /** Today's local day and its lines, before its midnight. */
  #today(now: number) {
    const zone = this.#zone();
    const day = localDay(zone, now);
    const row = briefRow(this.#sql.exec("SELECT lines, expires_at FROM ky_brief WHERE day = ? AND expires_at > ?", day, now).toArray()[0]);

    return { day, expiresAt: row?.expires_at ?? nextMidnight(zone, now), lines: row?.lines ?? [] };
  }

  /**
   * Add a line to today's brief, from `source`; its key (like 2026-10-16#0). Refused while proactivity is off, for
   * a line that is not one line of text, when today's brief already has a line from the same ref, and when its
   * loop's cap is reached: the dream's Surfaced.briefCap, EVENT_CAP for events.
   */
  append(line: BriefDraft, source: BriefSource, now = Date.now()): string {
    if (this.#proactivity.level() === "off") throw new Error("Proactivity is off: ky writes no brief.");
    const text = checkLine(line.text);
    const chip = line.chip?.trim() || null;

    if (chip !== null && chip.length > CHIP_CHARS) throw new Error(`The chip is ${chip.length} characters, limit ${CHIP_CHARS}.`);
    const today = this.#today(now);

    if (today.lines.some((each) => each.source.ref === source.ref)) throw new Error(`Today's brief already has a line from ${source.ref}.`);
    const cap = source.loop === "dream" ? this.#surfaced.briefCap(now) : EVENT_CAP;

    if (today.lines.filter((each) => each.source.loop === source.loop).length >= cap) {
      throw new Error(`Today's brief holds ${cap} ${source.loop} lines and is full; silence is fine.`);
    }

    const lines = [...today.lines, { text, source, chip }];
    this.#sql.exec("DELETE FROM ky_brief WHERE expires_at < ?", now - KEEP_MS);
    this.#sql.exec(
      `INSERT INTO ky_brief (day, lines, created_at, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (day) DO UPDATE SET lines = excluded.lines, expires_at = excluded.expires_at`,
      today.day,
      JSON.stringify(lines),
      now,
      today.expiresAt
    );

    return keyOf(today.day, lines.length - 1);
  }

  /**
   * The card for a browser that just said hello: today's lines it has not shown yet, now recorded as shown, and
   * the ones the user pinned. Undefined when there are none, or while proactivity is off.
   */
  show(now = Date.now()): BriefView | undefined {
    if (this.#proactivity.level() === "off") return undefined;
    this.#surfaced.expire(now);
    const today = this.#today(now);

    const lines = today.lines.flatMap((line, index) => {
      const key = keyOf(today.day, index);
      const outcome = this.#surfaced.outcomeOf("brief", key);

      if (outcome === undefined) this.#surfaced.shown({ kind: "brief", loop: line.source.loop, ref: line.source.ref, item: key, text: line.text, expiresAt: today.expiresAt }, now);
      else if (outcome !== "pinned") return [];

      return [{ key, text: line.text, chip: line.chip, pinned: outcome === "pinned" }];
    });

    return lines.length === 0 ? undefined : { day: today.day, expires_at: today.expiresAt, lines };
  }

  /** Today's line `key`, or an error when there is none. */
  #line(key: string, now: number): BriefLine {
    const today = this.#today(now);
    const [day, index] = key.split("#");
    const line = day === today.day ? today.lines[Number(index)] : undefined;

    if (line === undefined) throw new Error(`No line ${key} in today's brief.`);

    return line;
  }

  /** The user tapped the line's chip: acted. */
  act(key: string, now = Date.now()): void {
    this.#line(key, now);
    this.#surfaced.outcome("brief", key, "acted", now);
  }

  /** The user keeps the line on the card for the day, and its anticipation for good. */
  pin(key: string, now = Date.now()): void {
    const anticipation = anticipationOf(this.#line(key, now));
    this.#surfaced.outcome("brief", key, "pinned", now);

    if (anticipation !== undefined) this.#anticipations.pin(anticipation);
  }

  /** The user dismissed the line: its anticipation, while still open, closes as dismissed for them. */
  dismiss(key: string, now = Date.now()): void {
    const anticipation = anticipationOf(this.#line(key, now));
    this.#surfaced.outcome("brief", key, "dismissed", now);

    if (anticipation !== undefined && ["open", "surfaced"].includes(this.#anticipations.get(anticipation).status)) {
      this.#anticipations.close(anticipation, "dismissed", "user", undefined, now);
    }
  }

  /** The user dismissed the whole card: each line on it is dismissed; their anticipations stay as they are. */
  dismissAll(now = Date.now()): void {
    const today = this.#today(now);

    today.lines.forEach((_line, index) => {
      const key = keyOf(today.day, index);
      const outcome = this.#surfaced.outcomeOf("brief", key);

      if (outcome === null || outcome === "pinned") this.#surfaced.outcome("brief", key, "dismissed", now);
    });
  }
}
