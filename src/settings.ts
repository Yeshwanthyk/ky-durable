import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/**
 * Which model does which job. There are four purposes (C5): the main agent;
 * the worker, for subagents, specialists and automations; the background,
 * for titles, memory summaries, dreams and skill reviews; and the fallback,
 * which answers for a purpose whose provider is down. The user may choose a
 * provider, a model and a thinking level for each. A choice is kept in this
 * object's SQLite, so it survives restarts.
 *
 * models.ts owns the catalog and each purpose's default. A stored choice
 * whose provider is not connected, or whose model left the catalog, reads as
 * no choice, so the purpose's default runs.
 */

export type Purpose = "main" | "worker" | "background" | "fallback";

export type ModelChoice = {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: ModelThinkingLevel;
};

export type ModelOption = {
  readonly modelId: string;
  readonly name: string;
  /** Thinking levels the model accepts; the first is the lowest. */
  readonly levels: readonly ModelThinkingLevel[];
  /** It reads images in the user's messages. */
  readonly images: boolean;
  /** Dollars per million input and output tokens, when known. */
  readonly cost?: { readonly input: number; readonly output: number };
};

export type ProviderInfo = {
  readonly id: string;
  readonly name: string;
  /** It can take requests now, so its models can be chosen. */
  readonly connected: boolean;
  /** What connects it, when it is not. */
  readonly needs?: string;
  readonly models: readonly ModelOption[];
};

export type SettingsView = {
  readonly providers: readonly ProviderInfo[];
  readonly purposes: Readonly<Record<Purpose, ModelChoice>>;
};

export class Settings {
  readonly #sql: SqlStorage;
  readonly #valid: (choice: ModelChoice) => ModelChoice | undefined;
  readonly #listeners = new Set<(purpose: Purpose, choice: ModelChoice) => void>();

  /** `valid` is the choice as it can run now, or undefined when it cannot. */
  constructor(sql: SqlStorage, valid: (choice: ModelChoice) => ModelChoice | undefined) {
    this.#sql = sql;
    this.#valid = valid;
    // ky_settings held the slots the purposes replaced; their choices are not carried over.
    sql.exec(`DROP TABLE IF EXISTS ky_settings`);
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_purposes (
      purpose TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }

  onChange(listener: (purpose: Purpose, choice: ModelChoice) => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  /** The user's choice for a purpose while it can run, else undefined. */
  get(purpose: Purpose): ModelChoice | undefined {
    const row = this.#sql
      .exec<{ value: string }>("SELECT value FROM ky_purposes WHERE purpose = ?", purpose)
      .toArray()[0];

    // SAFETY: only set() writes this table, each row a validated ModelChoice.
    return row ? this.#valid(JSON.parse(row.value) as ModelChoice) : undefined;
  }

  /** Store a choice; an unknown model throws, a level it lacks is moved to the nearest it has. */
  set(purpose: Purpose, choice: ModelChoice): ModelChoice {
    const valid = this.#valid(choice);

    if (!valid) throw new Error(`${choice.provider}/${choice.modelId} is not available.`);
    this.#sql.exec(
      "INSERT INTO ky_purposes (purpose, value) VALUES (?, ?) ON CONFLICT(purpose) DO UPDATE SET value = excluded.value",
      purpose,
      JSON.stringify(valid)
    );

    for (const listener of this.#listeners) listener(purpose, valid);

    return valid;
  }
}

const ORDER: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** `wanted`, or the level of `levels` nearest it. */
export function nearestLevel(levels: readonly ModelThinkingLevel[], wanted: ModelThinkingLevel): ModelThinkingLevel {
  if (levels.length === 0 || levels.includes(wanted)) return levels.length === 0 ? "off" : wanted;
  const rank = ORDER.indexOf(wanted);

  return [...levels].sort(
    (a, b) => Math.abs(ORDER.indexOf(a) - rank) - Math.abs(ORDER.indexOf(b) - rank)
  )[0]!;
}
