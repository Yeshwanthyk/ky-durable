import * as Schema from "effect/Schema";
import type { Refusable } from "../core/edge";
import { offsetMinutes } from "../dreaming/contract";
import type { Purpose } from "../settings/contract";

export const SPEND_TABLES = Object.freeze({ ledger: "ky_spend", cap: "ky_spend_cap", held: "ky_spend_held" } as const);

export const SpendPurpose = Schema.Literals(["main", "worker", "background", "fallback"] as const satisfies readonly Purpose[]);

export const SpendSource = Schema.Literals(["chat", "subagent", "automation", "look", "dream", "episode", "skill-review", "mail", "peer", "machine-task", "call", "other"]);

export type SpendSource = typeof SpendSource.Type;

export const BackgroundWork = Schema.Literals(["look", "dream", "episode", "skill-review", "automation", "check-in"]);

export type BackgroundWork = typeof BackgroundWork.Type;

export const Usage = Schema.Struct({
  purpose: SpendPurpose,
  source: SpendSource,
  provider: Schema.String,
  model: Schema.String,
  tokensIn: Schema.Number,
  tokensOut: Schema.Number,
  costUsd: Schema.Number
});

export type Usage = typeof Usage.Type;

export const LedgerRow = Schema.Struct({
  day: Schema.String,
  purpose: Schema.String,
  source: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  tokens_in: Schema.Number,
  tokens_out: Schema.Number,
  cost_usd: Schema.Number,
  calls: Schema.Number
});

export type LedgerRow = typeof LedgerRow.Type;

export const CapRow = Schema.Struct({ cap_usd: Schema.NullOr(Schema.Number), noticed_day: Schema.NullOr(Schema.String) });

export const HeldRow = Schema.Struct({ work: Schema.String, why: Schema.String, at: Schema.Number });

export const SpendTotals = Schema.Struct({ costUsd: Schema.Number, tokensIn: Schema.Number, tokensOut: Schema.Number, calls: Schema.Number });

export type SpendTotals = typeof SpendTotals.Type;

export const SpendLine = Schema.Struct({ ...SpendTotals.fields, purpose: Schema.String, source: Schema.String });

export type SpendLine = typeof SpendLine.Type;

export const SpendView = Schema.Struct({
  day: Schema.String,
  today: SpendTotals,
  month: SpendTotals,
  lines: Schema.Array(SpendLine),
  capUsd: Schema.NullOr(Schema.Number),
  capped: Schema.Boolean,
  held: Schema.Array(HeldRow)
});

export type SpendView = typeof SpendView.Type;

export class BadCap extends Schema.TaggedError<BadCap>()("BadCap", { usd: Schema.Number }) implements Refusable {
  get refusal(): string {
    return "A daily cap is a number of dollars above 0.";
  }
}

export const dayIn = (zone: string | null, at: number): string => new Date(at + offsetMinutes(zone, at) * 60_000).toISOString().slice(0, 10);

export const usd = (amount: number): string => `$${amount.toFixed(amount < 1 ? 4 : 2)}`;

export const capNotice = (capUsd: number): string =>
  `Today's model spend reached your ${usd(capUsd)} daily cap. Background work (looks, dreams, reviews, automations) waits until tomorrow; this chat keeps working.`;
