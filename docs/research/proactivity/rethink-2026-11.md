# Dreaming and proactivity, rethought (2026-11-05)

Three Haiku scouts (the code today, the October plan against what shipped, outside prior art since October), then
checked against the source here. Labels: **[checked `file:line`]** = read this session. **[inferred]** = reasoned, not run.
**[scout]** = from a scout, not re-read. Nothing was run, and the live ky was not read.

## The answer

ky's proactivity today is a **cautious notifier run by its cheapest model**. Three times a day a small model reads
12k characters of chat, weighs the open anticipations, and most of the time says nothing. When it does speak, it can
only post a line. The dream at night mostly looks after the skill library. ky does not do work for the user while they
are away, and nothing shows the user what ky is tracking on their behalf. So the feature is hard to notice even when
it runs.

The rethink: turn ky from a notifier into a **night shift**. ky keeps a visible map of what the user is working toward.
It does real work against that map with a strong model or the user's own Claude subscription on the cloud machine.
Events wake it as well as the clock. In the morning it hands back finished work to approve, not reminders.

## Why it feels thin: seven causes

1. **The weakest model does the judging.** Dreams, looks and episode reflection all run on the `background`
   purpose (`src/server.ts:272`). That purpose defaults to Workers AI's first model at its lowest thinking level
   (`src/providers/models.ts:334-341`), and Settings labels it "Small and quick is best" (`src/ui/Panel.tsx:1897`)
   [checked]. Title-writing and night-time judgment about the user's life share one cheap model. Unless the owner
   changed Background in Settings, every proactive decision is made by a flash model with thinking off. I could not
   see the owner's setting on squarey (see Open).
2. **It can talk but not act.** The look prompt says "Read only: change nothing anywhere, and create no automation"
   (`src/dreaming/looks.ts:38`) [checked]. Its options are `tell`, `prepare` (a drafted message) and `skip`. The
   dream's tools are skills, memory, anticipations and check-ins (`dreaming.ts:133-157`) [checked]. ky already has
   side chats (`src/chats/tool.ts`), cloud machines with the user's Claude/ChatGPT logins (`src/subscriptions.ts`),
   routines and approvals, but no proactive loop can start any of them.
3. **The dream is mostly a librarian.** Four of its seven steps tend skills, two tend memory, and one adds
   anticipations (`dreaming.ts:139-146`) [checked]. No step asks what the user is trying to get done, what is stuck,
   or what ky could move forward tonight.
4. **The silence rules stack up.** "When unsure, skip" (`looks.ts:60`), 48 hours quiet per ref, 30 days quiet after
   a 👎, at most 3 posts a look, at most 5 new anticipations a night and 3 per episode, episodes only every 6 turns or
   30 minutes, and anticipations only from the user's own lines [scout, caps at `looks.ts:40-44`,
   `anticipations.ts:18-22`, `episodes.ts:13-17`]. Each rule makes sense alone. Together, with a weak model, they
   push almost everything to skip. Nothing counts what ky should have said and didn't: `ky_surfaced` records only
   `expired`/`missed` (`src/dreaming/contract.ts:150`) [scout].
5. **ky's picture of the user is invisible.** Anticipations have no UI (no hit for `anticipat` in `src/ui`), the
   morning brief card was removed in `3a08b780` a day after it shipped, and so were proposals and "while you were
   away" [scout]. The user can't see what ky thinks is coming up, can't correct it, and so doesn't trust or notice it.
6. **Only the clock wakes it.** Looks run at 08:00, 13:00 and 18:00. The dream runs at 04:00 and only if the user
   has been away 2 hours, giving up at 08:00 (`dreaming.ts:24-38`) [scout]. Mail, webhooks (`src/inbound`) and GitHub
   arrive as events, but none of them reach the proactive loop. The only fast path is a watch a look books, polled
   every 15 minutes.
7. **Watch runs got the dated check-in prompt** [checked `src/automations/automations.ts:114`]. A watch runs as a
   check-in on purpose (read only, reported in the main chat: FEATURES `look-watches`), but it was told to "Search the
   web for it in general terms", though what it needs is under "Gate found:". C0 gives it its own preamble.

## Outside: what holds up (scout 3, mostly secondary sources)

- **The morning-card format failed.** ChatGPT Pulse (nightly cards) was reportedly wound down in June 2026, and
  OpenAI moved toward event-triggered scheduled tasks ("when my package arrives"). That rests on one secondary source.
  ky dropped its own brief for similar reasons. A digest of reminders isn't what people want; finished work might be.
