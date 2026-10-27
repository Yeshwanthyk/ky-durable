import Type from "typebox";
import { decodeOr, parseOr } from "../../../../src/core/decode";
import { LOOK_TIME, LOOK_TIMES, type ProactivityLevel, type ProactivityView, RIGHT_AWAY_MOST } from "./contract";
import type { LegacySql } from "./rows";

/**
 * How proactive ky is, set in Settings › Proactivity: on (the default), or off, when ky reflects on no chat
 * between dreams, recalls nothing at a turn's start and takes no look. Check-ins are their own setting, in
 * Settings › Automations. An older ky stored "brief" or "boundary": both read as on. While on, ky takes a look
 * (src/dreaming/looks.ts) at each of the user's look times, local HH:MM, 08:00, 13:00 and 18:00 until they change them.
 * Whether on or off, at most the user's right-away number of posts a day push to their devices (src/push.ts), 6 until
 * they change it.
 */

const DEFAULT_LOOKS = ["08:00", "13:00", "18:00"];

const DEFAULT_RIGHT_AWAY = 6;

const RightAwayRow = Type.Object({ right_away: Type.Integer({ minimum: 0, maximum: RIGHT_AWAY_MOST }) });

const ColumnRow = Type.Object({ name: Type.String() });

const LooksRow = Type.Object({ looks: Type.String() });

const LooksColumn = Type.Array(Type.String({ pattern: LOOK_TIME.source }), { maxItems: LOOK_TIMES });

export class Proactivity {
  readonly #sql: LegacySql;
  readonly #listeners = new Set<() => void>();

  constructor(sql: LegacySql) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_proactivity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      level TEXT NOT NULL)`);

    // The look times, then the right-away number, came after the level: a table from before has no column for them.
    const columns = sql.exec("PRAGMA table_info(ky_proactivity)").toArray().map((column) => decodeOr(ColumnRow, column, undefined)?.name);

    if (!columns.includes("looks")) sql.exec("ALTER TABLE ky_proactivity ADD COLUMN looks TEXT");

    if (!columns.includes("right_away")) sql.exec("ALTER TABLE ky_proactivity ADD COLUMN right_away INTEGER");
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

    return stored ? [...parseOr(LooksColumn, stored.looks, DEFAULT_LOOKS)].sort() : DEFAULT_LOOKS;
  }

  /** How many posts a local day push to the user's devices, at most; the default until they set theirs. */
  rightAway(): number {
    return decodeOr(RightAwayRow, this.#sql.exec("SELECT right_away FROM ky_proactivity WHERE id = 1").toArray()[0], undefined)?.right_away ?? DEFAULT_RIGHT_AWAY;
  }

  set(level: ProactivityLevel): ProactivityView {
    this.#sql.exec("INSERT INTO ky_proactivity (id, level) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET level = excluded.level", level);

    return this.#changed();
  }

  /** Set the look times: each HH:MM, at most LOOK_TIMES, kept once each and earliest first; none takes no look. */
  setLooks(times: readonly string[]): ProactivityView {
    const looks = [...new Set(times)].sort();

    if (looks.some((time) => !LOOK_TIME.test(time))) throw new Error("A look time is HH:MM, like 08:00.");

    if (looks.length > LOOK_TIMES) throw new Error(`At most ${LOOK_TIMES} look times.`);
    this.#sql.exec(
      "INSERT INTO ky_proactivity (id, level, looks) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET looks = excluded.looks",
      this.level(),
      JSON.stringify(looks)
    );

    return this.#changed();
  }

  /** Set how many posts a day push right away: a whole number from 0, none, to RIGHT_AWAY_MOST. */
  setRightAway(most: number): ProactivityView {
    if (!Number.isInteger(most) || most < 0 || most > RIGHT_AWAY_MOST) throw new Error(`Right away is a whole number from 0 to ${RIGHT_AWAY_MOST}.`);
    this.#sql.exec(
      "INSERT INTO ky_proactivity (id, level, right_away) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET right_away = excluded.right_away",
      this.level(),
      most
    );

    return this.view();
  }

  view(): ProactivityView {
    return { level: this.level(), looks: this.looks(), rightAway: this.rightAway() };
  }

  #changed(): ProactivityView {
    for (const listener of this.#listeners) listener();

    return this.view();
  }
}
