# Feature map: the domains being ported

Baseline: B = `effect-baseline` (b658a6e). Doctor first; every run reports its seed.

| Domain | Wave | Checks ready today | Feature file |
| --- | --- | --- | --- |
| Deploy | 1 (pilot) | 1, 3 (I-D1..I-D5, 4 mutants), 4 partly | [deploy.md](deploy.md) |
| Automations | 2 | 1; 3 partly (B fails 7 of its own) | [automations.md](automations.md) |
| Skills | 2 | 1; 3 partly | [skills.md](skills.md) |
| Dreaming (core: Versioned, Soul, ledger) | 3 | 1; 3 partly (row decoders) | [dreaming.md](dreaming.md) |
| Approvals | 3 | 1 | [approvals.md](approvals.md) |
| Inbound | 3 | 1 | [inbound.md](inbound.md) |
| Machines | 3 | 1 | [machines.md](machines.md) |

Not mapped yet: peers and the rest of dreaming (Wave 4).

## Conventions

- **Bar:** 500 runs of up to 30 steps (`pnpm parity <domain>` defaults). `pnpm check` runs the same
  tests at 25 runs.
- **A B bug** is pinned as an exact list in the domain's invariant test while B's code runs, so it
  can't vanish or grow unnoticed. The port fixes it, and moves it to
  `docs/migration/effect/divergences/<domain>.md` with the test that holds the fix.
- **A failed check** is a product defect when the drive was right (the port differs from B); it's a
  verifier defect when a script, fake or recipe here is wrong. Report which.
