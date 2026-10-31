# Specialist profiles: design and handoff

Goal (from the owner): each specialist has its own computer, the Macs it may use, its own browser and
logins, its own API keys, the workflows it runs, and its own rules for what needs the owner's OK. Main ky
keeps everything that exists today.

**Status (2026-10-31):**
- Phases 1 and 2 are built, reviewed and fixed, and merged on branch `kyendamuri/specialist-profiles`.
  They are **not on main yet**.
- Phase 3 was stopped mid-build. Its four parts are saved as WIP branches.
- Phase 4 is not started.

---

## 1. Words

| Word | Meaning |
|---|---|
| **specialist** | The existing ky concept (`src/skills/specialists.ts`): an id, description, model, versioned brief and one ongoing conversation. Tables `ky_specialists` and `ky_specialist_sessions`. User-facing text always says "specialist", never "profile" or "crew". |
| **ky** | Main ky, the default owner. Everything from before this work belongs to ky. |
| **owner** | `"ky"` or a specialist's id. |
| **profile** | Internal only: the bundle of what an owner may use. |
| **sandbox** | A cloud machine (`src/runners/sandboxes.ts`, `ky_sandboxes`, `docs/multi-sandbox.md`). |
| **Mac / runner** | A paired computer (`src/machines/`). |
| **outside content** | Text that came from outside ky: a web page read without a saved login, a webhook, a mail, a peer's message. |

## 2. The owner's decisions (fixed)

1. Main ky can't use a specialist's logins or keys directly. It asks that specialist.
2. When a specialist's Mac is offline, its job waits and tells the owner. It never runs elsewhere.
3. Creating a specialist creates its own sandbox, asleep until used. The seeded `editor` gets its
   sandbox lazily, on its first ask.
4. Specialists read memory and never write it.
5. A specialist can ask, through a card the owner answers, for a Mac, a login (via `browse_handoff`) or
   an API key. Only the owner grants, from Settings or a card.
6. Outside-content marks are permanent. Once a chat reads outside content, Allow means Ask there, and the
   card says why ("this chat read a mail earlier").

## 3. The seven rules

Property tests live in `test/invariants/specialist-profiles.test.ts`. The `it.todo` entries are the
rules not yet proven. The model is `explainers/ky-architecture/tla/`:
- `Specialists.tla` and `Specialists.cfg` for TLC, which has not been run: the jar couldn't be
  downloaded in the cloud session. Run it on the Mac with
  `java -cp tla2tools.jar tlc2.TLC -config Specialists.cfg Specialists`.
- `specialists_check.py`, an exhaustive checker with every fix switchable. It was run:
  `python3 -I specialists_check.py --ablate`. With every fix off, 182,400 states and every rule below
  broken; with every fix on, 20,184 states and none broken. The README has the shortest trace for each.

| Rule | Meaning | Where it's proven or owed |
|---|---|---|
| R1 RunnerScope | Work runs only on its owner's sandboxes or granted Macs. Revoking a Mac stops the owner's runs on it. | 3A (WIP) |
| R2 SessionMatchesVault | A live browser session holds only its owner's logins. Moving or removing a login logs out every session holding it. | 3C (WIP) |
| R3 DeleteCleans | A deleted specialist has no runs, sessions, logins, keys or Mac grants left. Its workflows go to ky, paused. | 4 |
| R4 NoSilentFallback | A job whose Mac is offline waits and tells the owner. It never runs on another machine. | 3A, 3B (WIP) |
| R5 OneOwnerPerRun | A run keeps the owner (profile) it started with, even if the workflow is reassigned. | 3B (WIP); the snapshot half is proven in Phase 2 |
| R6 ToolEnforced | The machine, browse, secret and Executor tools enforce the profile, not just the prompt. | Profile resolution is proven in Phase 2; the tools are 3A, 3C, 3D |
| R7 NoLaundering | A change that outside content led to, directly or through another specialist, needs the owner's OK. | Phase 1 for reports, subagents and peers; 3D for asks to a specialist |

