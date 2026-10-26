# Deploy

`ky deploy` takes an owner's Cloudflare account to the release's state and never touches what
isn't ky's.

## Behaviors

- **I-D1** never writes or deletes a Worker, bucket or Access app without the `ky` tag or a `.ky`
  marker: a foreign Worker, a tagless Worker named `ky`, a foreign bucket and Access app survive.
- **I-D2** a second deploy of the same release changes nothing and makes reads only.
- **I-D3** a deploy cut off after any request k, then run again, ends where a clean deploy does.
- **I-D4** the migration tag only advances; no migration replays.
- **I-D5** `secret_text` bindings set by the owner are kept.

## User entry points

`ky deploy <name>` (cli/deploy.ts → cli/deployer.ts), the deploy workflow on merge to main, and
`ky init` (which deploys at its end). All three reach `deployCommand`; the proof drives
`deployCommand` and `initCommand` directly.

## Drive

```sh
.claude/skills/verify-ky-parity/scripts/prove.sh deploy
```

- Ratchet files: `test/node/{cli,cloudflare,deploy,overlay}.test.ts`, `test/invariants/deploy.test.ts`.
- Invariants: `test/invariants/deploy.test.ts` against `test/fakes/cloudflare.ts`. The fake's `cut`
  makes it go dark after request k, as if the Mac lost power there; `served` counts requests.
- The property mixes deploys of three releases (older, current, next with a new migration), cuts at
  any request followed by a rerun, and secrets set by the owner, on an account that already has
  someone else's Worker, bucket and Access app.
- Mutants (`test/parity/deploy/mutants/`): `adopts-any-worker`, `forgets-secrets`,
  `replays-migrations`, `unmarked-bucket`.

## Proof

- `test-results/parity/deploy/proof.json` `holds: true` at 500 runs; each `mutant-*.json`
  `holds: true`; `ratchet.json` `lost: []`.
- Recorded 2026-10-25 at 78d6f73: 500 runs, seed 1940260227, all four mutants caught.
- **Stored data (check 4):** the history old → now → next in the property is B's deployer upgrading
  its own Workers (I-D4). The port's check is the same history with B's deployer
  (`cli/legacy/deployer.ts`) for the first deploys and the port's for the rest: U1 builds it.
- **Real surface (check 5):** no UI. The owner gets a statechart of the deploy flow instead.

## Gotchas

- **B breaches two invariants.** Pinned as exact `B_BREACHES` in the test:
  - I-D2: a repeat deploy re-PUTs both Access apps, opens an assets upload session, re-uploads the
    Worker (a new version each time) and re-POSTs the subdomain.
  - I-D3: cut between `POST r2/buckets` and the `.ky` marker's PUT, the rerun refuses the bucket it
    made, forever. `KNOWN_CUTS` keeps that cut out of the property until U1 fixes it.
  A fix makes the exact-list test fail on purpose: move the entry to `divergences/deploy.md`.
- The fake keeps the last upload's metadata and a content-hash asset cache; the snapshot leaves both
  out, or every rerun looks different.
- The fake answers a cut with HTTP 400, not 503, so the Cloudflare client doesn't retry it.
- Never point any of this at a real account: doctor fails if `CLOUDFLARE_API_TOKEN` is set.
