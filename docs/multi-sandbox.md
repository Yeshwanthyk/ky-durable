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

New table in the PiAgent's SQLite: `ky_sandboxes (id PRIMARY KEY, name UNIQUE, repos JSON, idle_minutes, created_at, deleted_at)`.
It is named so backup keeps it (backup skips `ky_machine*`). The sandbox's machine row in `ky_machines`
stays keyed by `name`, so tasks, the inbox, specialists and automations keep working as they do.
The deploy-wide default lives in settings, not in this table (see 2). A row with `deleted_at` set is a
kept disk, not a sandbox (see 3). Why this table and not a DO of its own: see 3a.

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
- **Delete.** The owner's call: the saved disk is **kept**. Confirm dialog: "Delete web? Its tasks
  end. Its disk (12 MB) is kept under Kept disks until you delete it there." Then:
  1. Same as unpairing a computer: tasks end, inbox dropped, token revoked.
  2. If the container runs, the CloudMachine saves it to R2 first (as a sleep does), then destroys
     it and clears its own storage and alarm. If that save fails, the last good save stays and
     Settings says so.
  3. The `ky_machines` row goes. The `ky_sandboxes` row stays with `deleted_at` set: it is now a kept
     disk, and keeps its old name, id and repos.
  Deleting the default sandbox is allowed; the default then falls to none (step 4 of routing).
  Deleting the last sandbox is allowed too.
- **Kept disks.** A section under the sandboxes in Settings › Machines, shown only when there is one.
  Each line: the old name, the save's size and date (from R2's `head`, so always true), and a Delete
  button. Delete there removes the R2 object and the row, after a confirm. Kept disks don't count
  toward the cap of 8; they cost only R2 storage ($0.015 per GB-month).
- **Start a new sandbox from a kept disk.** Cheap, so in PR 1. The create form gets "Start from:
  a fresh disk / <kept disk>". Picking one reuses the kept row's `id` for the new sandbox: same
  Durable Object name, same R2 key, so its first wake restores that save. No copy, no new code path
  in the CloudMachine. The kept row becomes a live sandbox again, with the new name; it leaves Kept
  disks. One kept disk starts one sandbox.
- **Settings per sandbox:** on/paused/off and note (as today), repos, idle minutes, "make default".
- **State per sandbox:** asleep / waking / running, as today's `CloudState`, plus tasks running and
  the size and date of its last save ("saved 12 MB, 2 h ago").
- **Agent tools.** No new tool. The `machine` tool already lists, runs, moves and sets machines.
  - `list` shows each sandbox with its repos, state and whether it's the default.
  - `run` takes `repo`.
  - Create, rename and delete stay in Settings only. The agent shouldn't create containers or delete
    disks on its own. (Open question 4, accepted.)

## 3a. Where sandbox state lives

What reads it, and how:

- **Routing and the tool description** (MachineHub, in the PiAgent). The `machine` tool's
  description is a sync getter, and `pickMachine` is sync. They need the sandbox list and repos
  without an `await`.
- **The GitHub proxy** (a Worker entrypoint), on each git request: "may sandbox X reach repo Y?"
- **The CloudMachine**, at each start and alarm: its name (to pair as) and its idle minutes.
- **Backup**, which reads the PiAgent's SQLite only (plus a `head` on R2).
- **Settings**, which talks to the PiAgent.

Everything a rename touches already lives in the PiAgent: `ky_machines`, the inbox, the task feed,
specialists, automations, the default setting.

### Option 1: a `ky_sandboxes` table in the PiAgent (as designed)

- **Maintain.** One new module, `src/sandboxes.ts` (a class over the PiAgent's SQL, like
  `src/specialists.ts`). MachineHub, Settings routes and backup use it. The CloudMachine and the
  proxy each call one PiAgent RPC. Code in one place.
- **Backup/restore.** Free: backup already dumps the PiAgent's tables. Kept disks come back as rows;
  their R2 objects are listed under `leftOut`, as today.
- **Rename/delete.** One SQLite transaction in one object. No cross-object step except "destroy the
  container", which only happens on delete, after the rows are settled.
- **Lock.** The CloudMachine sets `props.sandbox = id` on the interceptor, in one place
  (`containerBox.start`). The proxy asks the PiAgent `sandboxRepos(id)`. A request with no
  `props.sandbox`, or an id that is deleted, is refused. The container can't set props itself.
  Skippable only by code that sets up an interceptor without props: there is one such call site.
- **Failures.** One writer, the PiAgent. It's the object every chat already uses, so it's never
  "asleep" in a way that matters: an RPC wakes it in milliseconds. One extra RPC per git request
  (2-3 per fetch or push), small next to GitHub's own time. If the PiAgent is restarting, a git
  request fails and git says so; the task sees an error, not a wrong answer. Repo edits apply to
  the next git request; name edits to the next start (rename is only allowed while asleep anyway).
- **Tests.** The existing stack (`src/tests/stack.ts`, `cloud.test.ts`) already runs a PiAgent with
  a fake container box. Routing tests are plain unit tests on MachineHub, no DOs.

### Option 2: each CloudMachine DO owns its config

- **Maintain.** Looks self-contained, but it isn't: routing is sync in the PiAgent, so the PiAgent
  needs a copy of every sandbox's name and repos anyway. That's two copies of the same facts, kept
  in step by RPCs. Code spread over two objects.
- **Backup/restore.** Backup must fan out to N DOs and restore must write back to N DOs. Today it
  reads one object. New code, and N ways for a backup to be half done.
