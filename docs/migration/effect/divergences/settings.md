# Settings and transcript: where the port differs from B on purpose

Parity against B's frozen settings and transcript ran with these outside the compared surface (500 runs,
seed 20261025); B's copy was then deleted.

| ID | B does | The port does | Held by |
| --- | --- | --- | --- |
| Extra keys | Stores a model choice as sent, with any keys beyond provider, model and level, and hands them back on read. | Stores and returns only provider, model and level (Effect `Struct` strips the rest); nothing read the extra keys. | `test/invariants/settings.test.ts` › keeps only a choice's provider, model and level, whatever else it carries |
| Damaged entries | A specialist reply or look post whose stored data is damaged projects as a message with `text: undefined`, which the thread renders as an empty bubble. | The entry decodes with Schema; one that doesn't decode projects to nothing, so the thread shows nothing for it and the rest of the transcript loads. | `src/core/transcript.ts` › `specialistReply`, `lookPosted` |
