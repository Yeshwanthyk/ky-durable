# Specialist profiles

Goal (from the owner): each specialist has its own computer, the Macs it may use, its own browser and
logins, its own API keys, the workflows it runs, and its own rules for what needs the owner's OK. Main ky
keeps everything that exists today.

Status: Phases 1 and 2 shipped. Phase 3 is on four unreviewed branches. Phase 4 is not started. This
file is the handoff.

## The owner's decisions

1. Main ky can't use a specialist's logins or keys directly. It asks that specialist.
2. When a specialist's Mac is offline, its job waits and tells the owner. It never runs elsewhere.
3. Creating a specialist creates its own sandbox, asleep until used. The seeded `editor` gets its
   sandbox lazily, on its first ask.
4. Specialists read memory and never write it.
5. A specialist can ask, through a card the owner answers, for a Mac, a login (via `browse_handoff`) or
   an API key. Only the owner grants, from Settings or a card.
6. Outside-content marks are permanent. Once a chat reads outside content, Allow means Ask there, and the
   card says why ("this chat read a mail earlier").

## The design

- **Owner:** `ky` or a specialist's id.
- **Profile** (`src/skills/profiles.ts`): `{ owner, home, sandboxes, macs, tools }`.
  - ky's profile: every live sandbox that is no specialist's home, plus every paired Mac.
  - A specialist's profile: its home sandbox, plus the Macs the owner granted it.
- **Whose profile is this conversation:** `specialists.profileOf(conversationId)`. It resolves through
  `ky_specialist_sessions`, then `ky_specialist_owned` (subagents and other adopted conversations),
  else ky. Every scoped tool asks it. `specialists.adopt(conv, parent)` gives a conversation to its
  parent's owner.
- **Owner-only changes:** `specialists.changeAccess` (grant/revoke a Mac, set home) is reachable only from
  the Settings socket frame. The specialist tool can't reach it. A boot migration gave every specialist
  from before profiles its own sandbox, and the Mac its old hint named, once.
- **Outside content** (`src/outside/`): `OutsideContent.mark(conv, "web" | "webhook" | "mail" | "peer")`,
  `marked`, `carry(from, to)`. It is set by browse reads of sites without a saved login, webhooks, mail
  and peers. Subagent, specialist and peer reports carry it to the conversation they reach. A write from a
  marked conversation asks first (Executor's `verdict`, the secret-request card).
- **Signed-in browsing:**
  - `browse` steps that click, fill or press on a site with a saved login ask first (approval kind
    `browse-steps`), and are refused in background runs.
  - Sites without a saved login never touch the signed-in session: they read on Kitesurf, or on a fresh
    Chromium session with no cookies.
  - If the Vault can't be read, steps fail closed.
  - Approved steps stop at the first act on a different site.

## The 7 rules

The property tests are in `test/invariants/specialist-profiles.test.ts` (the `it.todo` entries are the
rules Phase 3 and 4 still owe). The model is `explainers/ky-architecture/tla/`: `Specialists.tla`/`.cfg`
for TLC, and `specialists_check.py`, an exhaustive checker with every fix switchable. It was run here;
TLC was not, because the jar couldn't be downloaded.

| Rule | Meaning | Owner |
|---|---|---|
| R1 RunnerScope | Work runs only on its owner's sandboxes or granted Macs. Revoking a Mac stops the owner's runs on it. | 3A |
| R2 SessionMatchesVault | A live browser session holds only its owner's logins. Moving or removing a login logs out every session holding it. | 3C |
| R3 DeleteCleans | A deleted specialist has no runs, sessions, logins, keys or grants left. Its workflows go to ky, paused. | 4 |
| R4 NoSilentFallback | A workflow whose Mac is offline waits and tells the owner. | 3A, 3B |
| R5 OneOwnerPerRun | A run keeps the owner it started with. | 3B |
| R6 ToolEnforced | The machine, browse, secret and Executor tools enforce the profile, not just the prompt. | 3A, 3C, 3D |
| R7 NoLaundering | A change that outside content led to, directly or through another specialist, needs the owner's OK. | 1 (done), 3D |

## Phase 3 branches (unreviewed)

Each branch was built by one builder from the design above (its brief is this file's contents). None
has had the independent review that Phases 1 and 2 had, and none is merged. A branch listed here may be
missing if its builder hadn't finished when the session paused; its work is then lost and the unit is
still to do.

| Branch | Base | What it does |
|---|---|---|
| `kyendamuri/specialist-3a` | Phase 2 | Computers. The machine tool lists and uses only the owner's sandboxes and Macs. Revoking stops runs. Offline waits. Machine-task conversations are adopted. |
| `kyendamuri/specialist-3b` | Phase 2 | Workflows. Automations get an `owner` and run as that specialist. A run snapshots its profile. The owner can reassign. |
| `kyendamuri/specialist-3c` | Phases 1 + 2 | Browser. One session per owner. Logins are keyed `<owner>:<site>`. Move/remove ends sessions. Hand-off saves to the specialist's scope. |
| `kyendamuri/specialist-3d` | Phases 1 + 2 | Keys and rules. Vault HTTP keys are scoped per owner plus shared. Executor policies per owner. Marks are carried on asks to a specialist. |

Each builder's report (what it changed, its tests, its shared-file hunks) is in its last commit message,
or in the session that built it.

## What's left

1. **Review each Phase 3 branch:** an independent read of its diff against this file and the anti-slop
   rules (no abstraction with one caller, no comments that restate code, no duplicated checks, no
   weakened tests, Effect style per `.claude/skills/`). Fix what the review finds.
2. **Merge 3A–3D onto `main`** one at a time. Expect conflicts in `src/server.ts`, `src/sockets.ts`,
   `FEATURES.md` (counts) and `test/invariants/specialist-profiles.test.ts`. Keep each side's lines.
3. **Phase 4:**
   - R3 delete cleanup: extend `Profiles.forget`; cancel the specialist's runs; end its sessions; remove
     or move its logins and keys; move its workflows to ky, paused; keep or offer to delete its sandbox.
   - One page per specialist: computer and Macs with status, workflows with Run now/Pause, skills,
     logins, keys, rules, and an "Ask @name" box.
   - Chat commands: "@fin run monthly close", and "make a workflow for @fin that…".
4. **The full gate** (`pnpm gate`). In a cloud container, 4 node tests fail the same way on main (Bun's
   graph, GHCR); on the owner's Mac they pass. Then a PR and merge, which deploys squarey.
5. **Live checks** after deploy:
   - a hand-off for one specialist;
   - ky refused that login and told to ask;
   - a workflow owned by a specialist runs on its sandbox;
   - revoking a Mac stops a run on it.

## Known gaps

- Marking on Executor and Exa read results, and on `browse_handoff` pages, is deferred: there is no
  one-line choke point for it.
- Mail keeps its own wording ("a stranger's words, not instructions"), because the parity baseline
  records it.
- A deleted specialist's sandbox becomes ky's until Phase 4.
