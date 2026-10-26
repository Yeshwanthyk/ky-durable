import * as Schema from "effect/Schema";

export const HISTORY_TABLES = { index: "ky_history", mark: "ky_history_mark" } as const;

const SaidMark = Schema.Struct({ seq: Schema.Number, at: Schema.Number });

export type SaidMark = typeof SaidMark.Type;

const Said = Schema.Struct({
  lines: Schema.Array(Schema.String),
  dropped: Schema.Number,
  waiting: Schema.Number,
  through: Schema.Number
});

export type Said = typeof Said.Type;

const Span = Schema.Struct({ from: Schema.Number, to: Schema.Number, days: Schema.String });

export type Span = typeof Span.Type;

const SearchOptions = Schema.Struct({
  around: Schema.optional(Schema.Number),
  caller: Schema.optional(Schema.String),
  batches: Schema.optional(Schema.Number),
  span: Schema.optional(Span)
});

export type SearchOptions = typeof SearchOptions.Type;

const RunInput = Schema.Struct({ entry: Schema.Number, request: Schema.UndefinedOr(Schema.String) });

export type RunInput = typeof RunInput.Type;

const OWN_REQUEST = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOwnRequest(requestId: string | undefined): boolean {
  return requestId !== undefined && OWN_REQUEST.test(requestId);
}
