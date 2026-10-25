# Skills: where the port differs from B

U3 and U3b fixed no B bugs on purpose. Parity against B's frozen library ran with no declared divergences
(500 runs, `test-results/parity/skills-pre-flip/`), as did specialists' (500 runs, seed 20261025, in
U3b's `test/parity/skills/specialists.test.ts`); B's copies were then deleted.

| ID | B does | The port does | Held by |
| --- | --- | --- | --- |
| Corrupt-row wording | A stored skill or version row that doesn't decode throws `Error("a stored skill isn't what ky expects.")`. | It still fails, as a defect carrying Effect's `SqlError` (its query and cause) in place of B's sentence. Only the words differ; nothing catches them. | — (Fable 5.1 review, finding 2) |
| Corrupt specialist wording | A specialist or session row damaged past reading (a NULL description, a kind outside the four) throws `Error("a stored specialist isn't what ky expects.")` or `"a specialist's conversation isn't what ky expects."`. | The same defect class as above: it fails with Sql's decode error in place of B's sentence. A damaged model column still reads as null, as at B. A row read with `SELECT *` loses columns its Schema doesn't name, where B's check kept them; nothing reads such columns today. | — (same class as finding 2; Fable 5.1 specialists review, finding 2) |

Left as it is, by design (Fable 5.1 review, finding 5): a watcher's refusal (the dreaming ledger's
one change per run) is still a `throw` inside the library, so it travels as a defect and reaches the
model in B's exact words. It becomes a typed refusal when the ledger is ported.

Left as they are (Fable 5.1 specialists review, findings 5 and 6): `storage`, the dying adapter over
`Sql`, lives in `skills.ts` and specialists imports it from there, inside the same domain; and
`Roster`'s brief is a hook back into the facade until Versioned is ported, when it becomes a service.
