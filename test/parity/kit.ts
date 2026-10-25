/**
 * Parity: a domain's frozen copy of B (`src/<domain>/legacy/`) and its port, behind the same contract,
 * driven by the same generated runs and compared after every step.
 *
 * A domain gives a `Parity`: how to make a fresh instance of each side, the actions its contract
 * takes, and how to read what an instance shows (its tables, its side effects). The kit generates runs
 * of up to 30 steps, each an action or a clock advance, applies each step to both sides, and fails on
 * the first step where the normalized result, a refusal's words, the tables or the effects differ.
 *
 * A difference made on purpose (a B bug the port fixes) is a `Divergence`: the actions it covers are
 * left out of the generated runs, since what one did would differ on every step after, and the
 * divergence names the invariant test that holds the port's behavior instead. Anything else that
 * differs is a regression.
 *
 * `pnpm parity <domain>` runs it at the bar (500 runs); `--mutant <name>` proves it can fail.
 */
import fc from "fast-check";

/** What a side shows: a result, a refusal, its rows, its effects, as JSON. */
export type Json = string | number | boolean | null | Json[] | { readonly [key: string]: Json | undefined };

/** One side of the comparison, fresh for each run. */
export interface Instance<Action> {
  /** Applies one action; its result or refusal, as the caller would see it. */
  apply(action: Action): Promise<Json>;
  /** Moves the side's clock forward and runs what's due. */
  advance(ms: number): Promise<void>;
  /** The domain's stored rows, by table. */
  tables(): Promise<Json>;
  /** What the side did outside its tables: messages sent, requests made. */
  effects(): Promise<Json>;
  dispose(): Promise<void>;
}

/** A difference made on purpose: where B was wrong and the port is right. */
export interface Divergence<Action> {
  name: string;
  /** Whether this action is one the two sides answer differently. */
  covers(action: Action): boolean;
  /** The invariant test that holds the port's behavior, as `file > test name`. */
  heldBy: string;
}

export interface Parity<Action> {
  domain: string;
  actions: fc.Arbitrary<Action>;
  legacy: () => Promise<Instance<Action>>;
  next: () => Promise<Instance<Action>>;
  /** Clock advances to mix in, in ms; none for a domain without time. */
  advances?: fc.Arbitrary<number>;
  /** Makes an observation comparable: ids, timestamps, ordering that may differ without mattering. */
  normalize?: (observed: Json) => Json;
  divergences?: Divergence<Action>[];
}

/** How many runs and how long, from `pnpm parity`'s environment; small by default so `pnpm check` stays quick. */
export function budget() {
  const seed = process.env.KY_SEED;

  return { numRuns: Number(process.env.KY_RUNS ?? 25), maxCommands: Number(process.env.KY_STEPS ?? 30), seed: seed === undefined ? undefined : Number(seed) };
}

type Pair<Action> = { legacy: Instance<Action>; next: Instance<Action> };

/** Where the two sides first differ after a step, or undefined when they agree. */
async function compare<Action>(parity: Parity<Action>, pair: Pair<Action>, results: [Json, Json]): Promise<string | undefined> {
  const normalize = parity.normalize ?? ((observed: Json) => observed);

  const views: [string, Json, Json][] = [
    ["result", results[0], results[1]],
    ["tables", await pair.legacy.tables(), await pair.next.tables()],
    ["effects", await pair.legacy.effects(), await pair.next.effects()]
  ];

  for (const [view, legacy, next] of views) {
    const [a, b] = [JSON.stringify(normalize(legacy)), JSON.stringify(normalize(next))];

    if (a !== b) return `${view} differ:\n  legacy ${a?.slice(0, 400)}\n  next   ${b?.slice(0, 400)}`;
  }

  return undefined;
}

/** The generated runs, as a fast-check property: a failure is a counterexample of steps. */
export function parityProperty<Action>(parity: Parity<Action>, maxCommands = budget().maxCommands) {
  const Apply = (action: Action): fc.AsyncCommand<object, Pair<Action>> => ({
    check: () => true,
    run: async (_, pair) => {
      const results: [Json, Json] = [await pair.legacy.apply(action), await pair.next.apply(action)];
      const differs = await compare(parity, pair, results);

      if (differs) throw new Error(`${parity.domain}: after ${JSON.stringify(action)}, ${differs}`);
    },
    toString: () => JSON.stringify(action)
  });

  const Advance = (ms: number): fc.AsyncCommand<object, Pair<Action>> => ({
    check: () => true,
    run: async (_, pair) => {
      await pair.legacy.advance(ms);
      await pair.next.advance(ms);
      const differs = await compare(parity, pair, [null, null]);

      if (differs) throw new Error(`${parity.domain}: after advancing ${ms}ms, ${differs}`);
    },
    toString: () => `advance ${ms}ms`
  });

  const agreed = parity.actions.filter((action) => !parity.divergences?.some((divergence) => divergence.covers(action)));
  const steps = [agreed.map(Apply), ...(parity.advances ? [parity.advances.map(Advance)] : [])];

  return fc.asyncProperty(fc.commands(steps, { maxCommands }), async (run) => {
    const pair = { legacy: await parity.legacy(), next: await parity.next() };

    try {
      await fc.asyncModelRun(() => ({ model: {}, real: pair }), run);
    } finally {
      await pair.legacy.dispose();
      await pair.next.dispose();
    }
  });
}

/** Asserts parity at the budget `pnpm parity` sets. */
export async function assertParity<Action>(parity: Parity<Action>): Promise<void> {
  const { maxCommands, numRuns, seed } = budget();

  await fc.assert(parityProperty(parity, maxCommands), { numRuns, seed });
}
