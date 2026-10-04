import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/**
 * Which model does which job. There are three slots: the main agent, the
 * cloud subagents, and the stand-in that answers for Claude while the Mac is
 * away. Each slot holds a provider, a model and a thinking level, and is
 * kept in this object's SQLite so a change survives restarts.
 *
 * The catalog of providers and models comes from the server, which knows
 * which keys are set. A stored choice whose provider has lost its key, or
 * whose model left the catalog, reads as the slot's default.
 */

export type Slot = "main" | "subagents" | "fallback";

export const SLOTS: readonly Slot[] = ["main", "subagents", "fallback"];

export type SlotSetting = {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: ModelThinkingLevel;
};

export type ModelOption = {
  readonly modelId: string;
  readonly name: string;
  /** Thinking levels the model accepts; the first is the lowest. */
  readonly levels: readonly ModelThinkingLevel[];
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
  readonly slots: Readonly<Record<Slot, SlotSetting>>;
};

export class Settings {
  readonly #sql: SqlStorage;
  readonly #catalog: () => readonly ProviderInfo[];
  readonly #defaults: () => Readonly<Record<Slot, SlotSetting>>;
  readonly #listeners = new Set<(slot: Slot, setting: SlotSetting) => void>();

  constructor(
    sql: SqlStorage,
    catalog: () => readonly ProviderInfo[],
    defaults: () => Readonly<Record<Slot, SlotSetting>>
  ) {
    this.#sql = sql;
    this.#catalog = catalog;
    this.#defaults = defaults;
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_settings (
      slot TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }

  onChange(listener: (slot: Slot, setting: SlotSetting) => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  get(slot: Slot): SlotSetting {
    const row = this.#sql
      .exec<{ value: string }>("SELECT value FROM ky_settings WHERE slot = ?", slot)
      .toArray()[0];

    // SAFETY: only set() writes this table, and it writes a validated SlotSetting.
    const stored = row ? this.#valid(JSON.parse(row.value) as SlotSetting) : undefined;

    return stored ?? this.#defaults()[slot];
  }

  view(): SettingsView {
    return {
      providers: this.#catalog(),
      slots: { main: this.get("main"), subagents: this.get("subagents"), fallback: this.get("fallback") }
    };
  }

  /** Store a choice; an unknown model throws, a level it lacks is moved to the nearest it has. */
  set(slot: Slot, setting: SlotSetting): SlotSetting {
    const valid = this.#valid(setting);

    if (!valid) throw new Error(`${setting.provider}/${setting.modelId} is not available.`);
    this.#sql.exec(
      "INSERT INTO ky_settings (slot, value) VALUES (?, ?) ON CONFLICT(slot) DO UPDATE SET value = excluded.value",
      slot,
      JSON.stringify(valid)
    );

    for (const listener of this.#listeners) listener(slot, valid);

    return valid;
  }

  #valid(setting: SlotSetting): SlotSetting | undefined {
    const provider = this.#catalog().find((each) => each.id === setting.provider && each.connected);
    const model = provider?.models.find((each) => each.modelId === setting.modelId);

    if (!model) return undefined;

    return { ...setting, thinkingLevel: nearestLevel(model.levels, setting.thinkingLevel) };
  }
}

const ORDER: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function nearestLevel(levels: readonly ModelThinkingLevel[], wanted: ModelThinkingLevel): ModelThinkingLevel {
  if (levels.length === 0 || levels.includes(wanted)) return levels.length === 0 ? "off" : wanted;
  const rank = ORDER.indexOf(wanted);

  return [...levels].sort(
    (a, b) => Math.abs(ORDER.indexOf(a) - rank) - Math.abs(ORDER.indexOf(b) - rank)
  )[0]!;
}
