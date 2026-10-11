# Multiple cloud sandboxes: design

Goal (from the owner): "Be able to add multiple cloud sandboxes, not just one. In case I want sandboxes
for separate projects, etc."

Status: design only. No feature code yet.

## Today, in short

- One cloud machine per deploy: `env.CloudMachine.getByName("cloud")` (src/cloud.ts). Its Durable
  Object owns one container of the `ky-cloud` app (standard-1, `maxInstances: 1`, cli/deployer.ts).
- The name `cloud` is hard-wired: `CLOUD` in src/cloud-facts.ts, `listCloud()`, `cloudBusy()`,
  `#deliver` wakes only `CLOUD`, pairing and unpairing refuse `cloud`, backup leaves `cloud` out.
- It sleeps after `KY_CLOUD_IDLE_MINUTES` (default 10) with no task open. Sleep tars the home to R2 at
  `cloud-machine/save.tar.gz`; the next start restores it.
- git reaches GitHub through `github.internal`, the Worker's `GithubProxy`. One token, one list of
  allowed repos (Settings › Subscriptions), pushes only to `ky/*`.
- Routing (`pickMachine`): the machine named, else the cloud machine if it's on, else the only online
  computer.
- ky has no "project" today. The nearest things: a specialist's `machine`, an automation's `machine`,
  and the GitHub repos picked in Settings.

## 1. Model

A **sandbox** is a cloud machine. Each one has:

