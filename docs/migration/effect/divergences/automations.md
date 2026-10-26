# Automations: where the port differs from B on purpose

Each entry is a B bug the port fixes, with the test that holds it. Parity against B's frozen
Automations ran with stored-row reads outside the compared surface (500 runs, seed 20261025,
`test-results/parity/automations-preflip/`); B's copy was then deleted.

| ID | B does | The port does | Held by |
| --- | --- | --- | --- |
| Stored rows | Reads the model column as undefined; a corrupt model column, a row damaged past reading or a corrupt JSON column from a restore fails the read (B's own 7 stored-rows tests and `contracts.test.ts` › storage were red). | Rows decode with Effect Schema where they come in: a corrupt model column reads as the worker's model (null); a row damaged past reading (an unknown status) is left out and the rest kept; a corrupt JSON column decodes to its default. A stored model's extra keys are stripped (B passed them through; nothing reads them). | `test/invariants/automations.test.ts` › stored rows; `test/invariants/contracts.test.ts` › storage |

Changes that aren't B bugs, found in the Fable 5.1 review:

- **Gate timeout:** B passed `AbortSignal.timeout(30_000)` to the gate and awaited it, so a gate that
  ignored the signal held the alarm past 30 s. The port's `Effect.timeoutOption` interrupts at 30 s and
  aborts the gate's signal (`Effect.tryPromise`), so the fire returns at 30 s. No test drives a slow gate.
- **Views:** list and get leave out `gate_found` and `gate_found_by` (Effect `Struct` strips them;
  only a fire reads them, by its own query).
