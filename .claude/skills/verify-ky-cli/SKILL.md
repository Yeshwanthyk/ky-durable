---
name: verify-ky-cli
description: Verify a ky change from the command line. Start the local stack, run the real Mac runner against it with a fake claude, drive scenarios with `pnpm harness`, and collect the logs. Use it after touching src/machines/machines.ts, src/sockets.ts, src/skills/skills.ts, src/dreaming/dreaming.ts, src/automations/automations.ts, cli/runner/, or anything else a machine task, skill, automation or the socket protocol goes through.
---

# Verify ky from the CLI

Everything here runs on this Mac against the local stack. It never touches the deployed worker or `~/.ky`.

## Launch

1. Run `pnpm install --offline` once per checkout. The runner and the harness import from `node_modules`.
2. Start the stack in the background with `pnpm stack`.
   - This is the real Worker and PiAgent (`src/tests/stack.ts`). The outside boundary is faked:
     - the faux model
     - a fake VibeProxy (the Mac starts away)
     - a fake Executor
     - a fake browser
   - The port is `KY_STACK_PORT` (default 8790) and the token is `ky-stack-token`.
3. Wait until the stack is ready, then point the harness at it:
   ```sh
   until curl -fsS -o /dev/null http://127.0.0.1:8790/manifest.webmanifest; do sleep 1; done
   export KY_STACK_URL=http://127.0.0.1:8790
   ```
   If you leave `KY_STACK_URL` unset, `pnpm harness` starts its own stack on a free port and stops it when it finishes.
4. Teardown: send Ctrl-C or SIGTERM to `pnpm stack` (`kill -TERM $(lsof -t -iTCP:8790 -sTCP:LISTEN)`). pnpm then reports exit code 143, which is expected. Each start gets a fresh `ky-stack-*` state directory in the temp dir, and the line `ky stack: state in …` names it.

## Doctor (read-only)

Run these before driving. None of them changes anything.

- `node --version`: must be 22 or newer, because the runner and harness use `--experimental-strip-types`.
- `test -x node_modules/.bin/vite && echo ok`: dependencies are installed.
- `lsof -nP -iTCP:8790 -sTCP:LISTEN`: either nothing is listening, or it is your stack.
- `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8790/manifest.webmanifest`: prints 200 when the stack is up.
- `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8790/test/gate-runs`: prints 401 without the token, which shows the auth gate is on.
- `pnpm harness --list`: shows every scenario and whether it is expected to `pass` or `xfail`.

## Drive

- To run scenarios, use `pnpm harness <scenario...|all>`. For example, `pnpm harness chat machine-run stop`.
  - Each scenario starts real runners (`ky runner run`, from `cli/runner/`) with the fake `claude` (`test/fakes/claude.ts`), through a fault proxy (`test/harness/proxy.ts`). The proxy can hold, drop or cut frames.
  - Outcomes:
    - `PASS`
    - `FAIL`
    - `XFAIL`: a known trap still fails.
    - `XPASS`: a trap now holds, so flip it to `pass` in `test/harness/scenarios.ts`.
  - The exit code is non-zero on any FAIL or XPASS.
- Fake claude reads directives in the prompt. `[delay=MS]` makes a turn take that long.
- Test controls on the stack all need `Authorization: Bearer ky-stack-token`:
  - `POST /test/mac?up=1|0|leaves`: the Mac comes online, goes away, or has just left with no probe.
  - `POST /test/release`: releases the waiting `gate` tool calls. Send the prompt `gate` to start one.
  - `GET /test/gate-runs`: lists the gate tool runs so far.
  - `POST /test/review-after?n=N`: a turn with N tool calls gets a skill review. The default is 5.
  - `POST /test/dream`: runs a dream now and answers when it ends.
  ```sh
  curl -fsS -X POST -H 'Authorization: Bearer ky-stack-token' 'http://127.0.0.1:8790/test/mac?up=1'
  ```
- When adding a scenario, write it as a check of what the user sees: task status, history and turns. Don't check internals.

## Features

`features/README.md` maps each feature area (chat, machine tasks, skills, automations) to the scenarios that drive it
and says what the harness can't reach. After adding a scenario, add its row there.

## Evidence

- `test-results/harness/<scenario>/<machine>/` holds:
  - `runner-N.log`: one per launch, with stdout and stderr.
  - `claude.jsonl`: every fake claude start, turn, SIGINT and exit.
  - the machine's throwaway `home/` and `work/` (plus `state/` once the runner reads `KY_STATE_DIR`).
- `test-results/harness/results.json` has the outcome and detail for each scenario.
- `test-results/harness/stack.log` is the stack log, written when the harness started its own stack.
- Quote the harness summary lines (`PASS  chat …`) in your report, and cite the log file for any FAIL.

## Isolation

- Every runner gets its own temporary `HOME`, `KY_WORKDIR` and `KY_STATE_DIR` under its scenario directory, so `~/.ky` and `~/.claude` are never read or written.
- The stack keeps Durable Object, R2 and KV state in a fresh temp directory and uses `src/tests/wrangler.jsonc`, not the production config.
- Never set `KY_URL` or `KY_STACK_URL` to the deployed worker, and never use a real Access token here. Live checks are `pnpm gate:live`, and you run them only when asked.
- Don't commit anything under `test-results/`; it is gitignored.
