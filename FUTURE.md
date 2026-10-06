# Future ideas

These are the next things to build. None of them blocks using ky today. For the design behind the
runner and node ideas, see `explainers/ky-architecture/primitives.md`. For the protocol models, see
`explainers/ky-architecture/quint/`.

## Structure (no behaviour change)
- **S1**: MachineHub should stop querying `ky_tasks` directly and go through TaskFeed.
- **S2**: a `ky_tasks` row overloads `session` and `worker`. Replace them with `target` and `ref` JSON. No
  migration is needed.
- **S3**: `PiSessionSockets` takes 10 positional dependencies. Give it one small typed object and split its jobs.

## Small fixes found by the gate
- **Mac status goes stale.** When VibeProxy goes offline or comes back, open pages aren't told, so the header
  and Settings stay stale until a reload. Fix: when the cached probe flips, push the new view to UI sockets.
  The server already refuses what the stand-in model can't do.
- **The client image check is dead code.** The client branch for a provider that is offline (`src/images.ts`
  `imageSupport`) almost never runs, because Settings never shows a slot on an offline provider. Either the
  fix above makes it reachable, or delete it.

## Runners and nodes
- **Nodes**: rename "machine" to "node". `hello` already carries the machine's OS, Chrome and repos (`facts`);
  add its tools and models, and keep `last_error` in `ky_machines`.
- **Machine load limits**: an optional cap on each machine's running tasks, enforced by holding runs in
  `ky_machine_inbox` until one ends.
- **Node tools**: a pi tool whose handler runs on a node (example: `apple_reminders` on the Mac). It blocks
  the turn and has a deadline. If the node is offline, it fails at once and doesn't queue. Open choice: when
  the node is offline, block, or report later?
- **Node models**: a node serves a model over its own VPC tunnel. This uses the `vibeProxy({...})` factory,
  one per tunnel. Model traffic never goes over the runner socket.
- **Split `KY_RUNNER_TOKEN`**: one token per node. This needs a new secret.

## Automations (in the worker)
- **Timezones per automation.** Cron is in UTC.

## Pi extensions (in the worker)
- Add extensions straight to the pi harness in the DO with pi-durable's `defineExtension` (tools, prompt
  sections, tasks, hooks). Executor, browse and memory already work this way.
- Make adding one a single step: one file in `src/extensions/`, registered in one list, with its own e2e test
  through `drive.ts`.
- Placement is part of the extension: it runs in the worker by default. Mac-only ones (such as Apple Reminders)
  use the `nodeTool()` helper and run on a node (see Runners and nodes).

## Other models
- ChatGPT models through a subscription proxy, as one more `Models` endpoint.
