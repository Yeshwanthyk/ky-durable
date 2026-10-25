/**
 * Parity: a domain's frozen copy of B (`src/<domain>/legacy/`) and its port, behind the same contract,
 * driven by the same generated runs and compared after every step.
 *
 * A domain gives a `Parity`: how to make a fresh instance of each side, the actions its contract
 * takes, and how to read what an instance shows (its tables, its side effects, what it has scheduled).
 * The kit generates runs of up to 30 steps, each an action or a clock advance, applies each step to
 * both sides, and fails on the first step where the normalized result, a refusal's words, the tables,
 * the effects or what's pending differ.
 *
 * Time is the kit's: it makes one `Clock` per run and hands it to both sides, which read it and never
 * move it. An advance moves that clock, then asks each side to run what's due, so neither side's
 * timers can carry the other along. A domain with alarms also gets advances that jump straight to the
 * next one, since a slot an hour away never comes in 30 steps of seconds.
 *
 * A difference made on purpose (a B bug the port fixes) is a `Divergence`: the actions it covers are
 * left out of the generated runs, since what one did would differ on every step after, and the
 * divergence names the invariant test that holds the port's behavior instead. Anything else that
 * differs is a regression. Divergences may cover at most a quarter of the generated actions, so they
 * can't hollow out the comparison.
 *
 * `pnpm parity <domain>` runs it at the bar (500 runs); `--mutant <name>` proves it can fail.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";

/** What a side shows: a result, a refusal, its rows, its effects, as JSON. */
export type Json = string | number | boolean | null | Json[] | { readonly [key: string]: Json | undefined };

/** The run's time, owned by the kit: both sides read it, only the kit moves it. */
export interface Clock {
  now(): number;
}

/** One side of the comparison, fresh for each run. */
export interface Instance<Action> {
  /** Applies one action; its result or refusal, as the caller would see it. */
  apply(action: Action): Promise<Json>;
  /** Runs what's due at the clock's time, after the kit moved it; absent in a domain without time. */
  due?(): Promise<void>;
  /** What the side has scheduled (its next alarm, what's due), compared like its tables. */
  pending?(): Promise<Json>;
  /** When the side's next alarm fires, in the clock's ms, or null when nothing is scheduled. */
  nextAlarm?(): Promise<number | null>;
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
  legacy: (clock: Clock) => Promise<Instance<Action>>;
  next: (clock: Clock) => Promise<Instance<Action>>;
  /** Clock advances to mix in, in ms; none for a domain without time. */
  advances?: fc.Arbitrary<number>;
  /** Where each run's clock starts, in ms since the epoch; 0 by default. */
  start?: number;
  /** Makes an observation comparable: ids, timestamps, ordering that may differ without mattering. */
  normalize?: (observed: Json) => Json;
  divergences?: Divergence<Action>[];
}

/** How many runs and how long, from `pnpm parity`'s environment; small by default so `pnpm check` stays quick. */
export function budget() {
  const seed = process.env.KY_SEED;

  return { numRuns: Number(process.env.KY_RUNS ?? 25), maxCommands: Number(process.env.KY_STEPS ?? 30), seed: seed === undefined ? undefined : Number(seed) };
}

type Pair<Action> = { legacy: Instance<Action>; next: Instance<Action>; time: { at: number } };

/** Kinds JSON shows as they are; a Map, a Set, a Date or a class would all compare as `{}`. */
const SHOWN = new Set(["[object Object]", "[object Array]", "[object String]", "[object Number]", "[object Boolean]", "[object Null]", "[object Undefined]"]);

/** `observed` as JSON, or a throw when part of it is a value JSON can't show. */
function show(observed: Json, where: string): string {
  return JSON.stringify(observed, (_key: string, value: Json) => {
    const kind = Object.prototype.toString.call(value);

    if (!SHOWN.has(kind) || (kind === "[object Object]" && Object.getPrototypeOf(value) !== Object.prototype)) throw new Error(`${where} holds a ${kind}, which compares as {}: turn it into plain JSON`);

    return value;
  });
}

