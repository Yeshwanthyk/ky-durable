# Skills

The owner's skills and kits are stored, listed, allowed and run as they were at B.

## Behaviors

From `test/invariants/skills.test.ts`, which already holds them for B's code:

- **each tool's actions**: every action the skills tool takes is in its contract.
- **allowlists**: a skill reaches only what its allowlist names.
- **storage**: skill rows round-trip, and the tables keep their names.
- **the panel's specialist sheet**, **a skill's Needs**, **a kit's Members**: what the UI shows
  follows from the stored skill.

## User entry points

The Skills page (web), the chat's skill tool, a machine running a skill through the runner, and
the group/guardrail paths that load skills.

## Drive

```sh
.claude/skills/verify-ky-parity/scripts/prove.sh skills
```

- Ratchet files (`pnpm census skills`): `src/tests/{features,group,guardrails,skills}.test.ts`,
  `test/invariants/{contracts,skills}.test.ts`.
- Real surface: verify-ky-cli's skills recipe and verify-ky-web's Skills page; the harness
  scenarios `skills` and `skill-review`.

## Proof

Provable: `prove.sh skills` passes on the port alone (U3, legacy flipped out).

- **Parity (check 2):** ran B against the port until the flip; the evidence of that run is
  `test-results/parity/skills-pre-flip/`. There is no parity side now.
- **Invariants (check 3):** `test/invariants/skills.test.ts` holds the storage round-trip,
  allowlist, pin guard, stale sweep and kept answers as properties, and specialists' ids, saves
  and attaches; nine mutants in `test/parity/skills/mutants/`, each caught.
- **Stored data (check 4):** `test/parity/skills/at-b.test.ts` opens rows B wrote
  (`at-b.json`, with B's own reads of them) under the port; on real data, `real-data.ts`.
  `at-b.json` includes B's specialist tables (sessions, brief versions, a damaged model column).
- `subagents.ts` keeps no Durable Object storage, so it has nothing to port. Specialists have no harness
  scenario; their real surface is verify-ky-web (Soul's specialist sheet, group-chat seats).

## Gotchas

- A specialist's stored model keeps B's parsed object once `Schema.is(StoredModel)` passes: decoding it
  rebuilds the keys in field order and rewrites the stored bytes on a save that leaves the model out.
