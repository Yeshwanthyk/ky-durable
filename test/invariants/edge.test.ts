import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import fc from "fast-check";
import { makeEdge } from "../../src/core/edge";
import { isRefusal, refused } from "../../src/core/refusal";

/** A domain failure as a ported domain writes one: tagged, with the user's words as `refusal`. */
class NoSuchThing extends Schema.TaggedError<NoSuchThing>()("NoSuchThing", { words: Schema.String }) {
  get refusal(): string {
    return this.words;
  }
}

class Counter extends Context.Service<Counter, { readonly built: number }>()("test/Counter") {}

/** A Layer that counts how often it's built and released. */
function counted() {
  const tally = { built: 0, released: 0 };

  const layer = Layer.effect(Counter)(
    Effect.acquireRelease(
      Effect.sync(() => ({ built: ++tally.built })),
      () => Effect.sync(() => void tally.released++)
    )
  );

  return { tally, layer };
}

const values = fc.dictionary(fc.string(), fc.jsonValue()).filter((value) => !("refused" in value));

describe("edge", () => {
  it("returns a success as it is, sync or not", async () => {
    const edge = makeEdge(Layer.empty);

    await fc.assert(
      fc.asyncProperty(values, async (value) => {
        expect(edge.run(Effect.succeed(value))).toBe(value);
        expect(await edge.runPromise(Effect.succeed(value))).toBe(value);
      }),
      { numRuns: 200 }
    );
  });

  it("turns a domain failure into the refusal it carries, word for word", async () => {
    const edge = makeEdge(Layer.empty);

    await fc.assert(
      fc.asyncProperty(fc.string(), async (words) => {
        const failing = Effect.fail(new NoSuchThing({ words }));

        expect(edge.run(failing)).toEqual(refused(words));
        expect(await edge.runPromise(Effect.yieldNow.pipe(Effect.andThen(failing)))).toEqual(refused(words));
      }),
      { numRuns: 200 }
    );
  });

  it("refuses with a failure raised after a success was already in hand", () => {
    const edge = makeEdge(Layer.empty);
    const result = edge.run(Effect.succeed({ ok: true }).pipe(Effect.andThen(() => new NoSuchThing({ words: "No." }))));

    expect(isRefusal(result) && result.refused).toBe("No.");
  });

  it("throws a defect rather than refusing it", async () => {
    const edge = makeEdge(Layer.empty);
    const bug = new Error("a broken invariant");

    expect(() => edge.run(Effect.die(bug))).toThrow(bug);
    await expect(edge.runPromise(Effect.die(bug))).rejects.toThrow(bug);
  });

  it("throws a defect that came beside a failure, rather than refusing", () => {
    const edge = makeEdge(Layer.empty);
    const bug = new Error("a broken invariant");

    expect(() => edge.run(Effect.failCause(Cause.combine(Cause.fail(new NoSuchThing({ words: "Not here." })), Cause.die(bug))))).toThrow(bug);
  });

  it("builds a Layer that waits only from runPromise; run works once it's built", async () => {
    const edge = makeEdge(Layer.effect(Counter)(Effect.promise(async () => ({ built: 1 }))));

    expect(() => edge.run(Effect.service(Counter))).toThrow(/AsyncFiberError|asynchronous/);
    expect(await edge.runPromise(Effect.service(Counter))).toEqual({ built: 1 });
    expect(edge.run(Effect.service(Counter))).toEqual({ built: 1 });
  });

  it("throws when run synchronously on an Effect that waits", () => {
    const edge = makeEdge(Layer.empty);

    expect(() => edge.run(Effect.promise(() => Promise.resolve({})))).toThrow();
  });

  it("rejects an Effect the caller aborted, and refuses nothing", async () => {
    const edge = makeEdge(Layer.empty);
    const abort = new AbortController();
    const running = edge.runPromise(Effect.never, { signal: abort.signal });

    abort.abort();
    await expect(running).rejects.toBeDefined();
  });

  it("builds the domain's Layer once for every run, and releases it once on dispose", async () => {
    const { tally, layer } = counted();
    const edge = makeEdge(layer);

    for (let n = 0; n < 5; n++) expect(edge.run(Effect.service(Counter))).toEqual({ built: 1 });
    expect(await edge.runPromise(Effect.service(Counter))).toEqual({ built: 1 });
    expect(tally).toEqual({ built: 1, released: 0 });

    await edge.dispose();
    expect(tally).toEqual({ built: 1, released: 1 });
  });

  it.effect("lets a domain yield its failure inside Effect.gen", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.gen(function* () {
        return yield* new NoSuchThing({ words: "Not here." });
      }));

      expect(error.refusal).toBe("Not here.");
    })
  );
});