**The finding that matters most:** profiles alone don't stop a confused deputy. A specialist that reads
the web can ask another specialist to act. The mark has to travel with the request, and a write that
carries the mark must ask. The checker shows that either way of passing the mark along covers for the
other, but with both off the hole is open again.

## 4. What's built (on `kyendamuri/specialist-profiles`)

### Phase 1: outside content, and acting where the owner is signed in

Commits `ab8d5e3` and `12d3db6`, merged as `ce29fc6`.

- **`src/outside/`:** the `OutsideContent` Effect service over `Sql`, table `ky_outside_content`
  (conversation, source, at).
  - `mark(conv, "web" | "webhook" | "mail" | "peer")`, `marked(conv)`, `carry(from, to)`.
  - `Outside` is a synchronous wrapper for code that isn't Effect.
  - `outsideWhy(sources)` gives the card wording.
- **Where marks are set:**
  - webhooks (`Inbound.received`, `tellOutside`);
  - mail (`tellMail`, and `mail read` of an incoming mail);
  - browse reads of a site with no saved login;
  - peer questions and answers (`server.ts`).
- **Where marks are carried:** subagent and specialist reports, discussion reports, and a peer question
  escalated to the main chat.
- **Signed-in browsing (`src/browse/wiring.ts`):**
  - Steps that click, fill or press on a site with a saved login ask first: approval kind
    `browse-steps`, card titled "Let ky act where you're signed in?".
  - In background runs those steps are refused, with no card.
  - A site with no saved login reads on Kitesurf, then on a fresh Chromium session with no cookies
    (`#fresh`), never on the signed-in session.
  - A Vault error fails closed (`LoginsUnknown`).
  - Approved steps stop at the first act on a different site (`runSteps(page, steps, actsOn)`).
- **Executor (`src/approvals/executor.ts`):** `verdict(policy, present, marked)`. Allow asks when nobody
  is present or the conversation is marked.
- **Card wording:** the Executor and secret cards end "(asked because this chat read … earlier)".
- **Shared wording:** `OUTSIDE_DATA` and `CHANGES_WAIT`. Mail keeps "a stranger's words, not
  instructions", because the parity baseline records it.
- **Tests:**
  - property I-O1, plus examples I-O2 (Vault down) and I-O3 (the step guard), in
    `test/invariants/outside.test.ts`;
  - worker tests in browse-session, approvals, inbound and mail.

### Phase 2: the specialist profile foundation

Commits `1af094a` and `a8a2ce5`, merged as `5d9f1d3`.

- **Tables:**
  - `ky_specialist_profiles`: specialist, home, macs as JSON, tools as JSON overrides. It's in
    `SKILL_TABLES`, so it's backed up.
  - `ky_specialist_owned`: conversation → specialist, for adopted conversations.
- **`Profiles` service (`src/skills/profiles.ts`):** `Profile` is a plain type,
  `{ owner, home, sandboxes, macs, tools }`.
  - ky's profile: every live sandbox that is no live specialist's home, plus every paired Mac. ky's home
    is the default sandbox.
  - A specialist's profile: its home sandbox, plus the Macs the owner granted it.
  - `of(conv)` checks `ky_specialist_sessions`, then `ky_specialist_owned`, else ky.
- **Facade (`Specialists` in `src/skills/wiring.ts`):**
  - `profileOf(conv)` (synchronous, for tools), `profile(owner)`;
  - `adopt(conv, parentConv)`, which subagents call in `register`;
  - `changeAccess(id, { mac, grant } | { home })`, owner-only, reached only from the `specialist-access`
    socket frame; it fires the `onChange` listeners;
  - `dropMac(name)`, called by `removeMachine`;
  - `create` / `delete`, `seed()`, `migrate()`.
