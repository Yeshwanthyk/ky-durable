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

Not provable yet: verified-unreachable until U3.

- **Parity (check 2):** needs `src/skills/legacy/` and a `contract.ts` the kit drives (create,
  edit, allow, run, delete). U3 builds them.
- **Invariants (check 3):** the behaviors above exist as examples; U3 turns the storage and
  allowlist ones into properties and adds mutants.
- **Stored data (check 4):** skill and kit rows seeded at B, loaded by the port.

## Gotchas

- `contracts.test.ts` › storage is red at B: a corrupt JSON column from a restore decodes to
  undefined where the test expects null. Held as red at B.
