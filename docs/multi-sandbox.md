# Multiple cloud sandboxes: design

Goal (from the owner): "Be able to add multiple cloud sandboxes, not just one. In case I want sandboxes
for separate projects, etc."

Status: PR 1 built (named sandboxes, routed by name and repo). What it changed from this design:

- The default sandbox is an `is_default` column on `ky_sandboxes`, not a settings key. One table holds
  all of a sandbox's state, and "make default" is one UPDATE.
- The GitHub side is node GT's (setup/github-egress): it takes the token out of the container.
  PR 1 builds no proxy identity or lock of its own. It gives the handler one function,
  `reposFor(id)` on the agent: the sandbox's repos, `"all"` when it has none, `null` once deleted.
  Wiring that into GT's handler, with the sandbox id in its props, follows GT's merge.
- Sandboxes are created and deleted only from Settings (`/api/sandboxes`), never by the agent.

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
  `src/skills/specialists.ts`). MachineHub, Settings routes and backup use it. The CloudMachine and the
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
  PiAgent's registry. `machineExtension` in `src/machines/machines.ts` already is one. Its state is the
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

Update (round 3): Cloudflare's HTTPS egress interception can take the token out of the container
entirely, which makes the lock a wall without per-sandbox tokens. See section 8.

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
- Per-sandbox GitHub token, scoped to its repos: the hard wall of 3b. Mostly replaced by section 8.
- Clone a sandbox (copy its save), reset a sandbox's disk.
- Agent can create or delete sandboxes.

## 7. Open questions: answers

1. **Project = a GitHub repo.** Accepted.
2. **Lock a repo to its sandbox?** Still open. Recommend: locked, and made a wall by the egress
   node of section 8 (token out of the container), which lands before PR 1.
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

## 8. Making the repo lock a wall: Cloudflare egress

Round 3 research. The question: can Cloudflare's own pieces take the GitHub token out of the
container, so the repo checks of 3b become a wall and not a guardrail?

Short answer: yes, with pieces that are already GA. Cloudflare's own docs describe our exact case.

Sources were cloned to `/tmp/cf-research` on 2026-10-11:

- `workerd` at e00652e
- `containers` at a17055c (`@cloudflare/containers` 0.3.7)
- `sandbox-sdk` at 864d929
- `cloudflare-docs` at 0d35c2c
- `computer` at 61f5aea

Paths under `docs/` below are in `cloudflare-docs/src/content/docs/`.

### 8.1 The building blocks

| Block | What it does | Status | Where |
| --- | --- | --- | --- |
| `interceptOutboundHttp(host, worker)` | Port-80 traffic to a host (or glob) goes to a Worker entrypoint, not the network. ky already uses it for `github.internal`. | GA | workerd `api/container.h:343`; `docs/containers/api/durable-object-container.mdx:531-585` |
| `interceptAllOutboundHttp(worker)` | All port-80 traffic goes to a Worker. | GA | workerd `api/container.h:345`, `container.c++:610-640` |
| `interceptOutboundHttps(sniGlob, worker)` | Port-443 traffic, matched by TLS SNI, is decrypted and goes to a Worker. A per-container CA is used; its key never leaves Cloudflare's sidecar. | GA since 2026-04-13 | workerd `api/container.h:347`, `io/container.capnp:268-292`; changelog `2026-04-13-sandbox-outbound-workers-tls-auth.mdx` |
| `enableInternet: false` | With it off, only 80 and 443 leave the container, and only to an intercept. Other ports (ssh 22, raw TCP) are denied. DNS gives placeholder answers only for covered hosts, so DNS can't leak data. | GA | workerd `api/container.h:265-281`; `docs/containers/configuration/outbound-traffic.mdx:35` and "Non-HTTP traffic" (~305-315) |
| Allow and deny lists | `allowedHosts` and `deniedHosts` in the `Container` class of `@cloudflare/containers`. Not needed if we write the handler ourselves. | GA (library) | containers `docs/egress.md:112-141, 206-258` |
| Credential injection at egress | The handler adds the secret, so the container never sees it. Per instance, keyed by `ctx.containerId` or by props. | GA (documented pattern) | `docs/containers/configuration/outbound-traffic.mdx:138-180` |
| Container identity | The DO registers the intercept with `ctx.exports.X({ props })`. Props are set Worker-side, so the container can't forge them. `ContainerProxy` passes `containerId` and `className` the same way. | GA | containers `src/lib/container.ts:321-428`; computer `backends/container/container-host.ts:322-344` |
| `interceptOutboundTcp` | Raw TCP to a Worker. | Experimental only (`workerdExperimental`); not usable in production | workerd `api/container.h:365-380` |
| `durable_object` scheduling policy | Per-instance image and size, plus snapshots. Can't be changed on an existing app. | Public beta | changelog `2026-09-30-durable-object-scheduling-policy.mdx`; `docs/containers/platform-details/scheduling-policy.mdx:18-22` |
| Secrets Store | An account-level secret store a Worker can read. | GA | `docs/containers/examples/env-vars-and-secrets.mdx:20-60` |
| Workers VPC | Lets Workers reach private networks. | GA | `docs/sandbox/coding-agents/claude-managed-agents.mdx:44` |

