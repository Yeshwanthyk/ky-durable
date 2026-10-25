---
name: deriving-schema-types
description: Derives a ported ky domain's TypeScript types from the Effect Schema that owns the shape, in place of typebox's `Static<typeof …Schema>` and hand-written mirrors. Use when a type alias or interface repeats a nearby Schema, or a typebox schema in a domain's `contract.ts` moves to Effect Schema.
---

# Derive schema-owned types in a ky port

The Schema is the **single source of truth** for a data shape; its type is `typeof X.Type`. At B, ky writes `export type AutomationStatus = Static<typeof AutomationStatusSchema>` (typebox) or a hand-written type beside a schema. A port keeps the exported type names, so nothing that imports the contract changes.

## Steps

1. **Pair** each type in the domain's `contract.ts` with the schema it mirrors, field by field: optionality, literals, nullability, the 0/1 flags SQLite stores.
2. **Replace** the type's body with the derived form, keeping its exported name. Keep the schema's name too (`AutomationStatusSchema`), unless every importer is the domain's own.
3. **Run `pnpm typecheck`.** A new error is a real mismatch the duplicate was hiding: fix the schema or the consumer, whichever is wrong, and check the parity runs still agree when the fix changes behaviour.

Done when each shape in the contract is written once, and `pnpm typecheck` passes.

```ts
export const AutomationStatusSchema = Schema.Literals(["active", "paused", "done", "archived"]);

/** `done`: a one-off that has run. */
export type AutomationStatus = typeof AutomationStatusSchema.Type;

export const StoredCheckIns = Schema.Struct({ off: Schema.BooleanFromBit, zone: Schema.NullOr(Schema.String), zone_pinned: Schema.BooleanFromBit });

/** The row as the domain reads it: flags as booleans. */
export type StoredCheckIns = typeof StoredCheckIns.Type;

/** The row as SQLite holds it, for the INSERT's parameters: flags as 0 or 1. */
export type StoredCheckInsRow = typeof StoredCheckIns.Encoded;
```

- For a transformation, derive the domain's type from the decoded side (`.Type`). Use `.Encoded` only where the stored or wire form is handled: an INSERT's parameters, a frame sent.
- `Schema.encodeSync(S)(value)` writes a value back in its stored form, so an INSERT and its SELECT share one schema.
- `Schema.suspend` may need one private helper type for recursion; the exported type stays derived.
- **Leave authored types** that intentionally differ from any schema: a service's shape (`ZonesShape`), a view assembled from rows (`CheckIns`, `ZoneView` in `src/automations/contract.ts`), types other domains own.
- **Leave typebox tool inputs** (`AutomationToolInput`) and their `Static<…>` types: pi's tool definitions take a typebox `TSchema` (see `decoding-effect-boundaries`).
