# Skills: where the port differs from B

U3 fixed no B bugs on purpose. Parity against B's frozen library ran with no declared divergences
(500 runs, `test-results/parity/skills-pre-flip/`); B's copy was then deleted.

| ID | B does | The port does | Held by |
| --- | --- | --- | --- |
| Corrupt-row wording | A stored skill or version row that doesn't decode throws `Error("a stored skill isn't what ky expects.")`. | It still fails, as a defect carrying Effect's `SqlError` (its query and cause) in place of B's sentence. Only the words differ; nothing catches them. | — (Fable 5.1 review, finding 2) |

Left as it is, by design (Fable 5.1 review, finding 5): a watcher's refusal (the dreaming ledger's
one change per run) is still a `throw` inside the library, so it travels as a defect and reaches the
model in B's exact words. It becomes a typed refusal when the ledger is ported.
