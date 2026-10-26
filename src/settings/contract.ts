import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import * as Schema from "effect/Schema";
import Type, { type Static } from "typebox";
import type { Refusable } from "../core/edge";
import type { ProviderKind } from "../providers/records";

export const SETTINGS_TABLES = Object.freeze({ purposes: "ky_purposes" } as const);

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];

const PURPOSES = ["main", "worker", "background", "fallback"] as const;

export type Purpose = Static<typeof PurposeSchema>;

export const ModelChoice = Schema.Struct({ provider: Schema.String, modelId: Schema.String, thinkingLevel: Schema.Literals(THINKING_LEVELS) });

export type ModelChoice = typeof ModelChoice.Type;

export const PurposeSchema = Type.Enum(PURPOSES);

export const ThinkingLevelSchema = Type.Enum(THINKING_LEVELS);

export const ModelChoiceSchema = Type.Object({ provider: Type.String(), modelId: Type.String(), thinkingLevel: ThinkingLevelSchema });

export type ModelOption = {
  readonly modelId: string;
  readonly name: string;
  readonly featured: boolean;
  readonly levels: readonly ModelThinkingLevel[];
  readonly images: boolean;
  readonly cost?: { readonly input: number; readonly output: number };
};

export type ProviderInfo = {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly name: string;
  readonly connected: boolean;
  readonly needs?: string;
  readonly failure?: string;
  readonly models: readonly ModelOption[];
};

export type VendorOption = { readonly id: string; readonly name: string };

export type SettingsView = {
  readonly providers: readonly ProviderInfo[];
  readonly purposes: Readonly<Partial<Record<Purpose, ModelChoice>>>;
  readonly vendors: readonly VendorOption[];
};

export class NotAvailable extends Schema.TaggedError<NotAvailable>()("NotAvailable", { provider: Schema.String, modelId: Schema.String }) implements Refusable {
  get refusal(): string {
    return `${this.provider}/${this.modelId} is not available.`;
  }
}

export function nearestLevel(levels: readonly ModelThinkingLevel[], wanted: ModelThinkingLevel): ModelThinkingLevel {
  if (levels.length === 0) return "off";

  if (levels.includes(wanted)) return wanted;
  const rank = (level: ModelThinkingLevel) => Math.abs(THINKING_LEVELS.indexOf(level) - THINKING_LEVELS.indexOf(wanted));

  return levels.reduce((nearest, level) => (rank(level) < rank(nearest) ? level : nearest));
}