- **Rename/delete.** Two objects: the DO and the PiAgent's tables. Not atomic. A crash between them
  leaves a sandbox whose DO says `web` and whose tasks say `api`.
- **Lock.** Nice locality: the proxy asks the DO that is surely awake (its container is the caller).
  But the routing check reads the PiAgent's copy, so the two checks can disagree.
- **Failures.** Two writers of the same facts. Listing sandboxes wakes N DOs (cheap without a
  container, but still N RPCs on every Settings open).
- **Tests.** Need N DOs in the stack for every list or rename test.

### Option 3: one SandboxHub DO

- Same split as option 2, in one place instead of N. The PiAgent still needs a sync copy for
  routing, rename still spans two objects, backup needs a second source. It would earn its keep
  with many users or many agents sharing sandboxes. ky is one user and one agent.

### Option 4: an extension

What ky's extension points are:

- **pi-durable extensions** (`defineExtension`): tools and prompt sections installed into the
  PiAgent's registry. `machineExtension` in `src/machines.ts` already is one. Its state is the
  PiAgent's SQLite. So "an extension" here is option 1, packaged as a module. It can't add a Durable
  Object binding, a container, an outbound interceptor or a Worker entrypoint: those are part of the
  Worker's deploy (`wrangler.jsonc`, `cli/deployer.ts`, exports from `src/server.ts`).
- **An Executor app.** An outside service reached over MCP with the owner's Executor token. It could
  hold a list, but: the proxy would need an HTTPS call to Executor on every git request; Executor
  may not be connected at all; its data is not in ky's backup; and it can't start or stop
  containers. It can't own sandboxes.

So option 4 is not a real alternative; the useful part of it (keep the code in its own module, with
its own tool section) is what option 1 does.

### Pick: option 1

The PiAgent owns the sandbox list (`ky_sandboxes`, `src/sandboxes.ts`). The CloudMachine owns only
its runtime: the container, its alarm and idle timer, ky's origin, and its save in R2. Each fact has
one writer, rename and delete are one transaction, backup needs no change beyond `leftOut`.

## 3b. Q2 in plain words: lock a repo to its sandbox?

- **Routing-only.** Work on repo A goes to A's sandbox. But any sandbox's git could still fetch and
  push any picked repo.
- **Locked.** Also, the GitHub proxy refuses git from a sandbox to a repo that isn't its own.

A catch I found, true today too: cloud tasks also get the raw GitHub token as `GH_TOKEN`, for `gh`
(`cli/runner/tasks.ts`), and the container has open internet. A task can use that token directly
(`gh api`, or a git URL with the token in it, which skips the proxy's rewrite). So the proxy's
checks, today's "picked repos only" and "push only to `ky/*`" included, stop mistakes, not a task
that goes around them. A hard wall needs one fine-grained GitHub token per sandbox, scoped to its
repos (listed under Later), or no `GH_TOKEN` in the container.

Recommendation: **locked at the proxy** in PR 1. It's a few lines on top of the props work, and it
catches the real risk: an agent pushing project A's work from project B's sandbox. Say plainly in
Settings that it's a guardrail. Per-sandbox tokens for a hard wall come later, if wanted.

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
- The saved disks are still left out, as today. `leftOut` lists one line per sandbox or kept disk
  that has a save: "Sandbox web's saved disk: it is the old deploy's container; it starts with a
  fresh disk". Restored kept-disk rows whose R2 object is gone are dropped on start.
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
- Settings › Machines: create, delete (keeps its save), on/paused/off, note, repos, make default.
- Kept disks: listed with name, size and date; delete one; start a new sandbox from one.
- Routing: named > repo's sandbox > default sandbox > only online computer. `run` takes `repo`.
- GitHub proxy checks the calling sandbox's repos (a guardrail; see 3b).
- Deployer: `maxInstances: 9`, and updates it on an existing app.
- Tests: two sandboxes waking and sleeping on their own (src/tests/cloud.test.ts's fake box),
  routing order, delete saves then keeps the R2 save, a new sandbox from a kept disk restores it,
  deleting a kept disk removes the object, migration keeps `cloud`'s save key, backup lists each
  save, the proxy refuses another sandbox's repo.

**Later.**

- Rename (PR 2). Small, but it touches every table that keys on the machine name, so it's safer alone.
- Per-sandbox subscriptions (e.g. a work Claude login for one sandbox).
- Per-sandbox GitHub token (a different account or org).
- Bigger sandboxes (a second class and app per instance type).
- Saved disks in backups, so a restore keeps them.
- Per-sandbox GitHub token, scoped to its repos: the hard wall of 3b.
- Clone a sandbox (copy its save), reset a sandbox's disk.
- Agent can create or delete sandboxes.

## 7. Open questions: answers

1. **Project = a GitHub repo.** Accepted.
2. **Lock a repo to its sandbox?** Still open. Recommend: locked at the proxy, as a guardrail (3b).
3. **Cap.** 8 sandboxes, `maxInstances: 9`. Accepted.
4. **Agent.** Settings only creates, renames and deletes. The agent lists, picks, and sets on/off and
   note. Accepted.
5. **Delete.** Keep the saved disk, shown under Kept disks with its own Delete; a new sandbox can
   start from one (3). Owner's call.
6. **`cloud`.** Deletable and renamable like any other. Accepted.
7. **Rename.** PR 2. Accepted.
8. **Logins and size.** Shared logins, standard-1 for now. Accepted.
9. **Where sandbox state lives.** Still open. Recommend: option 1, the PiAgent's `ky_sandboxes`
   table (3a).