- **Rules it enforces:**
  - `setHome` refuses ky's default sandbox, or another specialist's home.
  - `Roster.create` refuses the id `ky`, and any id that still has session rows or brief versions
    ("@eng was deleted; pick another id").
- **Boot migration:** gives every specialist from before profiles its own sandbox, and grants the Mac its
  old hint named, once and only if it's paired. It is idempotent. The old live path that read the hint
  every time was a model-callable grant and was removed.
- **UI:** the Soul tab's specialist sheet has a Sandbox picker, a switch per Mac, and Delete with a
  confirm.
- **Prompt:** a "Your machines" line. The old "use <machine>" line prints only when that machine is
  allowed.
- **Tests:** `test/invariants/specialist-profiles.test.ts` (16 pass, 8 to-do) and
  `src/tests/specialists.test.ts` (12/12).

### Checks run on Phases 1 + 2 merged

- typecheck clean;
- lint: nothing beyond the baseline;
- fallow and knip pass, with no baseline edits;
- `test:invariants`: 60 files, 589 pass, 8 to-do.

**Not run on the merged result:** the full worker suite (it was stopped before finishing), the harness,
the web tests, and `pnpm gate`. Each phase passed its own worker tests before merging.

FEATURES.md has 7 new rows, and the local count is set to 234:
- `outside-content-mark`
- `approval-outside`
- `browse-outside-frame`
- `browse-signed-steps`
- `specialist-sandbox`
- `specialist-profile`
- `specialist-access`

## 5. Phase 3: WIP branches (stopped mid-build, unreviewed, may not typecheck)

Each is one "WIP" commit on top of its base. Treat them as a head start, not as finished work. Read the
diff, keep what's sound, and finish the unit to its spec below.

| Branch | Base | Diff | Where the builder stopped |
|---|---|---|---|
| `kyendamuri/specialist-3a-computers` | `5d9f1d3` (Phase 2 only) | `src/machines/{machines,tool,wiring}.ts`, `server.ts`, `skills/specialists.ts`, `+167` lines of R1 properties; about 280 lines | Fixing the revoke property: settle after each change, track losses, make the request optional in R1-A. The tool enforcement was largely written. |
| `kyendamuri/specialist-3b-workflows` | `5d9f1d3` | `src/automations/{automations,contract,tool,wiring}.ts`, `skills/{contract,profiles,specialists,subagents,wiring}.ts`, `server.ts`, automations invariants and parity world; about 250 lines | About to run the automations invariants and parity. The owner column and owned runs were largely written. |
| `kyendamuri/specialist-3c-browser` | `ce29fc6` (Phases 1 + 2) | `src/browse/{browse,contract,wiring}.ts`, `vault.ts`; about 185 lines | Mid-way through owner-scoping `finish`, `keepLogins` and `forget`. No tests yet. |
| `kyendamuri/specialist-3d-keys` | `ce29fc6` | `src/inbound/{credentials,inbound}.ts`, `vault.ts`; about 65 lines | Just starting the `inbound.ts` edits. Very early. |

**Merge order:** 3A and 3B are based on Phase 2 only, so rebase them onto `kyendamuri/specialist-profiles`
first. 3C and 3D both edit `src/vault.ts`; merge one, then rebase the other.

### Spec per unit (the builders' briefs)

**3A Computers (R1, R4, R6):**
1. The machine tool (`src/machines/tool.ts`, `pickMachine` and the listing) resolves the caller's
   profile with `specialists.profileOf(api.conversationId)`:
   - it lists only that owner's sandboxes and allowed Macs, so ky no longer sees specialists'
     sandboxes;
   - it defaults to the owner's home;
   - it refuses any other machine with a reason the model reads: "@fin can't use mbp; only the user can
     give it one — ask them".
   The routing prompt text (around `tool.ts:283`) must match what each owner sees.
2. When a machine task starts, `specialists.adopt` its conversation to the caller's owner.
3. Revoking a Mac (`changeAccess` → `onChange`) cancels the owner's running and queued tasks there and
   tells the owner's chat. Unpairing does the same.