| Field | Notes |
| --- | --- |
| `id` | Stable, never changes. The Durable Object's name and the R2 key's folder. `cloud` for the first one. New ones get `sb-<8 random chars>`. |
| `name` | The machine name the user and the agent see, e.g. `web`, `infra`. Same rules as computer names (lowercase, digits, dashes, ≤32). Unique across all machines. Can be renamed. |
| `repos` | The GitHub repos (owner/name) this sandbox works on: its "projects". A subset of the repos picked in Settings › Subscriptions. |
| `idleMinutes` | How long it stays up with nothing open. Null means the deploy default (`KY_CLOUD_IDLE_MINUTES`, else 10). |
| state, note, login | As every machine has today (on/paused/off, the user's note). Kept in `ky_machines`, unchanged. |

New table in the PiAgent's SQLite: `ky_sandboxes (id PRIMARY KEY, name UNIQUE, repos JSON, idle_minutes, created_at)`.
It is named so backup keeps it (backup skips `ky_machine*`). The sandbox's machine row in `ky_machines`
stays keyed by `name`, so tasks, the inbox, specialists and automations keep working as they do.
The deploy-wide default lives in settings, not in this table (see 2).

What each sandbox has **of its own**:

- Its own container and disk (one Durable Object each, so one container each).
- Its own save in R2: `cloud-machine/<id>/save.tar.gz`. The first sandbox keeps today's key
  `cloud-machine/save.tar.gz`, so nothing moves.
- Its own idle timer and its own sleep. One sandbox waking or sleeping never touches another.
- Its own GitHub reach: the proxy only lets a sandbox fetch and push its own `repos`. Today's
  proxy has no idea who is calling; the fix is to pass the sandbox id as props when the
  CloudMachine sets up the interceptor (`ctx.exports.GithubProxy({ props: { sandbox: id } })`), and
  the proxy checks the repo against that sandbox's list. An empty list means "all picked repos", so
  the first sandbox behaves as today.

What stays **shared**:

- Subscriptions (Claude, ChatGPT) from the Vault. One owner, one set of logins. Each run already gets
  them at send time, so nothing changes.
- The GitHub token itself. One token; only the allowlist is per sandbox.
- The image. All sandboxes run the same `ky-cloud` image.
- The instance type (see below).

### How N sandboxes map onto Cloudflare

- One container class (`CloudMachine`) and one container app, as today. Each sandbox is a named
  Durable Object instance, `env.CloudMachine.getByName(id)`, and Cloudflare gives each its own
  container. No new class, no new migration, no new app.
- `maxInstances` on the app counts **running** containers only. Stopped ones don't count. So it
  caps how many sandboxes can be awake at once, not how many exist.
  - Today it is 1. We already hit "There is no container instance that can be provided" when a
    just-slept container still held that one slot (the 5 s retry in src/cloud.ts exists for this).
  - Set it to the sandbox cap plus one spare: cap 8 sandboxes, `maxInstances: 9`.
- Instance type is per container app, so per class. Different sizes per sandbox would need a second
  class (`CloudMachineLarge`), a DO migration and a second app. Not worth it now. All sandboxes stay
  standard-1 (½ vCPU, 4 GiB, 8 GB disk).
- Cold start: Cloudflare says 1-3 s for the container, longer for a big image. Ours today is mostly
  the image pull plus the R2 restore, about "a minute or two" as the agent tells the user. Each
  sandbox restores only its own save, so a small project's sandbox wakes faster than one big shared
  home would.

### What the CloudMachine needs to know

- Its `id`: stored in its storage on the first `wake(id, origin)`. The hub always wakes it by id.
- Its machine `name`, to pair as: it asks the PiAgent at each start (`sandbox(id)`), so a rename
  takes effect at the next start.
- Whether it is busy: `cloudBusy(id)` instead of `cloudBusy()`.
- Its idle timeout: from `sandbox(id).idleMinutes`, else the env var.

## 2. Projects and routing

A "project" is a GitHub repo. That's what ky already knows about (Settings › Subscriptions), and
it's what a sandbox can actually work on. No separate "project" object.

- A sandbox's `repos` are its projects. A repo belongs to at most one sandbox (enforced when saving),
  so "which sandbox is this repo's" has one answer.
- A sandbox with no repos (like `cloud` after migration) can reach every picked repo, but owns none
  for routing. A repo no sandbox owns goes to the default.
- One sandbox is the **default** (setting `cloud.default`, initially `cloud`). It takes work that
  names no machine and no repo.

The `machine` tool's `run` gets an optional `repo` (owner/name). MachineHub picks, in order:

1. **The machine the task names.** Unchanged. The user can still say "run it on my Mac" or "on web".
2. **The sandbox whose `repos` has the task's `repo`**, if it's on.
3. **The default sandbox**, if it's on.
4. **The only computer that is on and online.** Unchanged.
5. Else refuse and list the machines, as today.

The tool description lists each sandbox with its repos and note, so the model also picks well when
it forgets `repo`. Specialists and automations already have a `machine` field: setting a
specialist's machine to a sandbox gives a "project specialist" for free.

If the task names a repo that belongs to a sandbox that is **off** or **paused**, ky refuses and says
so, instead of quietly using the default. Running a project's work in the wrong sandbox would push
with the wrong allowlist anyway (the proxy would refuse).

## 3. Lifecycle and UI

All in Settings › Machines. Sandboxes listed first, then computers, as today.

- **Create.** "New sandbox" button: name, pick repos (from the Subscriptions list), optional note.
  Creates the `ky_sandboxes` row and the `ky_machines` row (with `CLOUD_FACTS`, unpaired, like
  `listCloud()` does). Nothing starts until a task wakes it. Refused past the cap (8) or on a deploy
  without containers.
- **Rename.** Edit the name in place. Allowed only while the sandbox is asleep and has no open task.
  One SQLite transaction in the PiAgent renames it everywhere the name is a key: `ky_machines`,
  `ky_machine_inbox`, the task feed's `worker`, specialists' and automations' `machine`, and the
  default setting. The `id` (DO, R2 key) doesn't change, so nothing in Cloudflare moves. The old
  pairing token is revoked; the next start pairs under the new name.
- **Delete.** Confirm dialog: "Delete web? Its tasks end and its saved disk (12 MB) is deleted. This
  can't be undone." Then:
  1. Same as unpairing a computer: tasks end, inbox dropped, token revoked.
  2. The CloudMachine destroys its container (if running), deletes its R2 save, and clears its storage
     and alarm.
  3. The rows go.
  Deleting the default sandbox is allowed; the default then falls to none (step 4 of routing).
  Deleting the last sandbox is allowed too.
- **Settings per sandbox:** on/paused/off and note (as today), repos, idle minutes, "make default".
- **State per sandbox:** asleep / waking / running, as today's `CloudState`, plus tasks running and
  the size and date of its last save ("saved 12 MB, 2 h ago").
- **Agent tools.** No new tool. The `machine` tool already lists, runs, moves and sets machines.
  - `list` shows each sandbox with its repos, state and whether it's the default.
  - `run` takes `repo`.
  - Create, rename and delete stay in Settings only. The agent shouldn't create containers or delete
    disks on its own. (Open question 4.)

## 4. Migration

Nothing moves. Today's machine *is* the first sandbox.

- On start, if the deploy has a container (`KY_CLOUD`) and `ky_sandboxes` is empty, insert
  `{ id: "cloud", name: "cloud", repos: [] }` and set `cloud.default = "cloud"`. This replaces
  `listCloud()`.
- `id: "cloud"` means the same Durable Object (`getByName("cloud")`), so the same container and the
  same stored origin and alarm.
- Its save key stays `cloud-machine/save.tar.gz` (a special case for id `cloud`). No R2 copy.
- `repos: []` means "all picked repos", so its GitHub reach is unchanged.
- Its `ky_machines` row (state, note, login, tasks) is untouched.
- `ky upgrade` redeploys the Worker; DO storage and R2 stay. The deployer raises `maxInstances` on the
  existing app. No data loss.
- A running cloud machine during upgrade: the Worker redeploys, the container keeps running (as today);
  the next alarm runs the new code, which reads the same storage.

**Backup and restore.**

- `ky_sandboxes` is backed up (its name avoids the `ky_machine*` skip), so a restore brings every
  sandbox back with its name, repos and settings.
- The saved disks are still left out, as today. `leftOut` lists one line per sandbox that has a save:
  "Sandbox web's saved disk: it is the old deploy's container; it starts with a fresh disk".
- `backupPlan().machines` (computers to re-pair) excludes every sandbox, not just `cloud`.
- Restoring into a deploy without containers keeps the rows; Settings shows the sandboxes as
  unavailable, and routing skips them.

## 5. Deploy and costs

**cli/deployer.ts**

- `createContainerApplication`: `maxInstances: 9` (cap + 1) instead of 1.
- The existing-app path today only updates `configuration` when the image changes. It must also
  update `maxInstances` when it differs, so an upgraded deploy gets the new cap without a new image.
  (To check in Phase 2: that `updateContainerApplication` takes `max_instances`; the Cloudflare API's
  "modify application" does.)
- No new class, binding, migration or bucket. wrangler.jsonc doesn't change.
- `CLOUD_CLASS`, `CLOUD_INSTANCE`, `CLOUD_REPOSITORY`, `KY_CLOUD` keep their meaning.

**Account limits** (Cloudflare docs, Oct 2026): 6 TiB memory, 1,500 vCPU and 30 TB disk running at once,
50 GB of images. Nine standard-1 containers are 36 GiB, 4.5 vCPU and 72 GB: far below. No limit on the
number of stopped instances.

**Costs** (Workers Paid). A sandbox costs only while awake:

| | per awake hour, standard-1 |
| --- | --- |
| Memory, 4 GiB | about $0.036 |
| Disk, 8 GB | about $0.002 |
| CPU, ½ vCPU, only while busy | up to $0.036 |
| **Total** | **about $0.04-0.07** |

- Included each month, shared by all sandboxes: 25 GiB-hours of memory (about 6 awake hours of
  standard-1), 375 vCPU-minutes, 200 GB-hours of disk.
- Asleep: only R2 for its save ($0.015 per GB-month).
- So 5 sandboxes cost the same as 1 that does the same total work. Cost grows with awake hours, not
  with the number of sandboxes. Many awake at once is the only way to spend more.

## 6. Phasing

**PR 1: named sandboxes, routed by name and repo.** Delivers the owner's goal.

- `ky_sandboxes` table, migration of `cloud` into it.
- `CLOUD` stops being special in MachineHub, pairing, removal and backup: "is a sandbox" replaces
  `name === CLOUD`.
- CloudMachine keyed by id: `wake(id, origin)`, `cloudBusy(id)`, per-sandbox save key, per-sandbox
  idle minutes.
- Settings › Machines: create, delete (with its R2 save), on/paused/off, note, repos, make default.
- Routing: named > repo's sandbox > default sandbox > only online computer. `run` takes `repo`.
- GitHub proxy checks the calling sandbox's repos.
- Deployer: `maxInstances: 9`, and updates it on an existing app.
- Tests: two sandboxes waking and sleeping on their own (src/tests/cloud.test.ts's fake box),
  routing order, delete removes the R2 save, migration keeps `cloud`'s save key, backup lists each
  save, the proxy refuses another sandbox's repo.

**Later.**

- Rename (PR 2). Small, but it touches every table that keys on the machine name, so it's safer alone.
- Per-sandbox subscriptions (e.g. a work Claude login for one sandbox).
- Per-sandbox GitHub token (a different account or org).
- Bigger sandboxes (a second class and app per instance type).
- Saved disks in backups, so a restore keeps them.
- Clone a sandbox (copy its save), reset a sandbox's disk.
- Agent can create or delete sandboxes.

## 7. Open questions (with my recommendation)

1. **What is a "project"?** Recommend: a GitHub repo. A sandbox lists the repos it's for. No new
   project concept in ky.
2. **Should a repo's work be locked to its sandbox?** Recommend: yes. The proxy only lets a sandbox
   reach its own repos, and routing sends repo work to that sandbox. That's what makes sandboxes
   actually separate.
3. **How many sandboxes?** Recommend: cap at 8, `maxInstances: 9`. Easy to raise later.
4. **Can the agent create or delete sandboxes?** Recommend: no, Settings only. It can list them, pick
   one and set on/off and note, as it can for computers today.
5. **Delete: delete the saved disk too, or keep it?** Recommend: delete it, after a confirm that shows
   its size. A kept orphan save just costs money and nobody can reach it.
6. **Can `cloud` be deleted or renamed?** Recommend: yes, both, like any other sandbox. It's only
   special in that it existed first.
7. **Rename in PR 1?** Recommend: no, PR 2. Create, delete and routing first.
8. **Per-sandbox subscriptions or instance size now?** Recommend: no, later. All share the owner's
   logins and run standard-1.
