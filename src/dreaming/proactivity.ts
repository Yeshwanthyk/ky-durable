import type { Anticipations } from "./anticipations";
import { PROACTIVITY_LEVELS, type ProactivityLevel, type ProactivityView } from "./contract";
import type { Surfaced } from "./surfaced";

/**
 * How proactive ky is, set in Settings › Proactivity: off (nothing unasked: no brief card, and the dream
 * writes none), brief (the morning brief; the default), or boundary (the brief, and a line at a task's
 * boundary when one helps). Its page shows how it is going, from what ky surfaced and its anticipations.
 */

const DEFAULT: ProactivityLevel = "brief";

const MONTH_MS = 30 * 86_400_000;

export class Proactivity {
  readonly #sql: SqlStorage;
  readonly #surfaced: Surfaced;
  readonly #anticipations: Anticipations;

  constructor(sql: SqlStorage, surfaced: Surfaced, anticipations: Anticipations) {
    this.#sql = sql;
    this.#surfaced = surfaced;
    this.#anticipations = anticipations;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_proactivity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      level TEXT NOT NULL)`);
  }

  /** The level the user set; brief before they set one, or when a restore damaged it. */
  level(): ProactivityLevel {
    const stored = this.#sql.exec("SELECT level FROM ky_proactivity WHERE id = 1").toArray()[0]?.level;

    return PROACTIVITY_LEVELS.find((each) => each === stored) ?? DEFAULT;
  }

  set(level: ProactivityLevel): ProactivityView {
    this.#sql.exec("INSERT OR REPLACE INTO ky_proactivity (id, level) VALUES (1, ?)", level);

    return this.view();
  }

  /** The level, and the last week's brief acceptance and dismissals and the last month's expired anticipations. */
  view(now = Date.now()): ProactivityView {
    const week = this.#surfaced.lastWeek("brief", now);
    const made = this.#anticipations.madeSince(now - MONTH_MS);

    return {
      level: this.level(),
      accepted: { count: week.acted + week.pinned, of: week.shown },
      dismissed: { count: week.dismissed, of: week.shown },
      expired: { count: made.expired, of: made.all }
    };
  }
}