Cloudflare's worked examples of this exact pattern:

- `docs/sandbox/network/clone-a-private-repository.mdx` (reviewed 2026-09-24):
  - A `GitGateway` entrypoint gets `interceptOutboundHttps("github.com", …)` and
    `enableInternet: false`.
  - It allows only `git-upload-pack` for one repo and adds `Basic x-access-token:<token>`.
  - A push gets 403. The container trusts the CA through `GIT_SSL_CAINFO`.
- `sandbox-sdk/examples/coding-agents/runner/sandbox.ts:193-207` and `outbound.ts:1-41`:
  - Cloudflare's own coding-agent runner starts with `enableInternet: false`.
  - It registers `interceptAllOutboundHttp` and `interceptOutboundHttps("*")` on every start.
  - The handler refuses plain http, injects the GitHub token for github.com and the AI token for
    its gateway, and returns 403 for everything else.

How ky would use each block:

- **HTTPS intercept and injection:** the core of this. git and gh go to `github.com` and
  `api.github.com` as usual. The Worker adds the token and checks the repo.
- **Props `{ sandbox: id }`:** these tell the handler which sandbox is calling. The handler reads that
  sandbox's repos from `ky_sandboxes` on each request. Changing repos needs no re-registration.
- **`enableInternet: false`:** optional. It's a second layer (see 8.3).
- **Not useful here:**
  - Secrets Store: the token already lives in the Vault DO, which the handler can read.
  - Workers VPC: it's for reaching private networks, not for limiting them.
  - `interceptOutboundTcp`: experimental only.
  - `cloudflare-os`'s `gatekeeper-github`: an OAuth gateway for its own gadgets, not container
    egress.

### 8.2 The design: the token never enters the container

Reviewed in round 3b: Fable's review, plus a state model (8.7). Both found the same gap in the first
draft: the token goes to the runner, not just to tasks.

1. **ky stops sending the token to the container at all.**
   - Today the PiAgent reads `cloud.github()` and puts the token in every run command
     (`src/machines/machines.ts:474-477`, `:497`). The runner keeps it in memory, and the task gets it as
     `GH_TOKEN` (`cli/runner/tasks.ts:210`).
   - Delete all of that:
     - the `github` field of `RunCreds` (`src/machines/runner-protocol.ts:67`)
     - the `github()` method (`src/machines/machines.ts:103`)
     - the two reads in `machines.ts`
   - With the field gone, the type system makes sure nothing in the container holds the token.
2. **Tasks get a constant placeholder.** `tasks.ts` sets `GH_TOKEN=ky-egress` on the cloud machine,
   so `gh` thinks it is signed in and sends a header. The Worker replaces the header.
3. **Before each start, the CloudMachine registers two HTTPS intercepts:**
   `interceptOutboundHttps(host, ctx.exports.GithubEgress({ props: { sandbox: id } }))` for
   `github.com` and `api.github.com`. That's 4 of the 128 intercept entries. Props carry the
   sandbox's id, which never changes, not its name.
4. **`GithubEgress`** is today's `GithubProxy`, moved to the real hosts. One handler, split by host.
   - `github.com`: git smart HTTP only (`info/refs`, `git-upload-pack`, `git-receive-pack`).
     - Only this sandbox's repos.
     - Pushes only to `refs/heads/ky/*`, as today.
     - Anything else gets 403.
   - `api.github.com`: an allowlist, never a denylist.
     - REST `/repos/{owner}/{repo}/…` only for this sandbox's repos.
     - Also `/user`, `/rate_limit`, and `/graphql` (see 8.4).
     - Anything else gets 403.
   - Both:
     - Any `Authorization` from the container is replaced.
     - Upstream fetches use `redirect: "manual"`. Today's `fetch` follows redirects
       (`src/github.ts:107`), and GitHub redirects a renamed or moved repo, so the token could follow
       to a repo outside the list.
   - Fail closed. An unknown or deleted sandbox, or no saved login, gets 403.
5. **git needs no rewrite.** The `insteadOf` line (cli/runner/cloud.ts:61), `KY_GITHUB_PROXY` and
   `github.internal` all go away.
