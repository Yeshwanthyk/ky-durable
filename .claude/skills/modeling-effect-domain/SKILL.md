---
name: modeling-effect-domain
description: The template a ky domain follows when it ports to Effect 4.0.6, with `contract.ts` in Schema, the domain as a `Context.Service` + `Layer`, and `wiring.ts` running it through `makeEdge` so callers keep `T | Refusal`. Use when starting or structuring a domain's port (deploy, automations, skills), adding an action to a ported domain, or deciding where a ported piece lives.
---

# Model a ported Effect domain

A port changes a domain's inside and keeps its outside. Callers (server.ts, routes, tools, the CLI) see the same names, the same sync-or-async shape, and the same `T | Refusal` (`src/core/refusal.ts`) as at B. The **parity** runs prove it (see `testing-effect-domains`).

## The folder

The two doors are already law: `test/invariants/boundaries.test.ts` fails when code outside a domain imports anything but its `contract.ts` or `wiring.ts`, when the CLI imports a `wiring.ts`, or when a `contract.ts` imports the rest of its folder at run time.

| File | Holds | Imports |
| --- | --- | --- |
| `src/<domain>/contract.ts` | The names that never change (tables, tools), the **actions** and their results in Schema, the domain's refusals | `effect/Schema`, other contracts, `core/` |
| `src/<domain>/<domain>.ts` | The domain: a `Context.Service` and its `Layer` | its contract, services it needs (`Sql`) |
| `src/<domain>/wiring.ts` | The one `makeEdge`, and the facade server.ts makes, with B's signatures | the service, `core/edge.ts` |
| `src/<domain>/legacy/` | A frozen copy of B's code for the parity runs, deleted when the port lands | B's own imports |

## Steps

1. **Freeze B.** Copy the domain's B files into `src/<domain>/legacy/`, untouched, so the parity runs have a B to drive.
2. **Write the contract.** Keep every table and tool name as it is (a restore stages each table as `ky_restore__<table>`, `src/backup.ts`). Put each action a caller can take into one Schema union, its results beside it, and its refusals as tagged errors (see `modeling-effect-errors`). Types derive from the schemas (see `deriving-schema-types`).
3. **Write the service.** One `Context.Service` class, its shape the actions as Effects, and its `Layer` built from the services it needs.
4. **Wire it.** `wiring.ts` builds the edge once per owner and exposes B's methods over it.
5. **Prove it.** The parity runs against `legacy/`, the domain's invariants and its mutants (see `testing-effect-domains`).

Done when the boundaries test passes, server.ts and every caller compile unchanged against `wiring.ts` and `contract.ts`, `wiring.ts` is the only file in the domain that calls `makeEdge` or runs an Effect, and `pnpm parity <domain>` passes.

## The contract

```ts
/** The domain's SQL tables. A restore stages each as `ky_restore__<table>`: never rename one. */
export const ZONE_TABLES = Object.freeze({ checkIns: "ky_check_ins" } as const);

/** What a caller may ask: the parity runs generate these, and both sides take them. */
export const ZoneAction = Schema.Union([
  Schema.TaggedStruct("detect", { zone: Schema.String }),
  Schema.TaggedStruct("pin", { zone: Schema.String }),
  Schema.TaggedStruct("unpin", { detected: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("read", {})
]);

export type ZoneAction = typeof ZoneAction.Type;

/** What an action answers, when ky does it. */
export const Zone = Schema.Struct({ on: Schema.Boolean, zone: Schema.NullOr(Schema.String), pinned: Schema.Boolean });

export type Zone = typeof Zone.Type;

/** Why ky won't, in B's words. */
export class NotAZone extends Schema.TaggedError<NotAZone>()("NotAZone", { zone: Schema.String }) {
  get refusal(): string {
    return `${this.zone} isn't a time zone, like Europe/Berlin.`;
  }
}
```

The action union is the parity kit's `Action` type: the kit's generated runs and both sides' `Instance.apply` take it, so an action missing from it is untested.

## The service

```ts
const Stored = Schema.Struct({ off: Schema.Number, zone: Schema.NullOr(Schema.String), zone_pinned: Schema.Number });

export interface ZonesShape {
  readonly read: Effect.Effect<Zone>;
  readonly detect: (zone: string) => Effect.Effect<Zone>;
  readonly pin: (zone: string) => Effect.Effect<Zone, NotAZone>;
}

