# Dreaming (Wave 3: the core)

SOUL.md and each specialist's brief keep every version and change only as asked; a dream changes each
skill or summary at most once a run, and the owner can undo that change unless something changed it since.

Wave 3 ports the core only: `src/dreaming/versioned.ts`, `soul.ts`, `ledger.ts`. The rest of dreaming
(memory, anticipations, recall, looks, episodes, `dreaming.ts`) waits for Wave 4.

## Behaviors

- **Versioned:** versions are numbered per key (`soul`, `specialist:<id>`); edit, patch and revert refuse in
  B's words (missing, empty, over 20000 characters, text not found, text found N times); listeners hear each save.
- **Ledger:** one destructive change (edit, patch, archive, revert, forget) per target a run (`ledger.ts:89`,
  untested at B); undo refuses when the target changed since or was pinned; undo is once.
- **Couplings into skills:** specialists' `brief(id)` and the skills library's watcher (`skills.ts:328`).
- Tables `ky_soul_versions`, `ky_dream_ledger` keep their names; rows written at B decode.

## User entry points

The Soul tab (SOUL.md and specialists' briefs, edit and revert), Activity › Last night (list, undo, pin),
the `soul` tool, and a nightly dream through the skills library.

## Drive

```sh
.claude/skills/verify-ky-parity/scripts/prove.sh dreaming
```

- Ratchet files (`pnpm census dreaming`): the dreaming census plus `src/tests/{features,skills,specialists}.test.ts`.
- Real surface: `test/web/ky.spec.ts` "lists last night's dream in Activity…" and "creates a specialist in the
  Soul tab…"; the harness scenario `dreaming`; verify-ky-cli's `POST /test/dream`.
