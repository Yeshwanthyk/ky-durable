---
name: modeling-effect-errors
description: Models a ported ky domain's failures as tagged Effect errors (a refusal the user reads, a failure the domain recovers, a defect) and keeps throws and `run*` at the edge. Use when porting a `throw new Error(...)` or a `refused(...)`, adding a failure path, wrapping a Promise or throwing API, recovering from an error, or running an Effect from code that isn't Effect.
---

# Model Effect errors in a ky port

Every failure in a ported domain is one of three kinds. Name the kind before writing the code:

- **Refusal**: ky won't, and the user is told why in words. A `Schema.TaggedError` with a `refusal` getter (the `Refusable` shape in `src/core/edge.ts`). The edge turns it into the `{ refused }` callers already handle (`src/core/refusal.ts`).
- **Recoverable failure**: the domain itself handles it: a retry, a fallback, a different branch. A tagged error with no `refusal`. It must be caught inside the domain; the edge's types refuse it.
- **Defect**: a bug or a broken invariant. `Effect.die` or `Effect.orDie`. The edge throws it, as a bug throws everywhere else in ky.

## Refusals keep B's words

A refusal's text is part of the contract: the parity runs compare it word for word with B's (`test/parity/kit.ts` compares each result, refusals included). Port the message B threw or returned into the getter, built from the error's fields:

```ts
// B: throw new Error(`${zone} isn't a time zone, like Europe/Berlin.`)  (src/automations/automations.ts, pinZone)
export class NotAZone extends Schema.TaggedError<NotAZone>()("NotAZone", { zone: Schema.String }) {
  get refusal(): string {
    return `${this.zone} isn't a time zone, like Europe/Berlin.`;
  }
}

// B: class NameTaken extends Error (cli/deployer.ts): what's taken, then how to rename
export class NameTaken extends Schema.TaggedError<NameTaken>()("NameTaken", { taken: Schema.String, settings: Schema.String }) {
  get refusal(): string {
    return `${this.taken}; ${rename(this.settings)}`;
  }
}
```

A word changed on purpose is a divergence (see `testing-effect-domains`), never a silent edit.

## Rules

- **One tag per distinct recovery.** Reuse the domain's tag when callers recover the same way; add one only for a different branch, retry, status or wording.
- **A failure stays a failure.** It becomes `null`, `undefined` or an empty list only where B's contract already did that (B's `decodeOr` fallbacks, `cloudflare.find`'s `undefined` for a missing bucket).
- **Words come from fields.** An unknown external value rides along as `cause: Schema.Defect()` or is dropped. The refusal reads the tag's fields, never `String(cause)` or `cause.message`. (B's `sandbox-routes.ts` passes `error.message` through; a port stops doing that.)
- **Storage failing is a defect.** At B a throwing `sql.exec` was a bug that threw; `Effect.orDie` on the `SqlError` keeps that (see `effect-do-storage`). Catch it only for a real recovery, such as a constraint that means "already taken".

## Forms

```ts
export const pinZone = (zone: string) =>
  Effect.gen(function* () {
    const name = ianaZone(zone);

    if (name === undefined) return yield* new NotAZone({ zone });

    return { zone: name };
  });

export const fetchStatus = (url: string) =>
  Effect.tryPromise({
    try: (signal) => fetch(url, { signal }),
    catch: (cause) => new UpstreamFailure({ stage: "fetch", cause })
  });

export const statusOrUnknown = (url: string) =>
  fetchStatus(url).pipe(
    Effect.map((response) => ({ status: response.status })),
    Effect.catchTag("UpstreamFailure", () => Effect.succeed({ status: 0 }))
  );
```

- Wrap a throwing sync call once with `Effect.try({ try, catch })`, and a Promise once with `Effect.tryPromise`. Declare `signal` as a plain parameter: a rest or defaulted parameter gets no signal.
- Recover with `Effect.catchTag` / `Effect.catchTags`. Reach for `Effect.orDie` only on a genuine defect.

## The edge

The only place a ported domain's Effects run is `makeEdge` (`src/core/edge.ts`), built once in the domain's `wiring.ts` (see `modeling-effect-domain`). Its types hold the three kinds apart:

```ts
const edge = makeEdge(Layer.empty);

export const pinned = edge.run(pinZone("Mars/Olympus")); // { zone } | Refusal

export const status = edge.runPromise(statusOrUnknown("https://example.com"), { signal: AbortSignal.timeout(5_000) });

// @ts-expect-error UpstreamFailure has no `refusal`: recover it or orDie it inside the domain first.
export const unhandled = edge.runPromise(fetchStatus("https://example.com"));

// @ts-expect-error The edge's Result needs an object: return `{}` or a value, not void.
export const nothing = edge.run(Effect.void);
```

- `run` is for an Effect that never waits (storage, pure logic); it throws if one does. `runPromise` is for one that may wait; pass the host's `AbortSignal` through.
- A defect wins: when a cause holds a defect beside a refusal (a finalizer died while failing), the edge throws the defect rather than refusing.
- The edge's `Result<A>` needs `A extends object`, so an action that returns nothing returns `{}` or what it changed.
- The CLI already has its own Effect edge, `Cloudflare.run` in `cli/cloudflare.ts`, which turns distilled's tagged failures into `CloudflareError`. Deploy's port goes through it or replaces it, and never adds a third.

Done when every failure path in the ported code is one of the three kinds, each refusal's words match B's (or are a declared divergence), and no `throw`, `Effect.run*` or `try/catch` around an Effect is left in the domain outside `wiring.ts`.

Check an unfamiliar API in `vendor/effect/packages/effect/src/Effect.ts` (or `Schema.ts`, `Cause.ts`) and its tests before using it: v4 renamed much of v3.
