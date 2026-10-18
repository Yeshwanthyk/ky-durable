import type { ProactivityLevel, ProactivityView } from "./contract";

/**
 * How proactive ky is, set in Settings › Proactivity: on (the default), or off, when ky reflects on no chat
 * between dreams and recalls nothing at a turn's start. Check-ins are their own setting, in Settings › Automations.
 * An older ky stored "brief" or "boundary": both read as on.
 */
export class Proactivity {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_proactivity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      level TEXT NOT NULL)`);
  }

  /** The level the user set: off only when they turned it off, on otherwise. */
  level(): ProactivityLevel {
    return this.#sql.exec("SELECT level FROM ky_proactivity WHERE id = 1").toArray()[0]?.level === "off" ? "off" : "on";
  }

  set(level: ProactivityLevel): ProactivityView {
    this.#sql.exec("INSERT OR REPLACE INTO ky_proactivity (id, level) VALUES (1, ?)", level);

    return this.view();
  }

  view(): ProactivityView {
    return { level: this.level() };
  }
}
