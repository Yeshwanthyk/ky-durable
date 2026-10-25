# Deploy: where the port differs from B on purpose

Each entry is a B bug the port fixes, with the invariant test that holds the fix. Until U1 lands they
are pinned as `B_BREACHES` in `test/invariants/deploy.test.ts`; fixing one makes that exact-list test
fail, and the entry moves here.

| ID | B does | The port does | Held by |
| --- | --- | --- | --- |
| I-D2 | A repeat deploy of the same release re-PUTs both Access apps, opens an assets upload session, re-uploads the Worker (a new version each time) and re-POSTs the subdomain. | A repeat deploy makes reads only. | `test/invariants/deploy.test.ts` › I-D2 (open) |
| I-D3 | Cut between `POST r2/buckets` and the `.ky` marker's PUT, the rerun refuses the bucket it made ("ky didn't create it") forever. | The rerun adopts the bucket it made and finishes. | `test/invariants/deploy.test.ts` › I-D3; drop `KNOWN_CUTS` (open) |

Owner decision, 2026-10-25: both are fixed in U1, not on main first.
