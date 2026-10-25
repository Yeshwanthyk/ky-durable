# Deploy: where the port differs from B on purpose

Each entry is a B bug the port fixes, with the invariant test that holds the fix and the mutant that
shows the test can fail. Parity against B's frozen deployer ran with these as declared divergences
(500 runs, seed 20261025, `test-results/parity/deploy/before-flip/`); B's copy was then deleted.

| ID | B does | The port does | Held by |
| --- | --- | --- | --- |
| I-D2 | A repeat deploy of the same release re-PUTs both Access apps, opens an assets upload session, re-uploads the Worker (a new version each time) and re-POSTs the subdomain. | A repeat deploy makes reads only: when the Worker carries ky's tag and this release's, and its settings and non-secret bindings match the upload, there is no assets session and no script PUT. A version named by a commit always uploads (a dirty rebuild reuses the name). What the user sees printed is unchanged. | `test/invariants/deploy.test.ts` › I-D2; mutants `replays-migrations`, `unmarked-bucket` |
| I-D3 | Cut between `POST r2/buckets` and the `.ky` marker's PUT, the rerun refuses the bucket it made ("ky didn't create it") forever. | The rerun adopts a bucket with ky's name that it left unmarked, and marks it, only when it's empty and no Worker binds it; otherwise it refuses in B's words and leaves it. | `test/invariants/deploy.test.ts` › I-D3, I-D7; mutant `adopts-full-bucket` |

Guards the fixes added, so they can't overreach:

- **I-D6:** a changed overlay is uploaded, even for the same release (I-D2's skip must not hide it). Mutant `skips-changed-upload`.
- **I-D7:** an unmarked bucket is adopted only when empty and unbound (I-D3's adoption must not take someone's data). Mutant `adopts-full-bucket`.

Owner decision, 2026-10-25: both are fixed in U1, not on main first.
