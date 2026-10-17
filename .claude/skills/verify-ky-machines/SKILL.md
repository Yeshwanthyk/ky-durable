---
name: verify-ky-machines
description: Check that ky's machines tell the truth and recover. It measures send → pickup → first output latency and checks runner kill and restart (orphans, resume), protocol skew in both directions, an agent that hangs at start, a Mac that goes offline and comes back, a silent half-open socket and a cloud wake. It prints a timing and a HOLDS/GAP verdict per invariant from docs/machine-invariants.md, and includes a read-only check of the runners on this Mac. Use it after touching cli/runner/, src/machines/, src/sockets.ts, src/cloud.ts or the runner protocol, or when a machine looks wrong.
---

# Verify ky machines

There are two tools:

- `bench.ts` runs the real Worker, the real `ky runner` and a fake `claude` locally. It times each step and gives each invariant a verdict.
- `live.sh` is read-only. It inspects the runners actually installed on this Mac.

The invariants these check (M1–M16) and the last baseline are in `docs/machine-invariants.md`.

## Launch

1. Run `pnpm install --offline` once per checkout. The bench imports `test/harness`.
2. Nothing else. The bench starts its own stack (`wrangler dev` with `src/tests/wrangler.jsonc`) on a free port and stops it at the end. If you export `KY_STACK_URL` to point at a `pnpm stack` you started yourself, the bench uses that instead (see verify-ky-cli).

## Doctor (read-only)

- `node --version`: must be 22 or newer (`--experimental-strip-types`).
- `test -x node_modules/.bin/wrangler && echo ok`
- `sh .claude/skills/verify-ky-machines/live.sh`: for each runner on this Mac (one per deployment, in `~/.ky` and `~/.ky/<as>`) it shows:
  - what the status file claims, and whether its pid is alive
  - the launchd state and last exit
  - a timed GET of that Worker
  - counts from the runner log: 1006 disconnects, connects, goodbyes, restarts with no disconnect line before them, and `exit null` agent deaths
  - agents that are running long on almost no CPU

  It ends with a scan for orphaned task agents whose parent is launchd. It changes nothing; its only network calls are one GET per Worker.

## Drive

```sh
node --experimental-strip-types --no-warnings .claude/skills/verify-ky-machines/bench.ts <probe...|all> [--runs N] [--quick] [--hang-watch MS] [--outage MS] [--silence MS]
```

| Probe | What it does | Invariants | Time |
|---|---|---|---|
| `latency` | Sends N tasks to a connected machine and timestamps row → ack → spawn → working → first step → done. Reports p50/p95. | M5, M6 | ~1 s per run |
| `restart` | Starts a task with an agent that ignores SIGINT for 15 s, stops the runner the way launchd does, checks the agent is gone 6 s later, relaunches, and reads what happened to the task. | M12, M13 | ~7 s |
| `skew` | *Worker ahead*: the proxy rewrites the Worker's goodbye so it looks newer, and the runner tries again every 3 s (`KY_RUNNER_PROBE_MS`). Times how long until the runner's status says `outdated`, checks it is still running 4 s later, then lets hellos through and times its return. A raw socket with `PROTOCOL-1` checks what the UI says. *Runner ahead*: a raw socket says hello with `PROTOCOL+1`. Records the close code and goodbye, and whether the machine was ever listed online or given a reason. | M2, M3, M10, M11 | ~9 s |
| `hang` | Uses an agent that answers `auth`/`--version`, then never writes and ignores SIGINT (today's incident). Waits `--hang-watch` ms (default 70000: the runner's 60 s first-output watchdog plus its 5 s SIGKILL), then reads the task status and `runner-status.json`, stops the task, and checks the pid is gone. | M6, M7, M8 | ~75 s |
| `offline` | Cuts the network (refusing reconnects), sends a task while offline, and restores the network after `--outage` ms (default 5000). Times offline shown, back online, and the queued task done. | M4, M5 | ~8 s |
| `halfopen` | Holds every frame both ways for `--silence` ms (default 85000) without closing the socket. Checks the UI shows offline once the runner is silent past 75 s. | M3 | ~85 s |
| `cloud` | Wakes the cloud machine against a local fake container host (`test/fakes/container.ts`). Times row → waking → runner online → done. | M16 | ~2 s |

- `--runs` defaults to 5; the baseline used 10. `--quick` leaves out `halfopen` (85 s) when running `all`. A full `all` run takes about 2.5 min.
- Each probe prints its timings, then one `HOLDS` or `GAP` line per check. A probe that throws prints `ERROR`. Today a GAP is an expected finding, not a failure. The exit code is non-zero only on an `ERROR`, which means the probe itself broke.
- Once a fix lands, its GAP should become HOLDS. Re-run that probe and update the baseline table in `docs/machine-invariants.md`.
- **Live cloud is skipped on purpose.** The account behind squarey has no Workers Paid plan, so it can't run Containers (`ky upgrade` reports this). The `cloud` probe only covers the hub's wake logic against a fake host. Run a live wake only when asked, and only on a deployment with Containers enabled.

## Evidence

- `test-results/machines-bench/results.json` holds every probe's timings, checks and wall time.
- `test-results/machines-bench/<probe>/<machine>/` has `runner-N.log` per launch, `claude.jsonl` from the fake agent, and the machine's throwaway `home/`, `work/` and `state/` (including `runner-status.json`).
- When you report, quote the timing table and the HOLDS/GAP lines, and cite the runner log for any ERROR.

## Isolation

- Every bench runner gets its own temporary `HOME`, `KY_WORKDIR` and `KY_STATE_DIR`. `~/.ky`, `~/.claude` and the launchd services are never touched.
- The `restart` probe orphans a fake agent on purpose, because that's the bug. The probe kills it afterwards. `live.sh` ignores anything under `test/fakes/`.
- `live.sh` is the only part that looks at real runners, and it only reads.
- Never point `KY_STACK_URL` at a deployed Worker. Don't commit `test-results/`.
