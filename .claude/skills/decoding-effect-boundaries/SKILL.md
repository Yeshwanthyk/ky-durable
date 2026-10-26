---
name: decoding-effect-boundaries
description: Decodes untrusted data with Effect Schema at the ingress where it enters a ported ky domain, in place of typebox and `src/core/decode.ts`. Use when ported code reads a SQL row or JSON column, a fetch or Cloudflare response body, a socket frame, a stored file, or a tool's or route's input, or casts or probes an unknown value.
---

# Decode Effect boundaries in a ky port

Decode each untrusted value once, at its **ingress**, then keep the domain typed. At B, ky does this with typebox through `src/core/decode.ts` (`decode`, `decodeOr`, `parseAs`, `parseOr`, `bodyAs`), and lint (`ky/no-unchecked-parse`) bans `JSON.parse` and `.json()` everywhere else. A ported domain decodes with Effect Schema instead, and the lint rule still holds: `Schema.fromJsonString` does the parse.

## Steps

1. **Find each ingress** the domain owns: the first line that receives the value. In ky that's `sql.exec(...).toArray()`, a JSON text column (`ky_automations.model`), `response.text()` from Cloudflare or an upstream, a socket frame, a file read, a route's body.
2. **Define the Schema in `contract.ts`**, beside the table or action it describes (see `modeling-effect-domain`). Reusable decoders sit at module scope.
3. **Decode before any domain logic**, with the same outcome B had for a bad value (table below). A bad value that refuses maps to the domain's refusal; one B threw on stays a defect.
4. **Delete the casts and probes** the decode made redundant.

Done when every value from the domain's ingresses reaches domain code already decoded, each bad value ends as it did at B (or as a declared divergence), and the domain's files hold no `as`, `Value.Check`, `core/decode` call, `Reflect.get` or `"field" in value` on it.

## B's helpers, ported

| B (`src/core/decode.ts`) | What a bad value did | Port |
| --- | --- | --- |
| `decode(schema, value, what)` | threw `<what> isn't what ky expects.` | `Schema.decodeUnknownEffect(S)(value)`, then `mapError` to a refusal, or `orDie` where B's throw was a bug |
| `decodeOr(schema, value, fallback)` | the fallback, for stored values a restore or old version damaged | `Option.getOrUndefined(Schema.decodeUnknownOption(S)(value))` (or `getOrNull`, `getOrElse`): the same fallback |
| `parseAs(schema, text, what)` | threw | `Schema.decodeUnknownEffect(Schema.fromJsonString(S))(text)` |
| `parseOr(schema, text, fallback)` | the fallback | `Schema.decodeUnknownOption(Schema.fromJsonString(S))(text)` |
| `bodyAs(response, schema, what)` | threw | `response.text()` in `Effect.promise`, then `fromJsonString` |

```ts
export const StoredCheckIns = Schema.Struct({ off: Schema.BooleanFromBit, zone: Schema.NullOr(Schema.String), zone_pinned: Schema.BooleanFromBit });

export const ModelColumn = Schema.NullOr(Schema.fromJsonString(ModelChoice));

export const AutomationInput = Schema.Struct({
  title: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(80)),
  cron: Schema.optional(Schema.String),
  at: Schema.optional(Schema.Number.check(Schema.isInt()))
});

export const input = (value: unknown) => Schema.decodeUnknownEffect(AutomationInput)(value).pipe(Effect.mapError(() => new BadInput()));

export const storedOr = (row: unknown) => Option.getOrUndefined(Schema.decodeUnknownOption(StoredCheckIns)(row));

export const modelOr = (text: string | null) => Option.getOrNull(Schema.decodeUnknownOption(ModelColumn)(text));
```

## ky's gotchas

- **Stricter is a behaviour change.** `Schema.BooleanFromBit` takes only 0 or 1, where B's `row.zone_pinned === 1` read a 2 as false. When the port's schema is stricter than B's check, either keep B's looseness (`Schema.Number`, compared as B did) or declare the divergence: parity will find the difference either way.
- **A damaged stored value keeps B's fallback.** `decodeOr` exists because a restore (`src/backup.ts`) or an older ky can leave rows the current shape rejects. A port that fails instead of falling back breaks a restore.
- **Tool inputs stay typebox.** A pi tool's `parameters` is pi-ai's `TSchema` (`@earendil-works/pi-durable`'s `harness/types.d.ts`), and the harness validates `args` against it before `execute()`. Keep that schema typebox in `contract.ts`; the domain takes `Static<typeof ...>` as already decoded.
- **A schema owned by an unported domain stays where it is** (`ModelChoiceSchema`, `ThinkingLevelSchema` in `src/settings.ts`). Decode that field with its owner's typebox schema until the owner ports, rather than writing a Schema twin of it.
- **SQL rows go through `effect-do-storage`'s `rows`**, which decodes each row with the Schema it's given; a raw `exec` row is `unknown` until decoded.
- A typed guard is the right tool for a host object Schema can't describe (a binding, `ctx.exports`, a DO stub): a precise predicate that checks every field its result claims.
- From a Cloudflare response, keep an allow-listed object of the fields you use. State, errors and logs hold only those: no request objects, raw causes or tokens.

Before using a Schema API, find it in `vendor/effect/packages/effect/src/Schema.ts` and its tests: v4's checks are `.check(Schema.isMaxLength(n), …)`, not v3's filters.
