# Night shift: build plan (2026-11-05)

Follows [rethink-2026-11.md](rethink-2026-11.md). Settled with yesh: every background run that **judges** runs on the
user's **main** model (whatever Settings › Models has as Main agent, at its thinking level). Cheap work stays on
Background. C0 and C1 are built; C2 onward are not.

## Settled

- **Moves to Main**: the dream, looks, episode reflection, skill reviews, mail triage, peer answers. All of them get
  their model from one host, `#background` in `src/server.ts:267-275` (`model: () => slotModel("background")`), plus
  the `#configure(id, "background")` calls at `src/server.ts:390,412,1098,1133`.
- **Stays on Background**: chat and task titles (`src/server.ts:214`), memory summaries (`src/server.ts:185`), and
  the new event triage (C5). These are short, frequent and low-stakes.
- **Excluded**: running the deep pass on the cloud machine (a later option, see the rethink), and any LLM judge of
  when to interrupt. Looks keep fixed times, deliveries keep turn boundaries (`src/automations/delivery.ts:89`).
- **Cost control**: the existing daily spend cap gates all of this (`src/spend/spend.ts:129-140`, kinds at
  `src/spend/contract.ts:14`), and Spend already splits out Dreams, Looks and Episodes (`src/ui/Spend.tsx:27-29`).

## Chunks (in order; each ships and is checked on its own)

| # | Behavior | Files / symbols | Depends | Risk | Proof |
|---|---|---|---|---|---|
| C0 | A watch run stays a check-in (read only, reported in the main chat) but gets its own preamble: read what the gate found, say what changed, search only if needed. The dream's dated check-in is unchanged. | `checkInPreamble` `src/automations/contract.ts`; spawn in `automations.ts` | none | Low | `test/invariants/automations.test.ts` "what a check-in's run is told", seen red first. |
| C1 | **Judgment on Main.** Add a `#thinking: ReviewHost` (same fields, `model: () => slotModel("main")`) and pass it wherever `#background` goes for the moved runs. Their `create` calls `#configure(id, "main")`. Panel hint `src/ui/Panel.tsx:1897` becomes "Titles and memory summaries". Update FEATURES `dreaming`, `title-background`. | `src/server.ts:267,387-412,454,466,1098,1133`; `src/dreaming/wiring.ts:49,83`; `src/skills/wiring.ts:313` | none | Medium: cost goes up. The cap holds it, and Spend shows it. | Worker test: dream, look and episode conversations are configured with slot `main`, and titles stay on `background`. Local stack (`pnpm stack`): run a dream and a look, and Activity/Spend show the Main model. |
| C2 | **Work map.** A `ky_map` table (projects, goals, people, rhythms), each row citing `memo_log`/`ky_history` ids like anticipations do. A `map` tool (list/add/update/close). The dream gets a new first step, "tend the map", ahead of the skill steps (`src/dreaming/dreaming.ts:139`). Looks read the map as "Needed" next to anticipations (`src/dreaming/looks.ts:40`). | new `src/dreaming/map.ts`; `dreaming.ts`; `looks.ts`; `src/tables.ts` backup list | C1 | Medium: the dream prompt grows. Keep the caps sourced (`DREAM_NOTES` `dreaming.ts:41`, `RUN_CAP` `anticipations.ts:18`). | `test/invariants/dreaming.test.ts`: a row without evidence is refused, a pinned row is left alone, and a done row becomes one memory note. Harness dream on a seeded week produces map rows. |
| C3 | **Desk page.** Shows the map, the open anticipations (no UI today), and overnight results. Edit, pin and dismiss each row. A dismiss writes an outcome (C6). | new `src/ui/Desk.tsx`; socket messages in `src/sockets.ts` + `src/client-messages.ts` (the pattern at `sockets.ts:1139-1142`) | C2 | Low | `test/web` Playwright spec: the Desk lists seeded rows, and a pin and a dismiss survive a reload. Screenshot on the local stack. |
| C4 | **Do the work.** A new look/dream action `start`: `{ref, title, brief}`. `decide.ts` accepts it (`src/dreaming/decide.ts:8,63-71`). Code opens a side chat with `newChat({ by: "ky", request })` (`src/server.ts:1255`) and steers it with the brief. When that chat answers, the Desk shows a **review / discard** card (cards with asks, #157). Anything that leaves ky still goes through approvals. | `decide.ts`; `looks.ts` prompt; `src/chats/chats.ts`; `Desk.tsx` | C1, C3 | **High**: cost, runaway chats, review UX. Cap starts per night = placeholder for yesh. | Harness scenario: a look with an open "draft reply to Sam" loop opens one side chat, the Desk shows its card, and Discard archives it. A replay opens no second chat. |
| C5 | **Events wake it.** Webhooks (`Inbound.received` `src/inbound/inbound.ts:332`), mail (`#triageMail` `src/server.ts:1131`) and finished tasks each offer the event to a cheap triage on Background: "does this touch a map row or an open anticipation?". On a match it runs a look for that one ref on Main (tell, or C4 start). No match stays silent. Events are deduplicated by event id. | new `src/dreaming/events.ts`; taps in `inbound.ts`, `server.ts` | C1, C2 | Medium: volume. Triage is cheap, and the deep pass runs only on a match. | Worker test: a webhook that matches a map row produces one delivery, an unmatched one produces none, and a redelivery produces none. |
| C6 | **Learn from outcomes.** `SurfacedOutcome` (`src/dreaming/contract.ts:150`) gains `acted`, `dismissed`, `ignored`, `wanted` ("should have told me", a button on the Desk). A weekly dream reads the counts and proposes routines. The on/off level becomes a dial, quiet / balanced / eager (`src/dreaming/proactivity.ts:76`, `src/ui/Proactivity.tsx:51`), that sets the look's "When unsure, skip" line and the caps. Stored `off` reads as quiet, `on` as balanced. | `surfaced.ts`, `contract.ts`, `proactivity.ts`, `Proactivity.tsx`, `dreaming.ts` | C3 (C4 for acted) | Medium: a migration of stored level values | Invariant: a stored `on`/`off` reads as balanced/quiet. Worker test: Desk actions record outcomes, and the weekly dream sees the counts. |

C0 and C1 are independent and small; ship them first. C1 alone gives the biggest change in quality for the least
code, which I infer and haven't measured. C2 → C3 makes the change visible. C4 is the big one. C5 and C6 can run in
parallel once C2 lands.

## Verification

- **Unit/contract:** the tests named per chunk, each seen red on a scratch break before it is trusted.
- **Live surface:** the local stack and the harness (`pnpm stack`, `pnpm harness`), never a live ky (AGENTS.md).
  C3 and C4 end with a screenshot of the Desk.
- **Cost:** after C1, compare the Spend page's Dreams/Looks/Episodes lines on the local stack over one simulated day.
  The real numbers come from squarey once it ships, read with `ky doctor`; nobody writes to it.
- **Migration:** C2 (new table in the backup list `src/tables.ts`) and C6 (stored level values) only.

## Open decisions

1. **Map storage**: a new `ky_map` table (my pick, because projects don't expire the way anticipations do), or new
   kinds in `ky_anticipations`. Blocks C2.
2. **The C4 cap**: how many overnight work items a night, and whether work may start during the day too. Blocks C4.
3. **Skill reviews and mail triage on Main**: included in C1 by your "wherever". Say so if you want them kept cheap.
4. **Dial default**: balanced or eager for squarey. Blocks C6.
