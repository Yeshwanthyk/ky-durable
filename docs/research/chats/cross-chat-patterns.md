# Cross-chat messaging: patterns from other agent systems, and what ky should take

Researched 2026-11-05, for ky's chats tool (`src/chats/tool.ts`) after branch `chats-reach-any-chat`
let every chat list and read every chat, and send to a chat it didn't open in a turn the user started.

## Answer

The systems closest to ky (Claude Code's cross-session messaging, OpenClaw's session tools) converge on
five things ky lacks or does differently. In order of what would have prevented the "No chat that this
chat opened" episode, then what makes cross-chat work pleasant:

1. **Address by name, not id; let the user point.** Claude Code delivers on a session's name when one
   session answers to it, adds an identifier only on ambiguity, and lets the user `@`-mention a session
   in the prompt so Claude needn't list first. ky's tool takes only a numeric id, so the model has to
   inspect, match a title, and copy an id: the step where it went wrong.
2. **Tell me when it's done.** Claude Code's `notify_when_idle` sends the asker one notice when the
   other session next goes idle; OpenClaw's `sessions_send` can wait inline (`timeoutSeconds`) or
   register a watcher (`watch: true`). ky's tool says answers "do not come back to you … inspect later
   when the user asks", so a cross-chat question has no closing loop.
3. **Loops are throttled at the receiver, not forbidden at the sender.** Claude Code rate-limits
   repeats per sender, drops identical repeats in a short window, and caps the queue at 50, "so a
   message loop between two sessions stops on its own". OpenClaw's older docs allowed a bounded
   reply exchange (`maxPingPongTurns`, default 5, `REPLY_SKIP` to stop). ky forbids replies outright
   (a chat-started turn sends only to its own children). That is safe but means two chats can never
   have even one round of question and answer.
4. **Provenance is explicit and carries no authority.** Both mark inter-session messages as not the
   user's and strip consent: Claude Code's receiver "can't approve anything", "can't change
   configuration", and commands in the text don't run; OpenClaw wraps them as
   `[Inter-session message ... isUser=false]`. **ky already does this**: the `[chat "…"]` header renders
   as a "From" line, recall/dreams treat it as a notice, and `userHere` (src/server.ts) gives a
   chat-started turn no approvals. Keep it.
5. **Reading another session is richer than "latest message".** OpenClaw's `sessions_history` pages
   the transcript (limit/offset, tool results opt-in, long blocks cut at 4,000 chars); its
   `sessions_list` filters by search, label, archived, active-only, and pages. ky's inspect returns one
   message and its list is the newest 50 with no filter.

## Sources and what each establishes