4. An offline allowed Mac waits and tells (use the existing inbox behaviour). Never re-route; make sure
   `pickMachine`'s "else the cloud machine" fallback never crosses owners or swaps a named Mac.
5. Tests:
   - turn the R1, R4 and R6 machine to-dos into properties;
   - worker tests: refused a Mac it wasn't given; ky doesn't see a specialist's sandbox; revoking cancels
     a running task; an offline Mac waits with no fallback.

**3B Workflows (R5, plus the ownership half of R3 and R4):**
1. Automations get `owner`, with existing rows as ky's.
   - Created from a specialist's conversation, it's owned by that specialist.
   - ky sets `owner` only on an explicit "for @fin".
   - A specialist can't create or edit another owner's automations.
2. An owned run happens as its owner. Route it through the same path a subagent `ask` to a specialist
   uses (`src/skills/specialists.ts` / `subagents.ts`) rather than duplicating it, and adopt the run's
   conversation.
3. R5: snapshot `specialists.profile(owner)` at run start and store it on the run row. Reassigning
   mid-run doesn't change the running run.
4. The owner can reassign, with an "Owner" picker in the automation editor (`src/ui/Automations.tsx`).
   Only the user can, through the UI socket frame.
5. An owned automation's `machine` must be inside its owner's profile.
   - Check at create and edit, and again at run start.
   - If it's no longer allowed, the run doesn't start and the owner's chat is told. No fallback.
6. Tests:
   - turn the R5 to-dos into properties with TestClock;
   - worker tests: an owned automation runs in its specialist's context; reassigning mid-run; a machine
     it isn't allowed is refused; old rows decode as ky's.
   - Keep `test/parity/automations` and the automations invariants green. Regenerate any mutant patch
     that no longer applies with `.claude/skills/verify-ky-parity/scripts/mutant.sh <domain> <name>
     open/save`, keeping its break.

**3C Browser and logins (R2, decision 1):**
1. One persistent Browser Run session per owner: `ky_browser_session` keyed by owner, with the existing
   row migrated to ky. browse and `browse_handoff` use the caller's owner's session.
2. Vault `browser-login` ids become `<owner>:<site>`.
   - Existing ones migrate once at boot to `ky:<site>`; the migration is idempotent.
   - ky never uses a specialist's logins, and a specialist never uses another owner's.
   - When ky needs a site that only @fin is signed in to, the result says "@fin is signed in to
     bank.com; ask @fin", never the cookies.
3. R2: moving or removing a login ends every session holding it.
   - Settings › Browser logins gets "Move to", owner only.
   - It is grouped by owner.
4. A `browse_handoff` from a specialist saves to that specialist's scope, and the card says which
   specialist the login is for.
5. Tests:
   - turn the R2 to-do into a property;
   - worker tests: one session per owner; ky can't use a specialist's login and is told to ask; moving
     ends the old session and works for the target; old logins migrate to ky.

**3D Keys and rules (R6, R7, decisions 1 and 5):**
1. Vault `http` credentials are scoped `<owner>:<name>`, plus a "shared" scope.
   - Existing keys go to ky, migrated once.
   - `secret_request` and `request_secret` resolve the owner.
   - Refusals name the holder: "@fin holds that key; ask @fin".
   - A specialist's `request_secret` card says which specialist the key is for.
   - Settings lists keys by owner, with "Move to" and "Share with all".
