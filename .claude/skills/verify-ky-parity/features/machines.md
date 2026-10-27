# Machines

A paired machine runs tasks for ky: it is on, paused or off, online while its hello is fresh, and every
command queued for it is delivered once, in order, even across a dropped socket.

## Behaviors

- `configure` takes only on, paused or off, and a login of own or ky; anything else refuses with B's words.
- A machine is online within `ONLINE_WITHIN_MS` of its last hello; `recheck` marks the silent ones.
- The inbox (`ky_machine_inbox`) delivers each command once, in `seq` order, acked, with `DELIVERY_RETRIES`.
- Turns (`ky_machine_turns`) close once; a report for a closed turn is dropped.
- A task's run token is revoked once the task is over or past `ISSUED_TTL_MS`.
- Pairing a code names the machine once; a wrong code refuses.
- Tables `ky_machines`, `ky_machine_inbox`, `ky_machine_logins`, `ky_machine_reports`, `ky_machine_senders`,
  `ky_machine_turns` keep their names; rows written at B decode.

## User entry points

Settings › Machines (add with a pairing code, pause, note, remove), the cloud machine listed first, the
agent's `machine` tool (list, run, send, stop, move, set), and Activity's task rows (progress, cost, stop, diff).

## Drive

```sh
.claude/skills/verify-ky-parity/scripts/prove.sh machines
```

- Ratchet files: `src/tests/{runner-protocol,runners}.test.ts`, `test/invariants/{machines,runner-wire}.test.ts`.
- Real surface: `test/web/ky.spec.ts` "runs a task on a machine…", "pauses a machine…", "adds a machine with a
  pairing code…", "stops a machine task from Activity"; `verify-ky-machines`.