| Claim | Source | Status |
|---|---|---|
| Claude Code: `ListAgents` discovers, `SendMessage` sends; delivery on the name alone when one session answers to it, identifier added when several share it | [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md), read 2026-11-05 | checked (primary doc) |
| Claude Code: user `@`-mentions a session in the prompt; Claude Code tells Claude which session it names so it can send without listing; ambiguous mention → Claude asks the user | same | checked |
| Claude Code: `notify_when_idle` sends one notice when the watched session goes idle or exits; dropped after 12 h; subscribing starts no turn in the watched session | same | checked |
| Claude Code: receiver rate-limits per sender, drops identical repeats in a short window, queues at most 50; "a message loop between two sessions therefore stops on its own" | same, Limitations | checked |
| Claude Code: an incoming message can't approve, can't change config, commands don't run, permission prompts still fire | same, "How a session treats an incoming message"; also [Agent teams › Messages between agents](https://code.claude.com/docs/en/agent-teams.md) | checked |
| Claude Code: receiving session can `accept` / `hold` / `refuse` inbound messages | same, Control inbound messages | checked |
| Claude Code agent teams: members discover each other from a team config `members` array; address by name; idle notification carries the teammate's final answer to the lead; no nested teams | [Agent teams](https://code.claude.com/docs/en/agent-teams.md) | checked |
| OpenClaw: `sessions_list` (filters: label, search, archived, activeOnly, kinds; limit 100, paging), `sessions_history` (paged, tool results opt-in, 4,000-char blocks), `sessions_send` (`timeoutSeconds: 0` fire-and-forget, `mode` followup/steer/notify/resume, `watch`) | [OpenClaw session tool](https://docs.openclaw.ai/concepts/session-tool.md), current page | checked |
| OpenClaw: visibility scopes `self` / `tree` / `agent` / `all` (default `all`); sandboxed caller clamped to its spawn subtree; `expectedSessionId` stops a stale key hitting a replacement | same | checked |
| OpenClaw: inter-session messages marked `isUser=false`, to be treated "as tool-routed data, not as a direct end-user-authored instruction" | same | checked |
| OpenClaw: `maxPingPongTurns` bounded reply exchange, `REPLY_SKIP` | [older doc mirror](https://huggingface.co/spaces/nikhtu10/OpenClawBot/blob/main/docs/concepts/session-tool.md) (range 0–5) vs [docs2](https://docs2.openclaw.ai/concepts/session-tool) (0–20, per search summary) | documented only; absent from the current page, so may be removed |
| A2A: tasks grouped by `contextId`; states include `input-required` and `auth-required` ("interrupted") besides working/completed | [A2A spec 1.0.0](https://a2a-protocol.org/latest/specification/) §4.1 | checked |
| Codex CLI multi-agent v2: `list_agents` (path, role, status), `send_message` with `reply_to`, path addressing `/root/a/b` | [community write-up](https://codex.danielvaughan.com/2026/04/11/codex-cli-multi-agent-v2-path-addressing) | unverified (no official doc found) |
| General: layered loop defenses (hop/turn cap, A→B→A detection, mention gating, cost budget) | [practitioner guide](https://coderlegion.com/13147/preventing-infinite-loops-in-multi-agent-ai-systems-a-developers-guide), [dev.to](https://dev.to/crabtalk/when-agents-share-a-channel-3dj2) | inferred consensus, not authoritative |

## What ky should change, ranked

| # | Change | Pattern from | Cost | Why |
|---|---|---|---|---|
| 1 | `chat` accepts a title as well as an id: one match sends, several return the candidates with ids, none returns the list | Claude Code name addressing | small, tool only | Removes the id-copying step the model fumbled. |
| 2 | `@` in the composer also offers chats (it already offers specialists); the turn gets "the user means chat 10548 \"Reading\"" | Claude Code `@`-mention | small–medium, `src/ui/Composer.tsx` + turn context | The user can point at the target; no lookup at all. |
| 3 | `steer` takes `notify: true`: when the target's turn ends, the sender gets one `[chat "Reading" finished] <first lines>` notice, starting a turn there if idle | Claude Code `notify_when_idle`, OpenClaw `watch` | medium: a one-shot subscription row keyed by request id, fired on turn end | Closes the loop: "ask Reading X" ends with the answer in the chat you asked from. |
| 4 | Let a notice's turn reply once: a hop count travels in the request id (`chat-steer:<from>:<task>:<hop>`), and sends from a turn at hop ≥ 1 are refused | OpenClaw bounded ping-pong; hop-limit consensus | medium | One question and answer between chats, still finite. Pairs with #3. |
| 5 | Receiver backstop: drop an identical message from the same sender within a short window, and cap chat-sent messages per chat per hour | Claude Code receiver throttle | small | Cheap insurance if #4 or a bug ever lets a loop through. ky's gating already prevents loops by construction; this guards the gating. |
| 6 | `inspect` with a chat returns the last few exchanges (user and ky, tool calls left out, cut per message), and says "waiting for the user" when a card or approval is pending | OpenClaw `sessions_history`; A2A `input-required` | small | One message is often not enough to answer "how is it going?" |
| 7 | `inspect` with no chat takes `query` (title match) and `archived` | OpenClaw `sessions_list` filters | small | Past 50 chats, the list stops finding older ones. |

Keep as is: provenance header and notice treatment (pattern 4), and the rule that a chat another chat
opened sends nothing (Claude Code: "no nested teams").

## Open questions

- Whether #4's single reply is worth it, or #3's notice alone (no turn in the sender, just a line) is
  enough. Claude Code's notice does start a turn in an idle asker.
- Whether a notice from #3 should count as a "turn the user started" for further sends. It shouldn't
  (that reopens loops); the hop count in #4 is the explicit way to allow one reply.
- OpenClaw's `maxPingPongTurns` is missing from its current session-tool page; unclear if it was removed
  or moved.
- Codex's multi-agent v2 tool surface is known only from community write-ups.
