import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import Type, { type Static } from "typebox";
import { decodeOr, parseOr } from "./core/decode";
import type { ProviderKind } from "./providers/records";

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

export const PurposeSchema = Type.Union([Type.Literal("main"), Type.Literal("worker"), Type.Literal("background"), Type.Literal("fallback")]);

export type Purpose = Static<typeof PurposeSchema>;

/** Every thinking level, lowest first. */
export const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max")
]);

/** A provider, one of its models, and a thinking level: what runs a purpose, as the user picks it and SQLite keeps it. */
export const ModelChoiceSchema = Type.Object({ provider: Type.String(), modelId: Type.String(), thinkingLevel: ThinkingLevelSchema });

export type ModelChoice = Readonly<Static<typeof ModelChoiceSchema>>;

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
  /** An api-key provider's key can be removed. */
  readonly kind: ProviderKind;
  readonly name: string;
  /** It can take requests now, so its models can be chosen. */
  readonly connected: boolean;
  /** What connects it, when it is not. */
  readonly needs?: string;
  /** Why its breaker last opened, until a request succeeds. */
  readonly failure?: string;
  readonly models: readonly ModelOption[];
};

/** A vendor the user may add an API key for. */
export type VendorOption = { readonly id: string; readonly name: string };

export type SettingsView = {
  readonly providers: readonly ProviderInfo[];
  /** What each purpose runs on; none while no model provider is enabled. */
  readonly purposes: Readonly<Partial<Record<Purpose, ModelChoice>>>;
  /** The vendors with no key saved. */
  readonly vendors: readonly VendorOption[];
};

/** A ky_purposes row as read: its choice, JSON. */
const PurposeRow = Type.Object({ value: Type.String() });

export class Settings {
  readonly #sql: SqlStorage;
  readonly #valid: (choice: ModelChoice) => ModelChoice | undefined;
  readonly #listeners = new Set<(purpose: Purpose, choice: ModelChoice) => void>();

  /** `valid` is the choice as it can run now, or undefined when it cannot. */
  constructor(sql: SqlStorage, valid: (choice: ModelChoice) => ModelChoice | undefined) {
    this.#sql = sql;
    this.#valid = valid;
    // ky_settings held the slots the purposes replaced; nothing reads it, and a backup leaves it out.
    sql.exec(`CREATE TABLE IF NOT EXISTS ky_purposes (
      purpose TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  }

  onChange(listener: (purpose: Purpose, choice: ModelChoice) => void): () => void {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  }

  /** The user's choice for a purpose while it can run, else undefined. */
  get(purpose: Purpose): ModelChoice | undefined {
    const row = decodeOr(PurposeRow, this.#sql.exec("SELECT value FROM ky_purposes WHERE purpose = ?", purpose).toArray()[0], undefined);
    // A value a restore or an old version damaged reads as no choice, so the purpose's default runs.
    const choice = row ? parseOr(ModelChoiceSchema, row.value, undefined) : undefined;

    return choice ? this.#valid(choice) : undefined;
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

const ORDER: readonly ModelThinkingLevel[] = ThinkingLevelSchema.anyOf.map((level) => level.const);

/** `wanted`, or the level of `levels` nearest it. */
export function nearestLevel(levels: readonly ModelThinkingLevel[], wanted: ModelThinkingLevel): ModelThinkingLevel {
  if (levels.length === 0 || levels.includes(wanted)) return levels.length === 0 ? "off" : wanted;
  const rank = ORDER.indexOf(wanted);

  const [nearest = wanted] = [...levels].sort((a, b) => Math.abs(ORDER.indexOf(a) - rank) - Math.abs(ORDER.indexOf(b) - rank));

  return nearest;
}
