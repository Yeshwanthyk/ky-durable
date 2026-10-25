# Automations: where the port differs from B on purpose

Each entry is a B bug the port fixes, with the test that holds it. Parity against B's frozen
Automations ran with stored-row reads outside the compared surface (500 runs, seed 20261025,
`test-results/parity/automations-preflip/`); B's copy was then deleted.

| ID | B does | The port does | Held by |
| --- | --- | --- | --- |
| Stored rows | Reads the model column as undefined; a corrupt model column, a row damaged past reading or a corrupt JSON column from a restore fails the read (B's own 7 stored-rows tests and `contracts.test.ts` › storage were red). | Rows decode with Effect Schema where they come in: a corrupt model column reads as the worker's model (null); a row damaged past reading (an unknown status) is left out and the rest kept; a corrupt JSON column decodes to its default. | `test/invariants/automations.test.ts` › stored rows; `test/invariants/contracts.test.ts` › storage |
| Zone column | Not compared: parity left stored-row reads out, and B's tests didn't cover it. | A row stored without its zone column reads as the user's zone. | `test/invariants/automations.test.ts` › keeps a row stored without its zone column, which reads as the user's zone |