export class Zones extends Context.Service<Zones, ZonesShape>()("ky/automations/Zones") {
  /** Needs Sql; the edge in wiring.ts provides it. */
  static readonly layer = Layer.effect(Zones)(
    Effect.gen(function* () {
      const sql = yield* Sql;
      const table = ZONE_TABLES.checkIns;

      // Storage failing is a defect, as a throwing exec was at B.
      const read = Effect.orDie(sql.exec(`SELECT off, zone, zone_pinned FROM ${table} WHERE id = 1`)).pipe(
        Effect.map(([row]) => {
          const stored = Option.getOrUndefined(Schema.decodeUnknownOption(Stored)(row));

          return { on: stored?.off !== 1, zone: stored?.zone ?? null, pinned: stored?.zone_pinned === 1 };
        })
      );

      const keep = (zone: string, pinned: boolean) =>
        Effect.orDie(
          sql.exec(
            `INSERT INTO ${table} (id, off, zone, zone_pinned) VALUES (1, 0, ?, ?) ON CONFLICT (id) DO UPDATE SET zone = excluded.zone, zone_pinned = excluded.zone_pinned`,
            zone,
            pinned ? 1 : 0
          )
        );

      return {
        read,
        detect: (zone) =>
          Effect.gen(function* () {
            const now = yield* read;

            if (now.pinned || zone === now.zone) return now;
            yield* keep(zone, false);

            return yield* read;
          }),
        pin: (zone) =>
          Effect.gen(function* () {
            if (!Intl.supportedValuesOf("timeZone").includes(zone)) return yield* new NotAZone({ zone });
            yield* keep(zone, true);

            return yield* read;
          })
      };
    })
  );
}
```

- The key string (`"ky/<domain>/<Name>"`) is the service's runtime identity: unique across ky.
- Each method's error channel holds only the domain's refusals (and recoverable failures it handles inside). `Effect.Effect<Zone>` with no error says it can't refuse.
- The Layer can't fail: `makeEdge` takes a `Layer<R>` with no error and no requirements left. A domain that can't start is a defect (`Effect.orDie`).
- Storage comes from the `Sql` service (see `effect-do-storage`); time from `Clock`, so a test moves it.

## The wiring

```ts
export class ZonesWiring {
  readonly #edge: Edge<Zones>;

  /** One edge for the Durable Object's life: the Layer is built once, on the first call. */
  constructor(storage: DurableObjectStorage) {
    this.#edge = makeEdge(Zones.layer.pipe(Layer.provide(Sql.layer(storage))));
  }

  pin(zone: string): Result<Zone> {
    return this.#edge.run(Zones.use((zones) => zones.pin(zone)));
  }
}
```

- **One edge per owner**, made where B made the domain's class (PiAgent's `automations` field, `src/server.ts:205`); `dispose` releases what the Layer acquired.
- **A Layer that waits is built by `runPromise` first.** If building it awaits anything, the first `edge.run` throws `AsyncFiberError`. Run one `edge.runPromise` inside `ctx.blockConcurrencyWhile` in the DO's constructor, and `run` works after it.
- **Eviction never calls `dispose`.** A DO is dropped without warning, so a Layer's finalizers don't run there. Hold nothing in a Layer that must be released: keep state in storage.
- **No edge at module scope in a Worker.** Make it in the owner's constructor; a module-scope runtime is shared across requests and outlives them.
- **B's shape stays.** A sync B method stays sync over `edge.run`, which throws if the Effect waits; an async one uses `edge.runPromise`, passing the host's `AbortSignal`.
- **B's failure contract stays.** Where B returned `T | Refusal`, return the edge's `Result`. Where B threw the user's words (`pinZone`), callers catch an `Error`; the facade rethrows `new Error(result.refused)` until those callers move, so the caller-visible behaviour, which parity compares, is B's.
- `edge.run` returns `Result<A>` even for an Effect that can't fail. A B method that returned a bare `T` (`checkIns()`, with 8 sync callers) unwraps it, throwing if a `Refusal` ever comes back.

## Deploy

Deploy runs in Node, in `cli/` (`cli/deployer.ts`, `cli/commands.ts`), not in a Durable Object. The same three roles apply: a contract of actions and refusals, a service and Layer, one edge. Its edge already exists as `Cloudflare.run` (`cli/cloudflare.ts`), which provides distilled's layer. Its storage is the Cloudflare account, checked through the fake (`test/fakes/cloudflare.ts`), so `effect-do-storage` doesn't apply.
