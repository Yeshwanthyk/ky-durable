# Approvals

What waits for the user's tap waits once: a decision settles it, a gone approval refuses, a restart carries
or expires what was pending, and a tool's policy (Allow, Ask, Block) decides whether Executor asks.

## Behaviors

- A pending approval is decided at most once; a decision on a gone one returns `{ refused: GONE }`.
- `recover` after a restart: within `CARRY_MS` an approval is carried, past it expired.
- The user is notified only when away from the chat.
- An executor input (`ky_executor_inputs`) is used once.
- Tables `ky_approvals`, `ky_tool_policies`, `ky_executor_inputs` keep their names; rows written at B decode.

## User entry points

An approval card in a chat (Approve, Deny), Settings › Executor's tool policies, a routine whose gate
pauses for approval, and inbound's webhook actions and secret requests (handlers it registers).

## Drive

```sh
.claude/skills/verify-ky-parity/scripts/prove.sh approvals
```

- Ratchet files: `src/tests/{approvals,executor,executor-status}.test.ts`.
- Real surface: `test/web/ky.spec.ts` "an app action waits for the user's tap…", "a routine's posted card can
  ask…", the Executor-program gate; the fake Executor's `approve` and `ask` programs (`src/tests/fake-executor.ts`).
  No harness scenario.