/** How much of the domain's actions divergences may take out of the comparison. */
const MOST_COVERED = 0.25;

/** Refuses divergences that cover too much, or that don't name an invariant test in a file that exists. */
function checkDivergences<Action>(parity: Parity<Action>): void {
  const divergences = parity.divergences ?? [];

  if (divergences.length === 0) return;

  for (const { name, heldBy } of divergences) {
    const [file, test] = heldBy.split(" > ");

    if (!file || !test || !existsSync(path.resolve(file))) throw new Error(`${parity.domain}: divergence ${name} is held by "${heldBy}", which isn't \`<existing file> > <test name>\``);
  }

  const sample = fc.sample(parity.actions, { numRuns: 400, seed: 1 });
  const covered = sample.filter((action) => divergences.some((divergence) => divergence.covers(action))).length / sample.length;

  if (covered > MOST_COVERED) throw new Error(`${parity.domain}: divergences cover ${Math.round(covered * 100)}% of the actions, more than ${MOST_COVERED * 100}%: narrow them, or the comparison checks little`);
}

/** Where the two sides first differ after a step, or undefined when they agree. */
async function compare<Action>(parity: Parity<Action>, pair: Pair<Action>, results: [Json, Json]): Promise<string | undefined> {
  const normalize = parity.normalize ?? ((observed: Json) => observed);

  const views: [string, Json, Json][] = [
    ["result", results[0], results[1]],
    ["tables", await pair.legacy.tables(), await pair.next.tables()],
    ["effects", await pair.legacy.effects(), await pair.next.effects()],
    ["pending", (await pair.legacy.pending?.()) ?? null, (await pair.next.pending?.()) ?? null]
  ];

  for (const [view, legacy, next] of views) {
    const [a, b] = [show(normalize(legacy), `legacy's ${view}`), show(normalize(next), `next's ${view}`)];

    if (a !== b) return `${view} differ:\n  legacy ${a?.slice(0, 400)}\n  next   ${b?.slice(0, 400)}`;
  }

  return undefined;
}

/** The generated runs, as a fast-check property: a failure is a counterexample of steps. */
export function parityProperty<Action>(parity: Parity<Action>, maxCommands = budget().maxCommands) {
  checkDivergences(parity);

  const Apply = (action: Action): fc.AsyncCommand<object, Pair<Action>> => ({
    check: () => true,
    run: async (_, pair) => {
      const results: [Json, Json] = [await pair.legacy.apply(action), await pair.next.apply(action)];
      const differs = await compare(parity, pair, results);

      if (differs) throw new Error(`${parity.domain}: after ${JSON.stringify(action)}, ${differs}`);
    },
    toString: () => JSON.stringify(action)
  });

  const Advance = (step: number | "alarm"): fc.AsyncCommand<object, Pair<Action>> => ({
    check: () => true,
    run: async (_, pair) => {
      const to = step === "alarm" ? await pair.legacy.nextAlarm?.() : pair.time.at + step;

      if (to === undefined || to === null || to < pair.time.at) return;
      pair.time.at = to;
      await pair.legacy.due?.();
      await pair.next.due?.();
      const differs = await compare(parity, pair, [null, null]);

      if (differs) throw new Error(`${parity.domain}: after advancing to ${to}, ${differs}`);
    },
    toString: () => (step === "alarm" ? "advance to the next alarm" : `advance ${step}ms`)
  });

  const agreed = parity.actions.filter((action) => !parity.divergences?.some((divergence) => divergence.covers(action)));
  const advances = parity.advances ? [parity.advances.map(Advance), fc.constant("alarm" as const).map(Advance)] : [];
  const steps = [agreed.map(Apply), ...advances];

  return fc.asyncProperty(fc.commands(steps, { maxCommands }), async (run) => {
    const time = { at: parity.start ?? 0 };
    const clock: Clock = { now: () => time.at };
    const pair = { legacy: await parity.legacy(clock), next: await parity.next(clock), time };

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
