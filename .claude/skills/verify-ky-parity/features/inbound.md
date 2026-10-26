# Inbound

A hook URL posts into a chat as outside data that asks before it changes anything, and ky calls an API
with a credential it never shows the model.

## Behaviors

- A delivery is accepted once in `SEEN_MS` (7 days); a repeat is dropped.
- An approved webhook action's pass is used once, within `PASS_MS` (15 minutes).
- A signed hook checks its HMAC in constant time; a bad token is 404; over 256 KB is 413; past the rate limit is 429.
- A credential goes only to its own origin, never through a redirect, with a 30 s timeout.
- Tables `ky_hooks`, `ky_hook_seen`, `ky_secret_asks`, `ky_passes` keep their names; secrets stay in the Vault.

## User entry points

`POST /hooks/<id>/<token>`, Settings' hooks page (make, rotate), a chat's secret request card, and the
`http` credential tool.

## Drive

```sh
.claude/skills/verify-ky-parity/scripts/prove.sh inbound
```

- Ratchet files: `src/tests/{inbound,access}.test.ts`.
- Real surface: none at B beyond the Worker tests. Wave 3 adds a local-stack recipe (make a hook, post a
  signed and an unsigned delivery, approve its action) to verify-ky-cli.
