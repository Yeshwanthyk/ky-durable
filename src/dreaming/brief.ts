import { Type } from "@earendil-works/pi-ai";
import { decodeOr } from "../core/decode";
import type { Anticipations } from "./anticipations";
import { type BriefCardLine, type BriefLine, briefRow, type BriefSource, type BriefView } from "./contract";
import { localDay, nextMidnight } from "./local-day";
import type { Proactivity } from "./proactivity";
import type { Surfaced } from "./surfaced";

/**
 * The brief: a few lines ky has ready for the user's day, shown as a card above the chat (src/sockets.ts sends
 * it on every hello that day, and to every open page when a line is written), never as a chat message, so it
 * starts no run. One row per local day; each line cites where it came from (an anticipation, or the message or
 * memory it rests on), which the card shows, and may carry a chip: an ask the user can send. It goes at the
 * user's midnight, all but its event lines the user has not handled (an automation's report from while they were
 * away), which the next day's brief starts with: a report the user asked for is never lost.
 *
 * Who writes it: the nightly dream, through the `anticipate` tool's brief action, and events while the user is
 * away, through `append` with loop "event"; together at most Surfaced.briefCap lines a day (3, or 2 after two
 * weak weeks). Nothing is written, no card shown and no tap taken while Settings › Proactivity is off.
 *
 * A line becomes a ky_surfaced row (src/dreaming/surfaced.ts) when the user's screen shows it (`seen`, which
 * also marks its anticipation surfaced), and the card's taps its outcome: sending the chip's ask is acted, pin
 * keeps the line on the card for the day (and pins its anticipation), dismiss drops it (and closes a machine's
 * unpinned anticipation as dismissed for the user); Dismiss all clears the lines the card showed, pinned ones
 * aside, and closes nothing. Until a line has an outcome, every hello that day brings it back.
 */

const TEXT_BYTES = 280;

const CHIP_CHARS = 500;

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

/** The number a ref names after its kind, like 12 for anticipation:12; undefined for another kind. */
const refId = (ref: string, kind: "anticipation" | "message" | "memory") => {
  const match = new RegExp(`^${kind}:(\\d+)$`).exec(ref);

  return match === null ? undefined : Number(match[1]);
};

/** The anticipation a line rests on, from its ref; undefined for a message, memory or event. */
const anticipationOf = (line: BriefLine) => refId(line.source.ref, "anticipation");

/**
 * A line's key: the day and its place in that day's row. A day's row is only ever appended to, and is read
 * whether or not its midnight passed (a zone change can bring a day back), so a key never names two lines.
 */
const keyOf = (day: string, index: number) => `${day}#${index}`;

/** A message's time, from pi's entry. */
const StampRow = Type.Object({ at: Type.Number() });

/** A past brief's day, read with its row. */
const DayRow = Type.Object({ day: Type.String() });

const shortDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export class Brief {
  readonly #sql: SqlStorage;
  /** The user's time zone, or null while ky has not seen it. */
  readonly #zone: () => string | null;
  readonly #surfaced: Surfaced;
  readonly #proactivity: Proactivity;
  readonly #anticipations: Anticipations;
  readonly #listeners = new Set<() => void>();

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

  /** Call `listener` whenever a line is written. */
  onChange(listener: () => void): void {
    this.#listeners.add(listener);
  }

  /**
   * Today's local day, its midnight, and its lines, whether or not the row's own midnight passed. A day with no row
   * yet starts with the event lines the last brief carried that the user never handled.
   */
  #today(now: number) {
    const zone = this.#zone();
    const day = localDay(zone, now);
    const expiresAt = nextMidnight(zone, now);
    const row = briefRow(this.#sql.exec("SELECT lines, expires_at FROM ky_brief WHERE day = ?", day).toArray()[0]);

    return { day, expiresAt, lines: row?.lines ?? this.#carry(day, expiresAt, now) };
  }

  /**
   * The event lines of the last brief before `day` with no outcome (never shown, shown and left, or expired at its
   * midnight), up to the cap, written as `day`'s row so their keys hold. The old line's showing still counts as
   * expired; the carried one is shown afresh.
   */
  #carry(day: string, expiresAt: number, now: number): BriefLine[] {
    const raw = this.#sql.exec("SELECT day, lines, expires_at FROM ky_brief WHERE day < ? ORDER BY day DESC LIMIT 1", day).toArray()[0];
    const last = decodeOr(DayRow, raw, undefined)?.day;

    if (last === undefined) return [];

    const unhandled = (index: number) => {
      const outcome = this.#surfaced.outcomeOf("brief", keyOf(last, index));

      return outcome === undefined || outcome === null || outcome === "expired";
    };

    const lines = (briefRow(raw)?.lines ?? []).filter((line, index) => line.source.loop === "event" && unhandled(index)).slice(0, this.#surfaced.briefCap(now));

    if (lines.length === 0) return [];
    this.#sql.exec("INSERT INTO ky_brief (day, lines, created_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (day) DO NOTHING", day, JSON.stringify(lines), now, expiresAt);

    return lines;
  }

  /**
   * Add a line to today's brief, from `source`; its key (like 2026-10-16#0). Refused while proactivity is off, for
   * a line that is not one line of text, when today's brief already has a line from the same ref, and when today
   * holds Surfaced.briefCap lines, whichever loop wrote them.
   */
  append(line: BriefDraft, source: BriefSource, now = Date.now()): string {
    this.#checkOn();
    const text = checkLine(line.text);
    const chip = line.chip?.trim() || null;

    if (chip !== null && chip.length > CHIP_CHARS) throw new Error(`The chip is ${chip.length} characters, limit ${CHIP_CHARS}.`);
    const today = this.#today(now);

    if (today.lines.some((each) => each.source.ref === source.ref)) throw new Error(`Today's brief already has a line from ${source.ref}.`);
    const cap = this.#surfaced.briefCap(now);

    if (today.lines.length >= cap) throw new Error(`Today's brief holds ${cap} lines and is full; silence is fine.`);

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

    for (const listener of this.#listeners) listener();

    return keyOf(today.day, lines.length - 1);
  }

  /**
   * The card as every page should show it now: today's lines with no outcome yet, seen or not, and the pinned
   * ones; no lines while proactivity is off, which clears the card.
   */
  view(now = Date.now()): BriefView {
    const today = this.#today(now);

    if (this.#proactivity.level() === "off") return { day: today.day, expires_at: today.expiresAt, lines: [] };
    this.#surfaced.expire(now);

    const lines = today.lines.flatMap((line, index): BriefCardLine[] => {
      const key = keyOf(today.day, index);
      const outcome = this.#surfaced.outcomeOf("brief", key);

      if (outcome !== undefined && outcome !== null && outcome !== "pinned") return [];

      return [{ key, text: line.text, source: this.#sourceOf(line), chip: line.chip, pinned: outcome === "pinned" }];
    });

    return { day: today.day, expires_at: today.expiresAt, lines };
  }

  /** Where a line came from, as the card says it: like "anticipation #12 · chat 14 Oct", or "event". */
  #sourceOf(line: BriefLine): string {
    const { ref } = line.source;
    const anticipation = refId(ref, "anticipation");
    const message = refId(ref, "message");
    const memory = refId(ref, "memory");

    if (message !== undefined) return this.#chatOn(message);

    if (memory !== undefined) return `memory #${memory}`;

    if (anticipation === undefined) return line.source.loop;
    const evidence = this.#anticipations.open().find((row) => row.id === anticipation)?.evidence;
    const first = evidence?.messages[0] === undefined ? (evidence?.memories[0] === undefined ? undefined : `memory #${evidence.memories[0]}`) : this.#chatOn(evidence.messages[0]);

    return first === undefined ? `anticipation #${anticipation}` : `anticipation #${anticipation} · ${first}`;
  }

  /** A chat message as a source: the local day it was said on, like "chat 14 Oct". */
  #chatOn(message: number): string {
    const row = decodeOr(StampRow, this.#sql.exec("SELECT json_extract(record, '$.model[0].timestamp') AS at FROM pi_entries WHERE id = ?", message).toArray()[0], undefined);

    return row === undefined ? `chat #${message}` : `chat ${shortDate.format(Date.parse(localDay(this.#zone(), row.at)))}`;
  }

  /** Refused while proactivity is off: ky writes no brief, and the card's taps are not taken. */
  #checkOn(): void {
    if (this.#proactivity.level() === "off") throw new Error("Proactivity is off: ky writes no brief.");
  }

  /** Today's line `key` and today's midnight; undefined when today has no such line. */
  #find(key: string, now: number): (BriefLine & { readonly expiresAt: number }) | undefined {
    const today = this.#today(now);
    const [day, index] = key.split("#");
    const line = day === today.day ? today.lines[Number(index)] : undefined;

    return line === undefined ? undefined : { ...line, expiresAt: today.expiresAt };
  }

  /** Today's line `key`, or an error when there is none. */
  #line(key: string, now: number): BriefLine & { readonly expiresAt: number } {
    const line = this.#find(key, now);

    if (line === undefined) throw new Error(`No line ${key} in today's brief.`);

    return line;
  }

  /** Record `key` as shown, once: its first showing also marks its anticipation surfaced, while still open. */
  #show(key: string, line: BriefLine & { readonly expiresAt: number }, now: number): void {
    if (this.#surfaced.outcomeOf("brief", key) !== undefined) return;
    this.#surfaced.shown({ kind: "brief", loop: line.source.loop, ref: line.source.ref, item: key, text: line.text, expiresAt: line.expiresAt }, now);
    const anticipation = anticipationOf(line);

    if (anticipation !== undefined && this.#anticipations.open().some((row) => row.id === anticipation && row.status === "open")) {
      this.#anticipations.surface(anticipation, now);
    }
  }

  /** Show each of `keys` that is a line of today's, once; the ones that are not (a card left open past midnight) are skipped. */
  #showAll(keys: readonly string[], now: number): string[] {
    this.#checkOn();
    this.#surfaced.expire(now);

    return keys.filter((key) => {
      const line = this.#find(key, now);

      if (line !== undefined) this.#show(key, line, now);

      return line !== undefined;
    });
  }

  /** The user's screen showed these lines: each becomes shown, once. Keys that are not today's lines are skipped. */
  seen(keys: readonly string[], now = Date.now()): void {
    this.#showAll(keys, now);
  }

  /** A tap on `key`: today's line, shown if the seen report has not come yet, since a tap proves it was. */
  #tapped(key: string, now: number): BriefLine {
    this.#checkOn();
    const line = this.#line(key, now);
    this.#show(key, line, now);

    return line;
  }

  /** The user sent the ask the line's chip put in the composer: acted. */
  act(key: string, now = Date.now()): void {
    this.#tapped(key, now);
    this.#surfaced.outcome("brief", key, "acted", now);
  }

  /** The user keeps the line on the card for the day, and its anticipation, pinned, for good. */
  pin(key: string, now = Date.now()): void {
    const anticipation = anticipationOf(this.#tapped(key, now));
    this.#surfaced.outcome("brief", key, "pinned", now);

    if (anticipation !== undefined) this.#anticipations.pin(anticipation);
  }

  /**
   * The user dismissed the line. Its anticipation closes as dismissed for them only when a machine made it (the
   * dream or an episode), it is not pinned and is still open: a reminder the user made or kept is theirs to close.
   */
  dismiss(key: string, now = Date.now()): void {
    const anticipation = anticipationOf(this.#tapped(key, now));
    this.#surfaced.outcome("brief", key, "dismissed", now);
    const row = anticipation === undefined ? undefined : this.#anticipations.open().find((each) => each.id === anticipation);

    if (row !== undefined && row.created_by !== "user" && !row.pinned) this.#anticipations.close(row.id, "dismissed", "user", undefined, now);
  }

  /**
   * The user dismissed the whole card: each of `keys`, the lines it showed, is cleared unless pinned or handled
   * already; a key that is not today's line (a card left open past midnight) is skipped. Cleared is not
   * dismissed: no anticipation closes, and the dream is not told to avoid its like.
   */
  clear(keys: readonly string[], now = Date.now()): void {
    for (const key of this.#showAll(keys, now)) {
      if (this.#surfaced.outcomeOf("brief", key) === null) this.#surfaced.outcome("brief", key, "cleared", now);
    }
  }
}