6. **The container trusts Cloudflare's CA.**
   - Production puts it at `/etc/cloudflare/certs/cloudflare-containers-ca.crt`
     (`durable-object-container.mdx:612`).
   - If that file exists, `ky runner cloud` writes one bundle at startup: the system CAs plus it.
   - It points `SSL_CERT_FILE` (gh) and `GIT_SSL_CAINFO` (git) at the bundle, and
     `NODE_EXTRA_CA_CERTS` at the Cloudflare file.
   - This is runner code, so the Dockerfile doesn't change.

That is the wall: nothing in the container holds the GitHub token, so GitHub can be used only
through the checks. Open internet doesn't matter for the token. Other GitHub hosts (`codeload`,
`uploads.github.com`, a raw IP with another SNI), and ssh on port 22, reach GitHub with no
credentials: public data at most.

### 8.3 Optional second layer: closed internet (deferred)

`enableInternet: false` plus `interceptAllOutboundHttp` and `interceptOutboundHttps("*")` route all
traffic through one ky handler, with an allowlist of hosts.

- **What it adds:** a task can't send code or other secrets anywhere it likes.
- **What it costs:** an allowlist to keep up to date, with every blocked host a failed task.
  - It would need ky's origin (the runner's WebSocket), the model and sign-in hosts, the package
    registries, and GitHub's download hosts.
  - HTTPS to a bare IP fails under a `*` intercept (`durable-object-container.mdx:611-640`).

Not now. Maybe later, as a per-sandbox switch.

### 8.4 What breaks, and what doesn't

| Use | With 8.2 |
| --- | --- |
| git over https: clone, fetch, pull | Works, for this sandbox's repos. Other repos get 403. |
| Pushing | Works to `ky/*` on this sandbox's repos. Other refs and repos get 403, as today. **A wall.** |
| git over ssh | No key in the container, so it fails today too. Use https. |
| gh CLI auth | Works with the placeholder token. `gh auth status` shows the real user. `gh auth login` and `gh auth token` are useless. |
| GitHub REST API (`gh api repos/...`, `gh issue`, `gh run`) | Works for this sandbox's repos; anything outside the allowlist gets 403. **A wall.** |
| GitHub GraphQL (`gh pr create`, `gh pr view`) | Passed through unchecked. `gh pr create` names the repo by an opaque node id (`createPullRequest(input:{repositoryId})`), so checking query variables can't scope it. The ceiling is the token's own repo list: the repos picked in Settings › Subscriptions, not one sandbox's. Code still can't move between sandboxes, because that needs a push. |
| Other https tools (npm, pip, curl) | Unchanged. They go straight to the internet. |
| A tool with its own CA list or pinning | Fails on the two GitHub hosts only. To check: Codex. |

The GitHub token's own permissions are the ceiling for anything allowed. Settings should name the
minimum fine-grained token permissions: Contents, Pull requests, Issues, Metadata. Inside an allowed
repo, routes like `keys`, `hooks` and `actions/secrets` are only blocked if the token lacks
Administration and Secrets.

### 8.5 Recommendation

**One PR, its own node, before PR 1.** Size M.

- `src/machines/runner-protocol.ts`, `src/machines/machines.ts`: delete the token's path to the container.
- `src/cloud.ts`: two `interceptOutboundHttps` calls instead of one `interceptOutboundHttp`.
- `src/github.ts`: GithubProxy becomes GithubEgress. It splits by host, adds the `api.github.com`
  allowlist and `redirect: "manual"`, and fails closed.
- `cli/runner/cloud.ts`: the CA bundle; drop `insteadOf` and `KY_GITHUB_PROXY`.
- `cli/runner/tasks.ts`: the placeholder `GH_TOKEN`.

Why before PR 1:

- The gap exists today, with one sandbox.
- PR 1's per-sandbox lock then becomes a lookup from the props id in GithubEgress, and a wall from
  day one.
- Before PR 1, props are `{ sandbox: "cloud" }`, and the check is today's picked repos.

The runner code ships inside the image, so the change rides the CI node's next image. Coordinate
with that node; nothing here touches workflows, the digest or the image inputs.

**Cut from the first draft:**

- the GraphQL variable checker
- `/meta`
- `REQUESTS_CA_BUNDLE` and `CURL_CA_BUNDLE`
- closed internet (8.3)

**Later, the owner's call:**

- A GitHub App token minted for one sandbox's repos, so GitHub scopes GraphQL per sandbox too. It's
  a large change, and it only adds per-sandbox scoping of PR metadata.
- Edge injection of the Claude and Codex logins and `KY_TASK_TOKEN`, which are still in the
  container today.

**Cost.**

- Containers cost the same.
- Intercepted requests run in ky's Worker. git and gh make tens to hundreds per task, far under
  Workers Paid's 10M included a month, even if they are billed.
- Pack data streams through without parsing.

**Limits.**

