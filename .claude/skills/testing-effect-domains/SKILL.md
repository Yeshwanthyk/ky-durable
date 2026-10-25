---
name: testing-effect-domains
description: Proves a ported ky domain matches B: `@effect/vitest` with TestClock, invariants in `test/invariants/`, the parity kit (`Parity`, `Instance`, `Divergence`, `assertParity`, `budget()`) driving `legacy/` against the port, mutant patches run by `pnpm parity <domain> --mutant`, and the prune ledger fed by `pnpm census`. Use when writing or running a domain's parity, invariant or mutant tests, deleting a test during a port, declaring a divergence from B, or replacing a sleep with TestClock.
---

# Test a ported Effect domain

A port is done when a proof says it behaves as B did. The proof is the domain's entry in `PROOFS` (`test/parity/run.ts`): its invariant tests, plus its parity runs while `legacy/` exists. `pnpm parity <domain>` runs that proof at the bar, 500 runs of up to 30 steps. Each mutant must then fail it.

## Steps

1. **Census.** Run `pnpm census <domain>` to sort each test file the domain touches (`test-results/census/<domain>.json`) and see what you keep and what the ledger may take.
2. **Invariants.** Write the rules that hold whatever the code looks like, in `test/invariants/<domain>.test.ts`, and observe from outside the domain.
3. **Parity.** Drive `src/<domain>/legacy/` and the port with the same generated actions, and compare what a caller sees.
4. **Mutants.** Write patches that break the port in ways a real bug would, under `test/parity/<domain>/mutants/`.
5. **Prune.** Delete what the census marked for pruning, logging each test in the ledger.

Done when all of these pass:
- `pnpm parity <domain>` prints `PASS  <domain>: 500 runs of up to 30 steps`
- `pnpm parity <domain> --mutant all` prints `PASS … caught by <test>` for every mutant, where the test held in that invocation's clean proof (the runner skips mutants when the clean proof fails)
- `pnpm ledger`
- `pnpm check`

## Invariants

An invariant names a rule a user would state, and checks it on what the domain leaves behind (its tables, the account, the messages sent), never on its internals. `test/invariants/deploy.test.ts` is the worked example:
- It drives `deployCommand` against the fake Cloudflare (`test/fakes/cloudflare.ts`) and asserts only on the fake account: I-D1 through I-D5 in its header comment.
- It cuts the power after every request, and its generated runs mix deploys, cuts and secrets.
- It takes its run count from `budget()`, so `pnpm check` stays quick and `pnpm parity deploy` runs 500.
- It pins B's known breaches exactly in `B_BREACHES`, with an `expect(...).toEqual(B_BREACHES[...])` per invariant. A new breach means the port broke something. A listed breach that disappears means the port fixed it: move it out of `B_BREACHES` and into `docs/migration/effect/divergences/<domain>.md` (create the file), naming the test that holds the fix.

Name each invariant `I-<letter><n>` in the test's title, so a mutant's "caught by" line names the rule it broke.

## Parity

The kit is `test/parity/kit.ts`; `test/parity/toy/toy.test.ts` is the worked example. Each side is an `Instance<Action>`, fresh for each run:

- `apply(action)`: the result or `{ refused }`, as the caller sees it
- `advance(ms)`: moves the side's clock and runs what's due
- `tables()`: the domain's rows, by table
- `effects()`: what it did outside its tables (messages, requests)
- `dispose()`

The kit compares result, tables and effects after every step, through `normalize` if you give one. Refusal words are compared too.

```ts
const zones: Parity<ZoneAction> = {
  domain: "automations",
  actions: fc.oneof(
    fc.record({ _tag: fc.constant("pin"), zone: fc.constantFrom("Europe/Berlin", "Mars/Olympus", "") }),
    fc.record({ _tag: fc.constant("read") })
  ),
  advances: fc.integer({ min: 0, max: 3_000 }),
  legacy: async () => legacyInstance(),
  next: async () => nextInstance(),
  // Ids and timestamps that differ without mattering; nothing a caller acts on.
  normalize: (observed) => observed,
  // Illustrative: a divergence is declared only where the port changes B on purpose.
  divergences: [
    {
      name: "refuses an empty zone",
      covers: (action) => action._tag === "pin" && action.zone === "",
      heldBy: "test/invariants/automations.test.ts > I-A3: an empty zone is refused"
    }
  ]
};

it("matches B, but where it diverges on purpose", () => assertParity(zones));
```