- **A good default: say nothing unless there's news.** In OpenClaw's heartbeat, a run with nothing new returns
  `NO_REPLY`, and an empty checklist costs no model call ([docs](https://docs.openclaw.ai/gateway/heartbeat)). ky
  already works this way.
- **Gate on how likely the user is to accept, not on how sure the model is.** PRISM (ICLR 2026,
  [arXiv 2602.01532](https://arxiv.org/html/2602.01532v1)) speaks up when p_accept ≥ C_FA / (C_FA + p_need·C_FN). A
  cheap model decides, and a slow model runs only near the threshold (about 11% of cases). That is two stages, the
  opposite of one cheap model doing everything.
- **Don't build an LLM that judges when to interrupt.** In the Saturation Trap paper
  ([arXiv 2606.04296](https://arxiv.org/abs/2606.04296)), LLM judges reach F1 0.17–0.40 on interruption timing at up to
  90x the cost. Keep fixed rhythms, turn boundaries and events.
- **Split the user-facing agent from the one that edits memory.** Letta's sleep-time agents and Claude's dreaming
  (May 2026) do this, and ky already does. Primary sources were not readable; secondary only.

## The rethink: five moves

| # | Move | What changes | Builds on |
|---|---|---|---|
| 1 | **Strong model at night, cheap model for triage** | A new `deep` purpose for the dream and look decisions: the main model with thinking on, or a task on the cloud machine using the user's Claude subscription (no API cost). The flash model only triages ("anything here worth deep thought?"), PRISM-style. | `models.ts` purposes, `machines/`, `subscriptions.ts`, spend cap |
| 2 | **A map of the user's work, shown to them** | The dream keeps a structured document of active projects, goals, people, rhythms and open loops, each citing its evidence. A "Desk" page shows it next to the open anticipations. The user can edit, pin and kill items, and every edit teaches ky something. | `ky_anticipations`, memory, `LastNight.tsx` undo pattern |
| 3 | **Do the work, not just say it** | A look or dream can **start work**: open a side chat that researches, drafts the reply or writes the fix on a branch on the cloud machine. The result comes back as a card ("Did X overnight: review / discard"). Anything that leaves ky (send, merge, pay) still needs the user's approval. | `chats` tool (side chats), machines, approvals, routine cards with asks (#157) |
| 4 | **Events wake it, not only the clock** | Inbound mail, webhooks, GitHub events and finished tasks go to a cheap triage step that matches them against the map. On a match it either queues work (move 3) or posts at the next turn boundary. Looks stay as a fallback rhythm. | `inbound/`, `mail/`, `delivery.ts` boundary queue, gates |
| 5 | **Count what was missed, not only what was said** | Record `acted / ignored / dismissed / should-have-told-me` for every surfaced item and every piece of overnight work. A weekly deep dream reads the counts and proposes routines (proposals come back, with a dismiss latch). Replace on/off with a quiet ↔ eager dial, and default this owner to eager. | `ky_surfaced`, verdicts, `Proactivity.tsx` |

### What a morning looks like after the change

You open ky at 08:10. The Desk shows **"Overnight: 3 done, 1 needs you"**. In it: the review comments on the deploy
PR, answered on a branch with the tests run (review / discard); the Lisbon flight options for the dates you named,
with a draft reply to Sam (send / edit); the dentist at 15:00, already on the map. The one that needs you: "Two ways to
fix the wrangler types, which one?" Nothing reached your phone overnight except the CI failure on main, which came in
as an event and matched an active project.

## Order (each step is useful on its own)

1. Give watch runs their own check-in preamble (cause 7) and the stale docs the scout found (`docs/architecture.md:104,107`,
   `verify-ky-parity/features/dreaming.md:6`). Small.
2. Move 1: the `deep` purpose plus a cheap triage gate. This is the biggest gain for the least code: the same prompts on
   a better model. Use spend to measure what it costs.
3. Move 2: the Desk, which shows anticipations and the map. With it the user can see the change, and corrections have
   somewhere to go.
4. Move 3: proactive side chats or machine tasks behind approval. This is the hard part (cost, safety, review UX).
5. Moves 4 and 5: route events to triage, then outcome tracking with the weekly deep dream.

## Open

- **Which model is squarey's Background set to?** If it is already a strong model, cause 1 gets weaker and causes 2–5
  carry the explanation. `ky doctor squarey` or Settings › Models shows it.
- **How much night-time spend is the owner OK with?** Move 1 (main model) and move 3 (side chats) cost money unless
  they run on the Claude subscription on the cloud machine.
- **Which kinds of overnight work need approval** (anything sent, merged or paid) and which can just happen (research,
  drafts, branches).
- The outside sources for the Pulse wind-down, Claude dreaming and Letta are secondary; check the primary sources
  before citing them in a design.