- Workers Paid, as today.
- 4 of 128 intercept entries.
- Compatibility date 2026-04-02 or later (containers `src/lib/container.ts:1582`); ky's is
  2026-10-03.

### 8.6 Still unknown, each a short test on a dev deploy

1. **HTTPS interception on ky's `default` scheduling policy.** Likely fine.
   - The API reference badges only `image`, `instance` and `snapshotContainer` as "durable_object
     policy only" (`durable-object-container.mdx:61, 109-111, 312`).
   - The HTTPS changelog points to `@cloudflare/containers@0.3.0`, which targets the default policy
     (changelog `2026-04-13-…mdx:122`).
   - ky already uses `interceptOutboundHttp` on the default policy.
   - If it does fail: a new container app (the `durable_object` policy is beta and can't be changed
     on an existing app), which would be its own node.
2. **Do intercepts survive a Worker deploy while the container runs?** Today's `github.internal`
   has the same question. If they don't, git and gh fail closed until the next start. Not a leak.
3. **Is the CA file there when the runner starts?** If not, the runner waits briefly or the start
   fails loudly.
4. **Codex's trust store.** It only matters if Codex talks to GitHub itself.
5. **Are intercepted requests billed** as Worker requests? Small either way.

### 8.7 State model: how many moving parts?

**Stored state: none new.** The checks read state that already exists, live, on each request:

- The Vault: the token and the picked repos. Owner: Vault.
- `ky_sandboxes`: the sandbox's repos and `deleted_at`. Owner: PiAgent; arrives with PR 1.

The allowed set is derived, never stored:

```
allowed(sandbox) = picked ∩ (sandbox.repos, or all picked if empty)
                   empty if the sandbox is unknown or deleted, or there is no login
```

**Per-container runtime state**, rebuilt on every start:

- two intercept registrations (owner: CloudMachine)
- Cloudflare's CA file (owner: Cloudflare)
- the CA bundle and env (owner: the runner)

**Removed:**

- the token in run commands, in runner memory and in task env
- `RunCreds.github` and `github()`
- `github.internal`, `insteadOf` and `KY_GITHUB_PROXY`

**Transitions:**

| Trigger | Actor | Writes | If it fails or races |
| --- | --- | --- | --- |
| Sandbox starts | CloudMachine | Registers intercepts (props: id), then starts | A failed registration stops the start. A start without intercepts can't reach GitHub with a token: fails closed. |
| git or gh request | GithubEgress | Nothing. Reads Vault and `ky_sandboxes`, checks, injects, fetches with manual redirects | A missing sandbox, deleted sandbox or missing login gets 403. |
| Repos or picked repos change | Settings → PiAgent or Vault | One row | The next request sees it. No restart or re-registration, since props carry only the id. An in-flight push finishes under the old set. |
| Token rotated | Settings → Vault | Vault | The next request uses the new token. Better than today, where a running task keeps the old one. |
| Sandbox deleted | PiAgent | Destroys the container, then sets `deleted_at` | A container still dying gets 403 from then on. |
| New sandbox from a kept disk (reuses the id) | PiAgent | Clears `deleted_at`, new repos | Props id → the current row, so the new repos apply. |
| Rename (PR 2) | PiAgent | The name | Props carry the id, so nothing changes. |
| ky upgrade with an old container running | Deployer | New Worker; the old image keeps running until restart | The old runner gets no token, and its `insteadOf` points at `github.internal`, now gone: git and gh fail closed until the sandbox restarts on the new image. Acceptable: idle sleep restarts it soon. |

**Invariants and where each is enforced:**

1. **The token never goes into a container.** Enforced in `src/machines/machines.ts`, the only sender, and by
   the type: `RunCreds` has no `github` field.
2. **Every request carrying the token names a repo in `allowed(sandbox)`.** Enforced in
   GithubEgress, the only code that adds the token for containers.
3. **Pushes only update `refs/heads/ky/*`.** Enforced in GithubEgress (existing).
4. **Sandbox identity comes only from props the CloudMachine sets, keyed by the id that never
   changes.** Enforced in `CloudMachine` start.
5. **Fail closed.** Enforced in GithubEgress.

Security depends only on 1. The intercepts, the CA and the placeholder are for things to work; if any
of them is missing, git and gh just fail.

**Proof:**

- **Unit tests on GithubEgress**, a table of host × path × method × sandbox × redirect:
  - the token is added only when allowed
  - 403 otherwise
  - a 3xx is returned, not followed
- **A property test:** for random repo sets and request paths, the token is added exactly when the
  path names a repo in `allowed`. The reference is the derivation formula above.
- **A test that no run command sent to a cloud machine contains the token.**
- **A fuzz test** of the receive-pack ref parsing, if there isn't one yet.
- **A dev-deploy check** for each unknown in 8.6.
