# Fix plan (delete when every item is done)

Branch `fix/lint-and-state-traps`. Status: `todo` · `doing` · `review` (with Fable) · `done <sha>`.
Sources: the structure review (fallow + subagents), `explainers/ky-architecture/quint/README.md`, `explainers/ky-architecture/current-map.md`.
Progress is mirrored in `explainers/ky-architecture/index.html` (section "fixing now").

## DAG

```
L ──┬── A (bugs: executor, browse, ui submit id)
    ├── B (runner protocol, Quint) ──── S (sockets, task row, test worker)
    ├── M (models + prompt)  ─────────┘
    └── U (client App split, README)
```
Each lane is implemented by an Opus subagent in its own worktree, merged here, then the whole lane goes to Fable for verification before it's marked done.
`pnpm typecheck && pnpm test && pnpm lint` must pass after every merge.

## L: lint and dead code

| id | item | status |
|---|---|---|
| L1 | Delete dead code: `src/ui/appearance.ts`, scotty-era branches, unused CSS (~100 lines), the dead anti-slop `effect/` dir | todo |
| L2 | Drop unused deps `@cloudflare/kumo`, `@phosphor-icons/react` | todo |
| L3 | `pnpm lint` to zero: fix all anti-slop errors (387 at baseline: spacing 263, shape-in-names 55, type-assertion comments 28, …), no rules disabled | todo |

## A: correctness bugs

| id | item | status |
|---|---|---|
| A1 | Executor retries any error, including unsafe `execute`/`resume`; retry only on connect / expired session, and pass the abort signal (executor.ts:71-95) | todo |
| A2 | Browse can leak a browser when launch is slow and the call times out or aborts (browse.ts) | todo |
| A3 | UI submits carry no `operationId`, so a resend after a drop can double-submit (use-pi-session.ts:154-157) | todo |

## B: runner protocol (Quint `runner_protocol.qnt`, all six fail today)

| id | item | status |
|---|---|---|
| B0 | One shared `runner-protocol.ts` for the three copies of the message types; typecheck the runner | todo |
| B1 | Flush first: runner sends its outbox before `hello` (ky-runner.ts:286-288) | todo |
| B2 | Fence: reports carry the turn, DO drops reports for a closed turn, operationId `task:<id>:<turn>` (machines.ts:247-269) | todo |
| B3 | Durable handled: runner persists handled seqs before acking (ky-runner.ts:129) | todo |
| B4 | Safe stop: `stop()` withdraws only unsent runs and finishes early only if no turn reached the runner; runner queues runs for a stopping job instead of steering into it | todo |
| B5 | Reconcile: `hello` closes queued **and** working tasks that are not active and have no unacked run rows (machines.ts:208-222) | todo |
| B6 | Ordered delivery: `#enqueue` resends every pending row in seq order; runner dedupes (machines.ts:135) | todo |
| B7 | One socket per node name: a second `hello` with the same name replaces the old socket (machines.ts:138-150) | todo |

## M: models and prompt

| id | item | status |
|---|---|---|
| M1 | `models.ts` owns catalog, slots, `resolve(slot)` and fallback; today split over server.ts:73-90, 281-373, vibeproxy.ts, images.ts:53-67 | todo |
| M2 | `vibeProxy({ binding, origin, … })` takes its origin instead of the hard-coded `ORIGIN` | todo |
| M3 | PREAMBLE moves to `prompt.ts`; the Mac path/URL comes from config, not a literal | todo |

## S: state ownership (after B and M)

| id | item | status |
|---|---|---|
| S1 | MachineHub stops querying `ky_tasks` directly; goes through TaskFeed | todo |
| S2 | `ky_tasks` row: replace overloaded `session`/`worker` with `kind`/`target`/`ref` (with an in-place migration) | todo |
| S3 | `PiSessionSockets`: replace 10 positional deps with a small typed object; split responsibilities | todo |
| S4 | Test worker reuses the real DO wiring instead of duplicating it | todo |

## U: UI and docs

| id | item | status |
|---|---|---|
| U1 | Split `App` in client.tsx (cognitive complexity 97) | todo |
| U2 | README matches the system (where things run, runner setup) | todo |

## Later (not in this branch)
Split `KY_RUNNER_TOKEN` (needs a new secret), node manifest + node tools, automations, second runner/model.
