# Fix plan (delete when every item is done)

Branch `fix/lint-and-state-traps`. Status: `todo` · `doing` · `review` (with Fable) · `done <sha>`.
Sources: the structure review (fallow + subagents), `explainers/ky-architecture/quint/README.md`, `explainers/ky-architecture/current-map.md`.
Progress is mirrored in `explainers/ky-architecture/index.html` (section "fixing now").

## DAG

```
L ─┐
   ├─ G (gate) ──┬── A (bugs: executor, browse, ui submit id)
G ─┘             ├── B (runner protocol, Quint) ──── S (sockets, task row)
                 ├── M (models + prompt)  ─────────┘
                 └── U (client App split, README)
```
L and G run in parallel; nothing else starts until both are merged. Each lane is implemented by an Opus subagent in its own worktree,
merged here, then the whole lane goes to Fable for verification before it's marked done. One giant PR to `main` at the end.

**Rules for every lane.**
- `pnpm gate` must pass before a merge and after it. The gate is the regression check: every feature in `FEATURES.md` that passed at
  baseline must still pass.
- No backward compatibility: rename, reshape tables and drop shims freely. But no working feature may be lost.
- Tests are end to end only: real worker, real DO, real runner process, real browser. Fakes only at the outside boundary
  (model provider, the `claude` binary, Executor, Browser Rendering, VibeProxy). No mock-only unit tests, no module mocking.
- Structure and quality are gated too: oxlint anti-slop at 0, fallow structure checks at 0, typecheck of worker **and** runner.

## L: lint and dead code

| id | item | status |
|---|---|---|
| L1 | Delete dead code: `src/ui/appearance.ts`, scotty-era branches, unused CSS (~100 lines), the dead anti-slop `effect/` dir | review |
| L2 | Drop unused deps `@cloudflare/kumo`, `@phosphor-icons/react` | review |
| L3 | `pnpm lint` to zero: fix all anti-slop errors (387 at baseline: spacing 263, shape-in-names 55, type-assertion comments 28, …), no rules disabled | review |

## G: the gate (e2e harnesses + regression baseline)

| id | item | status |
|---|---|---|
| G1 | `FEATURES.md`: inventory every working feature (UI, chat, chats/sidebar, settings slots, titles, activity panel, subagents, machine tasks, files/lightbox, memory, exec, executor, browse), each tagged `local` or `live-only` | doing |
| G2 | Local stack: the real worker under `vite dev` / wrangler with a test config; fake model (pi faux provider), fake `claude` binary, fake Executor MCP; test `KY_TOKEN` | doing |
| G3 | Worker e2e (vitest-pool-workers) runs the **real** `PiAgent` wiring, not a copy (was S4); fold `titles`/`images` unit tests into e2e | doing |
| G4 | CLI harness `pnpm harness <scenario>`: drives the local worker over WS and a real `ky-runner` process; the six Quint traps as scenarios marked expected-fail until lane B | doing |
| G5 | Web UI e2e (Playwright) over the local stack, one check per `local` feature in `FEATURES.md` | doing |
| G6 | `pnpm gate` = typecheck (worker + runner) + oxlint + fallow + worker e2e + CLI harness + web e2e; baseline recorded; `pnpm gate:live` for live-only checks | doing |
| G7 | Project skills `verify-ky-cli` and `verify-ky-web` so every lane drives the same harnesses | doing |

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
| S2 | `ky_tasks` row: replace overloaded `session`/`worker` with `kind`/`target`/`ref` (no migration: no backward compat) | todo |
| S3 | `PiSessionSockets`: replace 10 positional deps with a small typed object; split responsibilities | todo |

## U: UI and docs

| id | item | status |
|---|---|---|
| U1 | Split `App` in client.tsx (cognitive complexity 97) | todo |
| U2 | README matches the system (where things run, runner setup) | todo |

## Later (not in this branch)
Split `KY_RUNNER_TOKEN` (needs a new secret), node manifest + node tools, automations, second runner/model.