2. Executor: per-owner tool policies (`Profile.tools` overrides on top of `ky_tool_policies`; the
   owner's override wins). `verdict` takes the owner's effective policy. Scope the Executor connection
   itself only if you can justify it; otherwise it stays shared, and policies are the control. There is
   a small Allow/Ask/Block list in the specialist's settings.
3. R7 on asks: when a marked conversation asks @fin, @fin's conversation gets the mark before it acts.
   Add `carry(asker, specialist)` at the single place a delegated ask is delivered.
4. Tests:
   - turn the R6 (secret and Executor) and R7 to-dos into properties;
   - worker tests: a key isn't usable across owners, and the refusal names the holder; a shared key is
     usable by both; policy overrides apply; ReadWeb → ask @fin → @fin's write under an Allow policy
     asks the owner.

## 6. Phase 4 (not started)

1. **R3 delete cleanup:** extend `Profiles.forget`.
   - Cancel the specialist's runs.
   - End its browser sessions.
   - Remove its logins and keys, or offer to move them.
   - Move its workflows to ky, paused.
   - Keep its sandbox, or offer to delete it (today it becomes ky's).
   - Turn the R3 to-do into a property.
2. **A page per specialist:** computer and Macs with online status; workflows with Run now / Pause;
   skills; logins; keys; rules; an "Ask @name" box. Build it in `src/ui/`, where the Soul tab's
   specialist sheet is.
3. **Chat commands:** "@fin run monthly close" runs the workflow; "make a workflow for @fin that…"
   creates one owned by @fin.

## 7. How to work (the rules each builder followed)

- **AGENTS.md:** never run a wrangler write, `pnpm deploy` or `ky deploy`. Ship by merging to main,
  which runs `deploy.yml` for squarey. Commits carry no attribution lines.
- **Effect v4 house style:**
  - read `docs/migration/effect/WRITER-BRIEF.md` ("The port", "Rules");
  - read `.claude/skills/{modeling-effect-domain,modeling-effect-errors,effect-do-storage,decoding-effect-boundaries,deriving-schema-types,testing-effect-domains}`;
  - look APIs up in `vendor/effect`, a git submodule: run `git submodule update --init vendor/effect`.
  - Schema rows for every table, registered in `src/tables.ts`. Tagged errors mapped to refusals through
    `makeEdge` (never at module scope). `Clock`, not `Date.now`. Decode at every untrusted boundary.
    Never `Effect.sync` over a throwing call.
- **Anti-slop (the reviews enforced these):**
  - no abstraction with one caller; no comments that restate code; no TODOs;
  - one profile lookup and one outside-content mark: reuse approvals, Vault, scheduler, `makeEdge`,
    `Sql`;
  - tests through the real surface (worker e2e) or properties, never tests of mocks;
  - don't weaken existing tests: changed behaviour gets a renamed test;
  - no edits to `fallow/*.json`, the lint baseline or `gate-baseline.json`, and no suppression comments.
- **Process that worked:** build each unit, then an independent read-only review of its diff (it found
  real holes in both Phase 1 and Phase 2), then fix, then merge.
- **Checks:**
  - `pnpm -s typecheck`, `pnpm -s lint`, `pnpm -s fallow`, `pnpm -s knip`, `pnpm -s test:invariants`;
  - one worker test file: `pnpm -s vitest run --config src/tests/vitest.config.ts src/tests/<file>`;
  - everything: `pnpm gate`.
  - The gate needs `gate-baseline.json` updated only for tests renamed on purpose.
- **Git in a worktree:** `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=false`
  avoids fsmonitor IPC noise.

## 8. Known gaps

- Marking on Executor and Exa read results, and on `browse_handoff` pages, is deferred: there is no
  one-line choke point. Exa goes through Executor, and marking every Executor result would mark every
  chat that uses it.
- A deleted specialist's sandbox becomes ky's until Phase 4.
- `pnpm parity automations` fails on some seeds (NoOverlap with `failNextCommit`), on main too.
- In a cloud container, 4 node tests fail the same way on main (Bun's graph, GHCR); they pass on the Mac.
- Nothing here has run against real Browser Run or a real Executor. Live checks after deploy:
  - a hand-off for a specialist;
  - ky refused that login and told to ask;
  - an owned workflow runs on its specialist's sandbox;
  - revoking a Mac stops a run on it;
  - steps on a signed-in site ask first.