- **`actions` is the contract's action union** (see `modeling-effect-domain`), written as fast-check arbitraries by hand. Effect's `Arbitrary` module is not fast-check. Use `fc.constantFrom` with values that hit each branch, refusals included.
- **The legacy side is B's code, untouched**, copied into `src/<domain>/legacy/` and deleted with the port's last step.
- **A divergence is a difference made on purpose.** Its `covers` takes those actions out of the comparison, and its `heldBy` (`file > test name`) names the invariant that holds the port's new behaviour. Write that test and the divergence doc entry before adding the divergence. The kit refuses a `heldBy` whose file doesn't exist, and divergences that cover more than a quarter of sampled actions: past that, the comparison is hollow.
- **Observations are plain JSON.** The kit compares what `JSON.stringify` shows and throws on a `Map`, `Set` or class instance, which would all show as `{}`. Turn them into arrays and objects first.
- **`normalize` only hides what a caller can't act on.** If two sides differ in ordering, ids or timestamps that something reads, that difference is a bug.

## Time: TestClock

A ported domain reads time from `Clock`, so a test moves it and never sleeps. `it.effect` from `@effect/vitest` provides a TestClock:

```ts
it.effect("sends a reminder once its time comes, and not before", () =>
  Effect.gen(function* () {
    const reminders = yield* Reminders;

    yield* reminders.add("tea", 1_000);
    expect(yield* reminders.due).toEqual({ sent: [] });
    yield* TestClock.adjust("1 second");
    expect(yield* reminders.due).toEqual({ sent: ["tea"] });
  }).pipe(Effect.provide(Reminders.layer))
);
```

For parity, the port's `Instance` puts its own TestClock in the edge's Layer, and `advance` adjusts it through the same edge:

```ts
function next(): Instance<Action> {
  const edge = makeEdge(Layer.merge(Reminders.layer, TestClock.layer()));
  const sent: string[] = [];

  return {
    apply: async (action) => edge.run(Reminders.use((reminders) => reminders.add(action.add, action.inMs))),
    advance: async (ms) => {
      const due = await edge.runPromise(TestClock.adjust(ms).pipe(Effect.andThen(Reminders.use((reminders) => reminders.due))));

      if ("sent" in due) sent.push(...due.sent);
    },
    tables: async () => null,
    effects: async () => ({ sent }),
    dispose: () => edge.dispose()
  };
}
```

The edge builds its Layer once, so the TestClock lives across steps. It starts at 0: the legacy side's clock must start at 0 too, or every `at` differs. `TestClock` is `effect/testing/TestClock`.

## Mutants

A mutant is a one-line, plausible bug, kept as a patch the proof must catch (`test/parity/toy/mutants/cancel-keeps.patch`, `test/parity/deploy/mutants/*.patch`).

1. Make the bug in the port, then save it with `git diff -- <file> > test/parity/<domain>/mutants/<what-it-breaks>.patch`, then run `git checkout -- <file>`.
2. Commit or set aside any edits to the files the patch touches: the runner refuses dirty ones, since it puts them back with `git checkout`.
3. Run `pnpm parity <domain> --mutant <name>` (or `all`). PASS means the proof failed with the mutant in, and the line names the test that caught it. FAIL means the proof can't see this bug: strengthen the invariant or the parity actions until it can.

Name each mutant for what it breaks (`forgets-secrets`, `replays-migrations`), not how. A mutant that "no longer applies" means the code moved: regenerate it.

Each run writes `test-results/parity/<domain>/<run>.json` with its seed. Replay a failure with `--seed S`; shorten it with `--runs N --steps N`.

## Pruning

`pnpm census <domain>` gives each file a verdict.
- **Keep:** INVARIANT and E2E. An E2E test that sleeps is still kept.
- **Pruned once the port covers them:** MOCK, SCAN, SLEEP, COPY and UNIT.
- **UNKNOWN:** quote the line and decide in the domain thread.

Each deleted test that B's `gate-baseline.json` has gets one entry in `docs/migration/effect/prune-ledger.json`:

```json
{ "check": "node", "name": "<the test's full name in gate-baseline.json>", "class": "UNIT", "replacedBy": "parity:automations" }
```

- `check` is the baseline's check (`node`, `worker-e2e`, `harness`, `web`), and `name` is the test exactly as the baseline lists it.
- `replacedBy` is `path > test name` (the file must exist), `lint:<rule>`, or `parity:<domain>`.
- `pnpm ledger` (part of `pnpm check`) fails on an unknown test, a missing file, or a test listed twice. Without an entry, a deleted test is a regression.
- `pnpm gate` also fails on a test B never had that is red now: a new test lands green.

## Registering a proof

A new domain's proof is a line in `PROOFS` in `test/parity/run.ts`. Deploy, automations and skills are already listed. A domain's invariant file must exist before `pnpm parity <domain>` can pass. While the port is in flight, the parity test file joins the list beside the invariants.
