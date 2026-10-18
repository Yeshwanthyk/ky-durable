import Type from "typebox";
import { decodeOr, parseOr } from "../core/decode";
import { LOOK_TIME, LOOK_TIMES, type ProactivityLevel, type ProactivityView } from "./contract";

/**
 * How proactive ky is, set in Settings › Proactivity: on (the default), or off, when ky reflects on no chat
 * between dreams, recalls nothing at a turn's start and takes no look. Check-ins are their own setting, in
 * Settings › Automations. An older ky stored "brief" or "boundary": both read as on. While on, ky takes a look
 * (src/dreaming/looks.ts) at each of the user's look times, local HH:MM, 08:00, 13:00 and 18:00 until they change them.
 */

const DEFAULT_LOOKS = ["08:00", "13:00", "18:00"];

const ColumnRow = Type.Object({ name: Type.String() });

const LooksRow = Type.Object({ looks: Type.String() });

const LooksColumn = Type.Array(Type.String({ pattern: LOOK_TIME.source }), { maxItems: LOOK_TIMES });

export class Proactivity {
  readonly #sql: SqlStorage;
  readonly #listeners = new Set<() => void>();

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_proactivity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      level TEXT NOT NULL)`);

    // The look times came after the level: a table from before has no column for them.
    if (!sql.exec("PRAGMA table_info(ky_proactivity)").toArray().some((column) => decodeOr(ColumnRow, column, undefined)?.name === "looks")) {
      sql.exec("ALTER TABLE ky_proactivity ADD COLUMN looks TEXT");
    }
  }

  /** Called after each change, so the looks are booked again. */
  onChange(listener: () => void): void {
    this.#listeners.add(listener);
  }

  /** The level the user set: off only when they turned it off, on otherwise. */
  level(): ProactivityLevel {
    return this.#sql.exec("SELECT level FROM ky_proactivity WHERE id = 1").toArray()[0]?.level === "off" ? "off" : "on";
  }

  /** The user's look times, earliest first; the defaults until they set theirs, or when a restore damaged them. */
  looks(): string[] {
    const stored = decodeOr(LooksRow, this.#sql.exec("SELECT looks FROM ky_proactivity WHERE id = 1").toArray()[0], undefined);

    return stored ? parseOr(LooksColumn, stored.looks, DEFAULT_LOOKS).toSorted() : DEFAULT_LOOKS;
  }

  set(level: ProactivityLevel): ProactivityView {
    this.#sql.exec("INSERT INTO ky_proactivity (id, level) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET level = excluded.level", level);

    return this.#changed();
  }

  /** Set the look times: each HH:MM, at most LOOK_TIMES, kept once each and earliest first; none takes no look. */
  setLooks(times: readonly string[]): ProactivityView {
    const looks = [...new Set(times)].toSorted();

    if (looks.some((time) => !LOOK_TIME.test(time))) throw new Error("A look time is HH:MM, like 08:00.");

    if (looks.length > LOOK_TIMES) throw new Error(`At most ${LOOK_TIMES} look times.`);
    this.#sql.exec(
      "INSERT INTO ky_proactivity (id, level, looks) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET looks = excluded.looks",
      this.level(),
      JSON.stringify(looks)
    );

    return this.#changed();
  }

  view(): ProactivityView {
    return { level: this.level(), looks: this.looks() };
  }

  #changed(): ProactivityView {
    for (const listener of this.#listeners) listener();

    return this.view();
  }
}
