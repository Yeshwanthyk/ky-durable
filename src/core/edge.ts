/**
 * The edge between a domain written in Effect and the ky that calls it: the Durable Object, a route, a
 * tool. Inside, a domain fails with tagged errors in the typed channel; out here, callers keep the one
 * shape every module returns, `T | Refusal`, so a domain moves to Effect without its callers changing.
 *
 * A domain's typed failures must each say why ky won't, in the user's words (`Refusable`). The type
 * system holds that: `run` takes only an Effect whose errors are Refusable, so a failure the user
 * shouldn't see must be recovered (`Effect.catchTag`) or declared a defect (`Effect.orDie`) inside the
 * domain first. A defect is a bug, and throws here, as a bug throws in the rest of ky.
 *
 * One edge per owner, built from the domain's Layer: the Durable Object holds it as long as it lives,
 * so the Layer is built once, on the first run, and `dispose` releases what it acquired. Three limits
 * follow from where it lives:
 * - A Layer that waits can't be built by `run`, which is synchronous: the owner awaits one `runPromise`
 *   first (in the constructor's `blockConcurrencyWhile`), or `run` throws `AsyncFiberError`.
 * - Eviction and hibernation never call `dispose`, so a Layer's release is best effort: nothing that
 *   must be written belongs there.
 * - At a Worker's module scope, an I/O object the Layer made is reused across requests, which the
 *   runtime refuses; edges live in a Durable Object or a single request.
 */
import * as Cause from "effect/Cause";
import type * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as EffectResult from "effect/Result";
import { type Refusal, type Result, refused } from "./refusal";

/** A domain failure the user is told about: a tagged error that says why ky won't, in their words. */
export interface Refusable {
  readonly _tag: string;
  readonly refusal: string;
}

/** A domain behind its Layer, run from code that isn't Effect. */
export interface Edge<R> {
  /** Runs a synchronous Effect: its value, or the refusal its failure carries. A defect throws. */
  run<A extends object, E extends Refusable>(effect: Effect.Effect<A, E, R>): Result<A>;
  /** Runs an Effect that may wait: its value, or the refusal its failure carries. A defect rejects. */
  runPromise<A extends object, E extends Refusable>(effect: Effect.Effect<A, E, R>, options?: { readonly signal?: AbortSignal }): Promise<Result<A>>;
  /** Releases what the Layer acquired. The edge can't run after. */
  dispose(): Promise<void>;
}

/** The value of `exit`, the refusal its failure carries, or a throw for a defect or an interruption. */
function settle<A extends object, E extends Refusable>(exit: Exit.Exit<A, E>): A | Refusal {
  if (Exit.isSuccess(exit)) return exit.value;

  // A bug beside a failure is still a bug: the refusal would hide it.
  const defect = Cause.findDefect(exit.cause);

  if (EffectResult.isSuccess(defect)) throw defect.success;

  const failure = Cause.findErrorOption(exit.cause);

  if (Option.isSome(failure)) return refused(failure.value.refusal);

  throw Cause.squash(exit.cause);
}

/** An edge for the domain `layer` provides. The Layer can't fail: a domain that can't start is a defect. */
export function makeEdge<R>(layer: Layer.Layer<R>): Edge<R> {
  const runtime = ManagedRuntime.make(layer);

  return {
    run: (effect) => settle(runtime.runSyncExit(effect)),
    runPromise: async (effect, options) => settle(await runtime.runPromiseExit(effect, options)),
    dispose: () => runtime.dispose()
  };
}
